import "./fuzor-source.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { packageRoot } from "./fuzor-source.mjs";
import { createServer as createViteServer } from "vite";

const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const nestedAuth = process.argv.includes("--nested-auth");
const mount = nestedAuth ? "/ops/panel" : "/zelavis";
const origin = `http://127.0.0.1:${port}`, api = `${origin}${mount}/api/v1`;
const data = await mkdtemp(join(tmpdir(), "zelavis-view-platform-"));
const txtFile = join(data, "domain-txt");
const domainHost = `app-${randomBytes(6).toString("hex")}.example.com`;
const token = randomBytes(32).toString("base64url"), password = randomBytes(32).toString("base64url");
const child = spawn(process.execPath, ["scripts/runtime.ts"], { cwd: packageRoot, env: { ...process.env, PORT: String(port), ZELAVIS_TEST_ROOT_PATH: mount, ZELAVIS_TEST_FRONTEND: "fuzor", ZELAVIS_TEST_PROJECT_DOMAIN_TXT: nestedAuth ? "" : txtFile, ZELAVIS_DEV_SERVER: origin, ZELAVIS_UI_DEV_SERVER: "", ZELAVIS_DATA_DIR: data, ZELAVIS_BOOTSTRAP_TOKEN: token, ZELAVIS_GITHUB_MAINTENANCE: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser, dev, domainProxy;
const previousOrigin = process.env.ZELAVIS_DEV_SERVER;
const devMode = process.argv.includes("--dev");
child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-12000); }); child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-12000); });

async function login(page, identifier) {
  await page.getByRole("heading", { name: "Login to Zelavis" }).waitFor();
  await page.getByLabel("Email or username", { exact: true }).fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.waitForURL(url => [`${mount}/`, `${mount}/projects`].includes(url.pathname));
}

async function fillSignup(page, identifier) {
  await page.getByRole("heading", { name: "Create an account", exact: true }).waitFor();
  await page.getByLabel("Email or username", { exact: true }).fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
}

async function screenshot(page, name) {
  if (!process.env.PARITY_SHOTS) return;
  await mkdir(process.env.PARITY_SHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.PARITY_SHOTS, name + ".png"), fullPage: true });
}

async function qualifyServiceWorkspace(page) {
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator("html").evaluate(root => { root.dataset.dashboardTheme = "light"; });
  const nativeCardColor = () => page.evaluate(() => {
    const card = document.createElement("div");
    card.className = "k-card";
    document.body.append(card);
    const color = getComputedStyle(card).backgroundColor;
    card.remove();
    return color;
  });
  const iframe = page.locator('iframe[title="Auth"]');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.locator(viewport.width < 1024 ? ".mobile-content .mobile-workspace > #workspace" : ".main > #workspace").waitFor();
    const frame = await (await iframe.elementHandle()).contentFrame();
    await frame.locator(".zv-card").first().waitFor();
    const workspace = page.locator("#workspace");
    await workspace.waitFor({ state: "visible" });
    // The mobile workspace is visible while its slide is still moving into position.
    await page.waitForFunction(() => {
      const workspace = document.querySelector("#workspace");
      const main = document.querySelector(".main");
      return workspace && main && Math.abs(workspace.getBoundingClientRect().x - main.getBoundingClientRect().x) < 1;
    });
    const { bounds, embedded } = await iframe.evaluate(element => ({
      bounds: element.closest("#workspace").getBoundingClientRect().toJSON(),
      embedded: element.getBoundingClientRect().toJSON(),
    }));
    for (const edge of ["x", "y", "width", "height"]) {
      assert.ok(Math.abs(bounds[edge] - embedded[edge]) < 1, `Auth iframe fills the workspace's ${edge} at ${viewport.width}px: ${JSON.stringify(bounds)} / ${JSON.stringify(embedded)}`);
    }
    assert.ok(await workspace.evaluate(element =>
      getComputedStyle(element).overflow === "clip" && element.clientHeight === element.scrollHeight));
    const frameCardColor = () => frame.locator(".zv-card").first().evaluate(card => getComputedStyle(card).backgroundColor);
    await frame.waitForFunction(() => document.documentElement.dataset.theme === "light");
    assert.equal(await frameCardColor(), await nativeCardColor(), "Auth uses the native light card color");
    await page.locator("html").evaluate(root => { root.dataset.dashboardTheme = "dark"; });
    await frame.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === "dark");
    const dark = await nativeCardColor();
    assert.equal(dark, "rgb(27, 27, 31)");
    assert.equal(await frameCardColor(), dark, "Auth uses the native dark card color");
    await screenshot(page, `auth-workspace-dark-${viewport.width}`);
    await frame.locator("main").evaluate(main => { main.style.minHeight = "1600px"; });
    await page.mouse.move(embedded.x + 12, embedded.y + embedded.height / 2);
    await page.mouse.wheel(0, 600);
    await frame.waitForFunction(() => window.scrollY > 0);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.equal(await workspace.evaluate(element => element.scrollTop), 0);
    await frame.locator("main").evaluate(main => { main.style.minHeight = ""; window.scrollTo(0, 0); });
    await page.locator("html").evaluate(root => { root.dataset.dashboardTheme = "light"; });
    await frame.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === "light");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log("Auth workspace: the frame fills the content area, owns scrolling, and matches native card colors in both themes and widths.");
}

async function qualifyAppAuth(operator, request, errors) {
  const project = "/runtime/projects/view-lab";
  const sibling = "/runtime/projects/view-sibling";
  const policy = project + "/auth/registration/settings";
  const preview = path => request(path).then(({ project }) => {
    assert.equal(project.preview?.status, "ready", JSON.stringify(project.preview ?? project.runtime));
    return `http://127.0.0.1:${project.preview.port}`;
  });
  const site = await preview(project), other = await preview(sibling);
  assert.notEqual(site, other);
  const appRoot = "/zelavis", auth = `${appRoot}/api/v1/auth`;
  const loginUrl = site + appRoot + "/login", signupUrl = site + appRoot + "/sign-up";
  const audience = createHash("sha256").update("view-lab").digest("hex").slice(0, 24);
  const appCookie = `zelavis_app_${audience}`;
  const closed = async (page, url = signupUrl) => {
    assert.equal((await page.goto(url)).status(), 404);
    await page.getByRole("heading", { name: "Registration is closed", exact: true }).waitFor();
    assert.equal(await page.locator("form").count(), 0);
  };
  const toggle = operator.getByRole("checkbox", { name: "Allow public registration" });
  const save = operator.locator("section.k-card").filter({ has: operator.getByRole("heading", { name: "Public registration" }) }).getByRole("button", { name: "Save", exact: true });
  const setEnabled = async enabled => {
    await toggle.setChecked(enabled);
    await save.click();
    await operator.getByText(`Registration ${enabled ? "opened" : "closed"}.`, { exact: true }).waitFor();
    assert.equal((await request(policy)).enabled, enabled);
  };
  await operator.goto(origin + mount + "/projects/view-lab/auth");
  const link = operator.getByRole("link", { name: "Open App login", exact: true });
  assert.equal(await link.getAttribute("href"), loginUrl);
  const opened = operator.waitForEvent("popup");
  await link.click();
  const desktop = await opened;
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    for (const [page, identifier, size] of [[desktop, "views@example.test", "desktop"], [mobile, "mobile-app@example.test", "mobile"]]) {
      page.on("pageerror", error => errors.push(error.message));
      await closed(page);
      await page.goto(loginUrl);
      await page.getByRole("heading", { name: "Login", exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: "Create account" }).count(), 0);
      assert.equal(await page.locator("swiper-container").count(), 0);
      await setEnabled(true);
      await page.reload();
      await page.getByRole("link", { name: "Create account", exact: true }).click();
      await fillSignup(page, identifier);
      await screenshot(page, `app-auth-signup-${size}`);
      if (size === "desktop") {
        await setEnabled(false);
        const refused = page.waitForResponse(response => response.url() === site + auth + "/sign-up/password");
        await page.getByRole("button", { name: "Create account", exact: true }).click();
        assert.equal((await refused).status(), 403);
        await page.getByRole("heading", { name: "Registration is closed", exact: true }).waitFor();
        assert.equal(await page.locator("form").count(), 0);
        await setEnabled(true);
        await page.reload();
        await fillSignup(page, identifier);
      }
      const created = page.waitForResponse(response => response.url() === site + auth + "/sign-up/password");
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      assert.equal((await created).status(), 201);
      await page.waitForURL(site + "/");
      const browserCookie = (await page.context().cookies(loginUrl)).find(cookie => cookie.name === appCookie);
      assert.equal(browserCookie?.httpOnly, true);
      assert.equal(browserCookie.path, appRoot);
      assert.equal(browserCookie.sameSite, "Lax");
      assert.match(browserCookie.value, new RegExp(`^zvs_app_${audience}_[A-Za-z0-9_-]{43}$`));
      assert.ok((await page.context().cookies(other + appRoot + "/login")).some(cookie => cookie.name === appCookie), "a sibling preview port shares the browser cookie jar");
      assert.equal((await page.request.get(other + auth + "/session")).status(), 401);
      assert.equal((await page.request.get(site + auth + "/accounts")).status(), 404);
      const { principal } = await (await page.request.get(site + auth + "/session")).json();
      assert.deepEqual(principal.roles, ["user"]);
      if (size === "desktop") {
        const cli = (action, ...args) => promisify(execFile)(process.execPath, ["../../dist/cli.js", "auth", action, "--url", site + appRoot, "--json", ...args], { cwd: packageRoot }).then(({ stdout }) => JSON.parse(stdout));
        assert.deepEqual(await cli("registration-status"), { enabled: true, providers: ["password"] });
        assert.equal((await cli("session", "--token", browserCookie.value)).principal.id, principal.id);
        assert.notEqual(principal.id, (await request("/auth/session")).principal.id);
      }
      await closed(page, other + appRoot + "/sign-up");
      await page.goto(loginUrl);
      await page.getByRole("heading", { name: "You're signed in", exact: true }).waitFor();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByRole("heading", { name: "Login", exact: true }).waitFor();
      assert.equal((await page.request.get(site + auth + "/session")).status(), 401);
      assert.equal((await page.context().cookies(loginUrl)).some(cookie => cookie.name === appCookie), false);
      await setEnabled(false);
      await page.reload();
      assert.equal(await page.getByRole("link", { name: "Create account" }).count(), 0);
      await screenshot(page, `app-auth-login-${size}`);
      await page.getByLabel("Email or username", { exact: true }).fill(identifier);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Login", exact: true }).click();
      await page.waitForURL(site + "/");
      assert.equal((await (await page.request.get(site + auth + "/session")).json()).principal.id, principal.id);
      const accounts = await request(project + "/proxy/zelavis/api/v1/auth/accounts");
      assert.equal(accounts.find(account => account.email === identifier)?.id, principal.id);
    }
    const owner = await request("/auth/session");
    const platformAccounts = await request("/auth/accounts");
    assert.equal(platformAccounts.find(account => account.email === "views@example.test")?.id, owner.principal.id);
    assert.equal(platformAccounts.some(account => account.email === "mobile-app@example.test"), false);
    assert.ok((await desktop.context().cookies(origin + mount + "/login")).some(cookie => cookie.name === "zelavis_session"));
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally {
    await desktop.close();
    await mobile.close();
  }
  console.log("App auth: desktop and mobile preview signup, stale forms, same-host sibling isolation, logout and closed-registration login passed.");
}

async function qualifySignup(operator, request, errors) {
  const customer = await browser.newPage({ viewport: nestedAuth ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  const stale = await browser.newPage({ viewport: { width: 390, height: 844 } });
  customer.on("pageerror", error => errors.push(error.message));
  stale.on("pageerror", error => errors.push(error.message));
  const dashboard = origin + mount;
  const customerName = "hosting-customer@example.test";
  await customer.goto(dashboard + "/login");
  await customer.getByRole("heading", { name: "Login to Zelavis" }).waitFor();
  assert.equal(await customer.getByRole("link", { name: "Create account" }).count(), 0);
  const closed = await customer.goto(dashboard + "/sign-up");
  assert.equal(closed.headers()["cache-control"], "no-store");
  await customer.waitForURL(dashboard + "/login?registration=closed");
  await customer.getByText("Registration is closed.", { exact: true }).waitFor();
  assert.equal(await customer.getByLabel("Confirm password").count(), 0);

  await operator.goto(dashboard + "/auth");
  const auth = operator.frameLocator('iframe[title="Auth"]');
  const toggle = auth.getByRole("checkbox", { name: "Allow public registration" });
  const save = auth.locator("#registration-save");
  await toggle.check();
  await save.click();
  await auth.getByText("Registration opened.", { exact: true }).waitFor();
  await customer.reload();
  const signup = customer.getByRole("link", { name: "Create account" });
  assert.equal(await signup.getAttribute("href"), mount + "/sign-up");
  await customer.evaluate(() => { window.loginFrame = document.querySelector("#workspace"); });
  const publicRequests = [];
  customer.on("request", request => publicRequests.push(new URL(request.url()).pathname));
  await signup.click();
  await customer.waitForURL(dashboard + "/sign-up");
  await fillSignup(customer, customerName);
  await screenshot(customer, nestedAuth ? "signup-mobile-nested" : "signup-desktop");
  assert.ok(await customer.evaluate(() => window.loginFrame === document.querySelector("#workspace")));
  assert.equal(await customer.getByLabel("Password", { exact: true }).getAttribute("autocomplete"), "new-password");
  assert.equal(await customer.getByLabel("Confirm password", { exact: true }).getAttribute("autocomplete"), "new-password");
  assert.ok(publicRequests.every(path => path.startsWith(mount + "/")), publicRequests.join("\n"));
  assert.equal(publicRequests.some(path => path.endsWith("/runtime/access") || path.endsWith("/runtime/updates")), false);
  await customer.getByLabel("Display name (optional)", { exact: true }).fill("Hosting customer");
  await customer.getByLabel("Confirm password", { exact: true }).fill(password + "mismatch");
  await customer.getByRole("button", { name: "Create account", exact: true }).click();
  await customer.getByText("The passwords do not match.", { exact: true }).waitFor();
  assert.equal(publicRequests.includes(mount + "/api/v1/auth/sign-up/password"), false);
  await customer.getByLabel("Confirm password", { exact: true }).fill(password);
  await customer.getByRole("button", { name: "Create account", exact: true }).click();
  await customer.waitForURL(dashboard + "/projects");
  const cookie = (await customer.context().cookies(dashboard)).find(cookie => cookie.name === "zelavis_session");
  assert.ok(cookie?.httpOnly);
  const inventory = await customer.request.get(api + "/runtime/projects");
  assert.ok(inventory.ok());
  assert.deepEqual((await inventory.json()).projects, []);
  await customer.getByRole("heading", { name: "No projects assigned" }).waitFor();
  assert.equal(await customer.getByRole("button", { name: "New project", exact: true }).count(), 0);
  assert.equal(await customer.locator('nav a[href*="/server"]').count(), 0);

  await stale.goto(dashboard + "/sign-up");
  await fillSignup(stale, customerName);
  const duplicate = stale.waitForResponse(response => response.url() === api + "/auth/sign-up/password");
  await stale.getByRole("button", { name: "Create account", exact: true }).click();
  const duplicateResponse = await duplicate;
  assert.equal(duplicateResponse.status(), 409);
  await stale.getByText((await duplicateResponse.json()).error, { exact: true }).waitFor();
  assert.equal(await stale.getByLabel("Password", { exact: true }).inputValue(), "");
  assert.equal(await stale.getByLabel("Confirm password", { exact: true }).inputValue(), "");
  await stale.route("**/auth/sign-up/password", route => route.fulfill({ status: 429, headers: { "retry-after": "1" }, json: { error: "Registration is busy.", code: "registration_busy" } }));
  await fillSignup(stale, "throttled-customer@example.test");
  await stale.getByRole("button", { name: "Create account", exact: true }).click();
  await stale.getByText("Registration is busy. Try again in 1 seconds.", { exact: true }).waitFor();
  assert.equal(await stale.getByLabel("Password", { exact: true }).inputValue(), "");
  await stale.unroute("**/auth/sign-up/password");
  await fillSignup(stale, "stale-customer@example.test");
  await stale.evaluate(() => { window.stalePassword = document.querySelector("#signup-password"); });
  await toggle.uncheck();
  await save.click();
  await auth.getByText("Registration closed.", { exact: true }).waitFor();
  assert.ok((await customer.request.get(api + "/runtime/projects")).ok(), "closing signup preserves an existing session");
  const refusal = stale.waitForResponse(response => response.url() === api + "/auth/sign-up/password");
  await stale.getByRole("button", { name: "Create account", exact: true }).click();
  assert.equal((await refusal).status(), 403);
  await stale.waitForURL(dashboard + "/login?registration=closed");
  await stale.getByText("Registration is closed.", { exact: true }).waitFor();
  assert.equal(await stale.getByLabel("Confirm password").count(), 0);
  assert.ok(await stale.evaluate(() => window.stalePassword.value === "" && !window.stalePassword.isConnected));
  assert.equal((await request("/auth/accounts")).some(account => account.email === "stale-customer@example.test"), false);

  await customer.goto(dashboard + "/logout");
  await customer.waitForURL(dashboard + "/login");
  await login(customer, customerName);
  assert.equal((await customer.request.get(api + "/runtime/projects")).status(), 200);
  assert.equal(errors.length, 0, errors.join("\n"));
  await stale.close();
  console.log(`Platform signup (${mount}): closed route, open enrollment, HttpOnly session, stale form refusal and existing login passed.`);
  return { customer, customerName };
}

async function choose(page, name, value) {
  await page.getByLabel(name, { exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

async function qualifyAccountAccess(operator, request, customer, customerName, errors) {
  const customerAccount = (await request("/auth/accounts")).find(account => account.email === customerName);
  const owner = (await request("/auth/accounts")).find(account => account.roles?.includes("owner"));
  const users = origin + mount + "/server/access/users?q=kept&filter=Unverified&sidebar=server";
  await operator.goto(users);
  assert.equal(await operator.getByRole("button", { name: "Edit access for Server view qualification", exact: true }).count(), 0);
  await operator.getByRole("button", { name: "Edit access for Hosting customer", exact: true }).click();
  const drawer = operator.getByRole("dialog", { name: "Edit access for Hosting customer", exact: true });
  await drawer.waitFor();
  assert.equal(new URL(operator.url()).searchParams.get("accountAccess"), customerAccount.id);
  await operator.reload();
  await drawer.waitFor();
  await drawer.press("Escape");
  await operator.waitForURL(url => !url.searchParams.has("accountAccess"));
  assert.equal(new URL(operator.url()).searchParams.get("q"), "kept");
  await operator.getByRole("button", { name: "Edit access for Hosting customer", exact: true }).click();
  await drawer.waitFor();
  await choose(operator, "Grant project", "View laboratory");
  await drawer.getByRole("button", { name: "Add grant", exact: true }).click();
  await screenshot(operator, "account-access-desktop");
  const accessWrite = operator.waitForResponse(response => response.url() === api + "/auth/accounts/" + customerAccount.id + "/access" && response.request().method() === "PUT");
  await drawer.getByRole("button", { name: "Save access", exact: true }).click();
  assert.equal((await accessWrite).status(), 200);
  await operator.getByText("Account access saved.", { exact: true }).waitFor();
  const after = new URL(operator.url());
  assert.equal(after.searchParams.has("accountAccess"), false);
  assert.equal(after.searchParams.get("q"), "kept");
  assert.equal(after.searchParams.get("filter"), "Unverified");
  assert.equal(after.searchParams.get("sidebar"), "server");
  assert.equal((await customer.request.get(api + "/runtime/projects")).status(), 401);
  await customer.goto(origin + mount + "/projects");
  await customer.waitForURL(url => url.pathname === mount + "/login");
  await login(customer, customerName);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await customer.setViewportSize(viewport);
    await customer.goto(origin + mount + "/projects?sidebarView=content");
    await customer.getByRole("heading", { name: "View laboratory", exact: true }).waitFor();
    assert.equal(await customer.getByRole("heading", { name: "Sibling laboratory", exact: true }).count(), 0);
    for (const action of ["New project", "Manage version", "Stop", "Start", "Restart", "Delete", "Ask Assistant"]) {
      assert.equal(await customer.getByRole("button", { name: action, exact: true }).count(), 0, action);
    }
    assert.equal(await customer.locator('nav a[href*="/server"]').count(), 0);
    if (viewport.width < 1024) await customer.waitForFunction(() => {
      const box = document.querySelector("#workspace").getBoundingClientRect();
      return document.querySelector(".dashboard").classList.contains("mobile-content") && box.left >= 0 && box.left < 20;
    });
    await screenshot(customer, `customer-projects-${viewport.width}`);
    const visible = await customer.request.get(api + "/runtime/projects");
    assert.deepEqual((await visible.json()).projects.map(project => project.id), ["view-lab"]);
  }
  await customer.goto(origin + mount + "/server/database?sidebarView=content");
  await customer.locator(".content [role=alert]").filter({ hasText: /Missing required permission/ }).waitFor();
  assert.equal((await customer.request.get(api + "/runtime/system-store/namespaces")).status(), 403);
  await customer.goto(origin + mount + "/projects/view-sibling?sidebarView=content");
  await customer.locator(".content [role=alert]").filter({ hasText: /Missing required permission/ }).waitFor();
  await customer.goto(origin + mount + "/projects/view-lab/auth?sidebarView=content");
  await customer.locator(".content [role=alert]").filter({ hasText: /Missing required permission/ }).waitFor();
  assert.equal(await customer.getByRole("checkbox", { name: "Allow public registration" }).count(), 0);

  // A concurrent edit wins. The drawer reloads the new role and its advanced grant.
  await operator.setViewportSize({ width: 390, height: 844 });
  await operator.goto(users + "&sidebarView=content&accountAccess=" + customerAccount.id);
  await drawer.waitFor();
  await choose(operator, "Grant project", "Sibling laboratory");
  await drawer.getByRole("button", { name: "Add grant", exact: true }).click();
  const current = (await request("/auth/accounts?accountId=" + customerAccount.id))[0];
  const settingsGrant = { permission: "project.settings.manage", scope: { type: "project", projectId: "view-lab" } };
  await request("/auth/accounts/" + customerAccount.id + "/access", "PUT", { expectedRevision: current.accessRevision, role: "operator", permissions: [], grants: [...current.grants, settingsGrant] });
  await drawer.getByRole("button", { name: "Save access", exact: true }).click();
  await drawer.getByText("Account access changed. Review the current access and reapply your change.", { exact: true }).waitFor();
  assert.equal((await request("/auth/accounts?accountId=" + customerAccount.id))[0].grants.some(grant => grant.scope.projectId === "view-sibling"), false);
  await drawer.getByText("project.settings.manage", { exact: true }).waitFor();
  await choose(operator, "Account role", "Customer");
  await screenshot(operator, "account-access-mobile");
  await drawer.getByRole("button", { name: "Save access", exact: true }).click();
  await operator.getByText("Account access saved.", { exact: true }).waitFor();
  const preserved = (await request("/auth/accounts?accountId=" + customerAccount.id))[0];
  assert.deepEqual(preserved.roles, ["customer"]);
  assert.ok(preserved.grants.some(grant => grant.permission === "project.settings.manage"));
  await operator.goto(users + "&sidebarView=content&accountAccess=" + customerAccount.id);
  await drawer.waitFor();
  await drawer.getByRole("button", { name: "Remove project.view from Project View laboratory", exact: true }).click();
  await drawer.getByRole("button", { name: "Save access", exact: true }).click();
  await operator.getByText("Account access saved.", { exact: true }).waitFor();
  await customer.goto(origin + mount + "/projects?sidebarView=content");
  await customer.waitForURL(url => url.pathname === mount + "/login");
  await login(customer, customerName);
  await customer.getByRole("heading", { name: "No projects assigned" }).waitFor();

  // This delegate has settings alone. Neither Project config nor provider administration may hide the exact setting.
  await customer.goto(origin + mount + "/projects/view-lab/auth?sidebarView=content");
  const delegateToggle = customer.getByRole("checkbox", { name: "Allow public registration" });
  await delegateToggle.check();
  await customer.getByRole("button", { name: "Save", exact: true }).click();
  await customer.getByText("Registration opened.", { exact: true }).waitFor();
  assert.equal((await request("/runtime/projects/view-lab/auth/registration/settings")).enabled, true);
  assert.equal((await customer.request.post(api + "/runtime/projects/view-lab/stop", { headers: { origin }, data: {} })).status(), 403);
  await customer.goto(origin + mount + "/projects/view-sibling/auth?sidebarView=content");
  await customer.locator(".content [role=alert]").filter({ hasText: /Missing required permission/ }).waitFor();
  assert.equal(await customer.getByRole("checkbox", { name: "Allow public registration" }).count(), 0);

  await operator.goto(users + "&sidebarView=content&accountAccess=" + owner.id);
  await operator.getByText("This account’s access is protected.", { exact: true }).waitFor();
  assert.equal(await operator.getByRole("button", { name: "Save access", exact: true }).count(), 0);
  const protectedWrite = await operator.request.put(api + "/auth/accounts/" + owner.id + "/access", { headers: { origin }, data: { expectedRevision: owner.accessRevision, role: "customer", permissions: [], grants: [] } });
  assert.equal(protectedWrite.status(), 403);

  // Use the same account ID in both stores to prove the Project editor's exact save destination.
  const appAccount = await request("/runtime/projects/view-lab/proxy/zelavis/api/v1/auth/accounts", "POST", { id: customerAccount.id, username: "application-customer", roles: ["user"], permissions: [], grants: [] });
  assert.equal(appAccount.id, customerAccount.id);
  const appUsers = origin + mount + "/projects/view-lab/users?q=application&filter=Unverified&sidebarView=content";
  await operator.goto(appUsers);
  await operator.getByRole("button", { name: "Edit access for application-customer", exact: true }).click();
  const appDrawer = operator.getByRole("dialog", { name: "Edit access for application-customer", exact: true });
  await appDrawer.waitFor();
  assert.equal(await appDrawer.locator('zv-select[data-dropdown="Account role"]').getAttribute("value"), "user");
  assert.equal(await appDrawer.locator('zv-select[data-dropdown="Grant project"]').getAttribute("value"), "view-lab");
  await appDrawer.getByRole("button", { name: "Add grant", exact: true }).click();
  const projectWrite = operator.waitForResponse(response => response.url() === api + "/runtime/projects/view-lab/auth/accounts/" + customerAccount.id + "/access" && response.request().method() === "PUT");
  await appDrawer.getByRole("button", { name: "Save access", exact: true }).click();
  assert.equal((await projectWrite).status(), 200);
  await operator.getByText("Account access saved.", { exact: true }).waitFor();
  assert.equal(new URL(operator.url()).searchParams.get("q"), "application");
  assert.equal(new URL(operator.url()).searchParams.get("filter"), "Unverified");
  const appAccess = (await request("/runtime/projects/view-lab/proxy/zelavis/api/v1/auth/accounts?accountId=" + customerAccount.id))[0];
  assert.deepEqual(appAccess.grants, [{ permission: "project.view", scope: { type: "project", projectId: "view-lab" } }]);
  assert.deepEqual((await request("/auth/accounts?accountId=" + customerAccount.id))[0].grants, [settingsGrant]);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Account access: conditional drawers at both sizes, protected owner, preserved grants, customer session revocation and inventory, exact child editor and settings delegate passed.");
}

async function qualifyProjectDomains(operator, request, customer, customerName) {
  const projectId = "view-lab";
  const path = `/runtime/projects/${projectId}/domains`;
  const account = (await request("/auth/accounts")).find(entry => entry.email === customerName);
  assert.ok(account);
  const grant = permission => ({ permission, scope: { type: "project", projectId } });
  const relogin = async () => {
    await customer.goto(origin + mount + "/projects");
    await customer.waitForURL(url => url.pathname === mount + "/login");
    await login(customer, customerName);
  };
  const edit = async permissions => {
    const current = (await request(`/auth/accounts?accountId=${account.id}`))[0];
    await request(`/auth/accounts/${account.id}/access`, "PUT", {
      expectedRevision: current.accessRevision, role: "customer", permissions: [], grants: permissions.map(grant),
    });
    await relogin();
  };
  await operator.goto(`${origin}${mount}/server/access/users?sidebarView=content&accountAccess=${account.id}`);
  const drawer = operator.getByRole("dialog", { name: "Edit access for Hosting customer", exact: true });
  await drawer.waitFor();
  await choose(operator, "Grant project", "View laboratory");
  await drawer.getByRole("button", { name: "Add grant", exact: true }).click();
  await choose(operator, "Grant permission", "Manage Project domains");
  await drawer.getByRole("button", { name: "Add grant", exact: true }).click();
  await drawer.getByText("project.domains.manage", { exact: true }).waitFor();
  await drawer.getByRole("button", { name: "Save access", exact: true }).click();
  await operator.getByText("Account access saved.", { exact: true }).waitFor();
  await relogin();
  const domainsUrl = `${origin}${mount}/projects/${projectId}/domains?sidebarView=content`;
  await customer.setViewportSize({ width: 1440, height: 1000 });
  await customer.goto(domainsUrl);
  await customer.getByLabel("Hostname", { exact: true }).fill("*.example.com");
  await customer.getByRole("button", { name: "Add domain", exact: true }).click();
  await customer.getByRole("alert").filter({ hasText: "Enter an exact public hostname." }).waitFor();
  await customer.getByLabel("Hostname", { exact: true }).fill(domainHost.toUpperCase() + ".");
  await customer.getByRole("button", { name: "Add domain", exact: true }).click();
  await customer.getByText("TXT challenge created.", { exact: true }).waitFor();
  const name = await customer.getByLabel("TXT name", { exact: true }).inputValue();
  const value = await customer.getByLabel("TXT value", { exact: true }).inputValue();
  assert.equal(name, `_zelavis-challenge.${domainHost}`);
  assert.ok(value);
  assert.equal(await customer.getByRole("link", { name: "Open site" }).count(), 0);
  assert.equal((await customer.request.get(api + "/runtime/projects/view-sibling/domains")).status(), 403);
  assert.equal((await customer.request.get(api + "/runtime/edge/routes")).status(), 403);
  await screenshot(customer, "project-domain-pending-desktop");
  await customer.setViewportSize({ width: 390, height: 844 });
  await customer.reload();
  await customer.getByLabel("TXT value", { exact: true }).waitFor();
  await customer.getByRole("button", { name: "Copy TXT value", exact: true }).click();
  await customer.getByText(/TXT value copied|Copy the selected text/).waitFor();
  await screenshot(customer, "project-domain-pending-mobile");
  await writeFile(txtFile, `${name}\n${value}\n`);
  await customer.getByRole("button", { name: "Verify DNS", exact: true }).click();
  const open = customer.getByRole("link", { name: "Open site", exact: true });
  await open.waitFor();
  assert.equal(await open.getAttribute("href"), `https://${domainHost}/`);
  assert.equal(await customer.getByLabel("TXT value", { exact: true }).count(), 0);
  await screenshot(customer, "project-domain-active-mobile");

  const key = join(data, "domain.key"), cert = join(data, "domain.crt");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${domainHost}`, "-addext", `subjectAltName=DNS:${domainHost}`]);
  domainProxy = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
    const authority = String(incoming.headers.host ?? "");
    if (authority.split(":")[0] !== domainHost) { outgoing.writeHead(404).end(); return; }
    const upstream = httpRequest({
      hostname: "127.0.0.1", port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, "x-forwarded-proto": "https" },
    }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.writeHead(502).end());
    incoming.pipe(upstream);
  });
  await new Promise(resolve => domainProxy.listen(0, "127.0.0.1", resolve));
  const publicSite = `https://${domainHost}:${domainProxy.address().port}`;
  const app = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  try {
    assert.equal((await app.goto(publicSite + "/zelavis/sign-up")).status(), 200);
    const identity = "verified-domain-app@example.test";
    await fillSignup(app, identity);
    await app.getByRole("button", { name: "Create account", exact: true }).click();
    await app.waitForURL(publicSite + "/");
    const cookies = await app.context().cookies(publicSite + "/zelavis/login");
    assert.ok(cookies.some(cookie => cookie.name.startsWith("zelavis_app_") && cookie.secure && cookie.httpOnly));
    assert.equal(cookies.some(cookie => cookie.name === "zelavis_session"), false);
    for (const path of ["/zelavis/setup", "/zelavis/api/v1/auth/accounts", "/zelavis/api/v1/runtime/projects"]) {
      assert.equal(await app.evaluate(path => fetch(path).then(response => response.status), path), 404);
    }
    assert.equal((await request("/auth/accounts")).some(entry => entry.email === identity), false);
  } finally { await app.close(); }

  await operator.goto(origin + mount + "/projects/view-lab/auth?sidebarView=content");
  assert.equal(await operator.getByRole("link", { name: "Open App signup", exact: true }).getAttribute("href"), `https://${domainHost}/zelavis/sign-up`);
  await operator.goto(origin + mount + "/server/domains?sidebarView=content");
  await operator.getByText(domainHost, { exact: true }).waitFor();
  await edit(["project.view", "project.domains.view"]);
  await customer.goto(domainsUrl);
  await customer.getByRole("link", { name: "Open site" }).waitFor();
  assert.equal(await customer.getByRole("button", { name: "Remove domain" }).count(), 0);
  assert.equal(await customer.getByRole("button", { name: "Add domain" }).count(), 0);
  await edit(["project.view", "project.domains.manage"]);
  await customer.goto(domainsUrl);
  customer.once("dialog", dialog => dialog.accept());
  await customer.getByRole("button", { name: "Remove domain", exact: true }).click();
  await customer.getByText("Domain removed.", { exact: true }).waitFor();
  assert.deepEqual(await request(path), { domains: [] });
  assert.equal((await request("/runtime/edge/routes")).hostnames.some(entry => entry.host === domainHost), false);
  console.log("Project domains: desktop/mobile TXT challenge, real external TLS ingress and App signup, read-only grant, server inventory and withdrawal passed.");
}

async function qualify() {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Platform exited: ${logs}`);
    try { if ((await fetch(`${api}/auth/bootstrap`)).ok) { ready = true; break; } } catch {}
    await delay(200);
  }
  assert.ok(ready, "Platform starts within 30 seconds");
  let uiOrigin = origin;
  if (devMode) {
    process.env.ZELAVIS_DEV_SERVER = origin;
    dev = await createViteServer({ root: packageRoot, logLevel: "silent", server: { port: 0, host: "127.0.0.1", hmr: false, ws: false } });
    await dev.listen(); uiOrigin = `http://127.0.0.1:${dev.httpServer.address().port}`;
  }
  browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${domainHost} 127.0.0.1`, "--no-proxy-server"] });
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ownerContext.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let sessionInstalled = false;
  page.on("console", message => { if (message.type() === "error" && !(!sessionInstalled && /Failed to load resource:.*401/.test(message.text()))) errors.push(message.text()); });
  await page.goto(`${uiOrigin}${mount}${nestedAuth ? "/sign-up" : "/projects/view-lab/database"}`);
  await page.waitForURL(`${uiOrigin}${mount}/setup`).catch(async error => { console.error("Dashboard startup:", page.url(), (await page.locator("body").innerText()).slice(0, 800), errors); throw error; });
  if (!devMode && !nestedAuth) {
    await page.goto(`${uiOrigin}${mount}/sign-up`);
    await page.waitForURL(`${uiOrigin}${mount}/setup`);
  }
  const bootstrap = await fetch(`${api}/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ bootstrapToken: token, provider: "password", account: { email: "views@example.test", displayName: "Server view qualification" }, credential: { identifier: "views@example.test", password } }) });
  assert.ok(bootstrap.ok, `Owner bootstrap succeeds (${bootstrap.status})`);
  const cookie = bootstrap.headers.getSetCookie().find(value => value.startsWith("zelavis_session="));
  const session = cookie?.match(/^zelavis_session=([^;]+)/)?.[1] ?? (await bootstrap.json()).session.token;
  const request = async (path, method = "GET", body) => {
    const response = await fetch(api + path, { method, headers: { origin, cookie: `zelavis_session=${session}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`); return result;
  };
  if (nestedAuth) {
    await ownerContext.addCookies([{ name: "zelavis_session", value: session, url: uiOrigin + mount }]);
    sessionInstalled = true;
    await qualifySignup(page, request, errors);
    return;
  }
  await request("/runtime/projects", "POST", { id: "view-lab", name: "View laboratory", recipeName: "@zelavis/app", start: true });
  const proxy = "/runtime/projects/view-lab/proxy/zelavis/api/v1";
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await fetch(api + proxy + "/runtime/config", { headers: { cookie: `zelavis_session=${session}` } });
    if (response.ok) break; if (attempt === 149) throw new Error(`Project did not become ready: ${await response.text()}`); await delay(200);
  }
  await request(proxy + "/database/documents/collections", "POST", { tenantId: "tenant-a", name: "articles", surface: "database" });
  await request(proxy + "/database/documents/articles", "POST", { tenantId: "tenant-a", id: "row-a", data: { title: "Actual database", count: 1 } });
  const route = `${uiOrigin}/zelavis/projects/view-lab/database?databaseTenant=tenant-a&databaseTable=articles&databaseRow=row-a&sidebar=projects/project/database`;
  const anonymous = await browser.newPage(); await anonymous.goto(route); await anonymous.waitForURL(/\/zelavis\/login/); await anonymous.close();
  await page.context().addCookies([{ name: "zelavis_session", value: session, url: uiOrigin + "/zelavis" }]);
  sessionInstalled = true;
  const html = await page.goto(route, { waitUntil: "networkidle" }); assert.equal(html.status(), 200);
  await page.getByLabel("Selected record JSON").waitFor();
  await page.getByLabel("Selected record JSON").fill('{"title":"Actual retained edit","count":2}');
  await page.getByRole("button", { name: "Stage record JSON", exact: true }).click();
  await page.evaluate(() => { window.retainedGrid = document.querySelector(".database-grid"); window.retainedSwiper = document.querySelector("swiper-container"); });
  const before = await page.locator(".server-view-status span").innerText();
  await page.getByRole("button", { name: "Refresh records", exact: true }).click();
  await page.waitForFunction(before => document.querySelector(".server-view-status span").textContent !== before, before);
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, "Actual retained edit");
  assert.ok(await page.evaluate(() => window.retainedGrid === document.querySelector(".database-grid") && window.retainedSwiper === document.querySelector("swiper-container")));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Selected record JSON").waitFor();
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, "Actual retained edit");
  assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("1 record saved.", { exact: true }).waitFor();
  const query = await request(proxy + "/database/documents/articles/query", "POST", { tenantId: "tenant-a", limit: 25 });
  assert.equal(query.documents[0].data.title, "Actual retained edit");
  await page.getByRole("button", { name: "Collection schema", exact: true }).click();
  await page.getByLabel("Schema fields JSON").waitFor();
  const previousSchemas = (await request(proxy + "/database/schemas/articles?tenantId=tenant-a")).schemas;
  const nextVersion = Math.max(0, ...previousSchemas.map(schema => schema.version)) + 1;
  const fields = [{ name: "title", field: { _tag: "TextField", label: "Article title", required: true } }, { name: "count", field: { _tag: "IntegerField", label: "Article count", required: false } }, { name: "published", field: { _tag: "BooleanField", label: "Published", required: false } }];
  await page.getByLabel("Schema fields JSON").fill(JSON.stringify(fields, null, 2));
  await page.getByRole("button", { name: "Save and activate new schema version", exact: true }).click();
  await page.locator("zv-select-item", { hasText: `v${nextVersion} · active` }).waitFor({ state: "attached", timeout: 10000 }).catch(async error => { console.error("Schema save:", errors, previousSchemas, (await page.locator("body").innerText()).slice(-2500)); throw error; });
  assert.equal((await request(proxy + "/database/schemas/articles?tenantId=tenant-a")).schemas.find(schema => schema.version === nextVersion).active, true);
  await page.getByRole("button", { name: "Records", exact: true }).click();
  await page.getByLabel("Article title", { exact: true }).waitFor();
  await page.getByLabel("Article title", { exact: true }).fill("Typed schema edit");
  await page.getByLabel("Article count", { exact: true }).fill("3");
  await page.getByLabel("Published", { exact: true }).check();
  await page.reload({ waitUntil: "networkidle" }); await page.getByLabel("Article title", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Article title", { exact: true }).inputValue(), "Typed schema edit");
  await page.getByRole("button", { name: "Stage record JSON", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("1 record saved.", { exact: true }).waitFor();
  const typed = await request(proxy + "/database/documents/articles/query", "POST", { tenantId: "tenant-a", limit: 25 });
  assert.deepEqual(typed.documents[0].data, { title: "Typed schema edit", count: 3, published: true });
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(`${devMode ? "Vite dev" : "Embedded Platform"}: first-owner/login gates, real project database SSR, retained draft/grid/sidebar, persisted saves, real schema activation and typed edit reload recovery passed.`);

  if (!devMode) {
    const operator = await page.context().newPage();
    operator.on("pageerror", error => errors.push(error.message));
    const platformPolicy = "/auth/registration/settings";
    await operator.goto(`${uiOrigin}/zelavis/auth`);
    const auth = operator.frameLocator('iframe[title="Auth"]');
    const platformToggle = auth.getByRole("checkbox", { name: "Allow public registration" });
    const platformSave = auth.locator("#registration-save");
    await auth.getByText("Registration is closed.", { exact: true }).waitFor();
    await qualifyServiceWorkspace(operator);
    assert.equal(await platformSave.isDisabled(), true);
    await platformToggle.check();
    await platformSave.click();
    await auth.getByText("Registration opened.", { exact: true }).waitFor();
    assert.equal((await request(platformPolicy)).enabled, true);
    const current = await request(platformPolicy);
    await request(platformPolicy, "PUT", { enabled: false, expectedRevision: current.revision });
    await platformToggle.uncheck();
    await platformSave.click();
    await auth.getByText(/Registration settings changed/).waitFor();
    assert.equal(await platformToggle.isChecked(), false);
    assert.equal(await platformSave.isDisabled(), true);

    await request("/runtime/projects", "POST", { id: "view-sibling", name: "Sibling laboratory", recipeName: "@zelavis/app", start: false });
    await operator.goto(`${uiOrigin}/zelavis/projects/view-sibling/auth`);
    await operator.getByText('Project "view-sibling" is not running.', { exact: true }).waitFor({ timeout: 5000 }).catch(async error => {
      console.error("Stopped Auth:", await operator.locator("body").innerText(), errors);
      throw error;
    });
    assert.equal(await operator.getByRole("checkbox", { name: "Allow public registration" }).count(), 0);
    const unavailablePolicy = api + "/runtime/projects/view-lab/auth/registration/settings";
    await operator.route(unavailablePolicy, route => route.fulfill({ status: 404, json: { error: "Not found" } }));
    await operator.goto(`${uiOrigin}/zelavis/projects/view-lab/auth`);
    await operator.getByText("Registration settings are unavailable. Check that the Project exists and its App engine supports registration settings.", { exact: true }).waitFor();
    assert.equal(await operator.getByRole("checkbox", { name: "Allow public registration" }).count(), 0);
    await operator.unroute(unavailablePolicy);
    await request("/runtime/projects/view-sibling/start", "POST", {});
    const siblingPolicy = "/runtime/projects/view-sibling/auth/registration/settings";
    const projectPolicy = "/runtime/projects/view-lab/auth/registration/settings";
    assert.equal((await request(siblingPolicy)).enabled, false);
    await operator.goto(`${uiOrigin}/zelavis/projects/view-lab/auth`);
    const projectToggle = operator.getByRole("checkbox", { name: "Allow public registration" });
    const projectSave = operator.locator("section.k-card").filter({ has: operator.getByRole("heading", { name: "Public registration" }) }).getByRole("button", { name: "Save", exact: true });
    await projectToggle.check();
    await projectSave.click();
    await operator.getByText("Registration opened.", { exact: true }).waitFor();
    assert.equal((await request(projectPolicy)).enabled, true);
    assert.equal((await request(siblingPolicy)).enabled, false);
    assert.equal((await request(platformPolicy)).enabled, false);
    const appCurrent = await request(projectPolicy);
    await request(projectPolicy, "PUT", { enabled: false, expectedRevision: appCurrent.revision });
    await projectToggle.uncheck();
    await projectSave.click();
    await operator.getByText(/Registration settings changed/).waitFor();
    assert.equal(await projectToggle.isChecked(), false);
    assert.equal(await projectSave.isDisabled(), true);
    assert.equal(errors.length, 0, errors.join("\n"));
    await qualifyAppAuth(operator, request, errors);
    const { customer, customerName } = await qualifySignup(operator, request, errors);
    await qualifyAccountAccess(operator, request, customer, customerName, errors);
    await qualifyProjectDomains(operator, request, customer, customerName);
    await operator.close();
    console.log("Registration settings: Platform and exact Project saves, stale revisions, stopped Project and sibling isolation passed.");
  }
}

try {
  await qualify();
} finally {
  await browser?.close();
  if (domainProxy) await new Promise(resolve => domainProxy.close(resolve));
  await dev?.close();
  if (previousOrigin === undefined) delete process.env.ZELAVIS_DEV_SERVER; else process.env.ZELAVIS_DEV_SERVER = previousOrigin;
  if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(10000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); })]); }
  await rm(data, { recursive: true, force: true });
}
