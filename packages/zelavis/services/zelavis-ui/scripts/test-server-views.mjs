import "./fuzor-source.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { createNodeHttpServer } from "../../../dist/core/runtime/node-http.js";
import { closeNodeServer } from "zelavis/runtimes/node";
import { serverNavigationMenu } from "../src/server-navigation.ts";
import { zelavisUiFrontend } from "../src/frontend.ts";
import { mountOf, requestIntoBuild, responseOutOfBuild } from "../src/mount-rewrite.ts";

// Keep the API isolated while serving the compiled views through the production HTTP boundary and asset loader.
// Fuzor's standalone Node server is not the server an installed Zelavis dashboard uses.
const mount = mountOf("/zelavis");

let revision = 1, saved = 0, denySave = false;
const documents = [{ id: "row-a", version: 1, data: { title: "Server A", count: 1, "literal.key": true, ["__proto__"]: { independent: true }, constructor: "database field" } }, { id: "row-b", version: 1, data: { title: "Server B", count: 2 } }];
const project = { id: "view-lab", name: "View laboratory", recipe: { name: "@zelavis/app" }, runtime: { status: "running" } };
const api = "/zelavis/api/v1", proxy = `${api}/runtime/projects/view-lab/proxy${api}`;
const fixtureService = { name: "@fixture/page", scope: "extension", status: "installed", apiPath: `${api}/plugins/fixture`, menus: [{ title: "Fixture page", path: "/fixture/page", page: { src: `${api}/runtime/service-page-assets/%40fixture%2Fpage/dist/dashboard.html` } }] };
let schemas = [{ collection: "articles", version: 1, active: true, fields: [{ name: "title", field: { _tag: "TextField", label: "Article title", required: true } }, { name: "count", field: { _tag: "IntegerField", label: "Article count", required: false } }] }];
const config = { access: { mode: "owner", label: "Owner", principal: { id: "owner", type: "user", permissions: ["*"], roles: ["owner"] } }, services: [{ name: "@zelavis/new-ui", scope: "system", apiPath: api + "/plugins/newui", menus: [serverNavigationMenu] }], serviceRegistry: [fixtureService], rootPath: "/zelavis", api: { basePath: api }, capabilities: { database: { available: true, used: true } } };
const observed = [];
const installs = new Set(); let approvalDecisions = 0, uploaded = false, signedOut = false;
const thread = { id: "thread-1", title: "Qualification", messages: [{ id: "reply-1", role: "assistant", content: "![untrusted image](https://example.test/image.png)" }] };
const approval = { id: "approval-1", label: "Delete Project", target: { kind: "project", id: "view-lab" }, irreversible: true, status: "pending" };

const upstream = createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  const send = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === `${api}/runtime/config` || path === `${proxy}/runtime/config`) return send(config);
  if (path === `${api}/auth/bootstrap`) return send({ available: true, required: false, providers: ["password"], enrollmentProviders: [] });
  if (!req.headers.cookie?.includes("view-session=owner")) return send({ error: "Unauthorized" }, 401);
  observed.push({ path, cookie: req.headers.cookie });
  if (path === `${api}/auth/session` && req.method === "DELETE") { signedOut = true; return send({ ok: true }); }
  if (path.endsWith("/runtime/service-page-assets/%40fixture%2Fpage/dist/dashboard.html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end('<!doctype html><title>Fixture page</title><p>Sandboxed plugin page</p>'); }
  if (path === `${api}/plugins/fixture/ping` || path === `${proxy}/plugins/fixture/ping`) return send({ target: path });
  if (path === `${api}/runtime/access`) return send(config.access);
  if (path.endsWith("/runtime/settings")) return send({ rootPath: "/zelavis", apiBasePath: api, runtimeEngine: { current: "node", desired: "node", available: ["node"], restartRequired: false }, theme: "auto", pageBuilderEnabled: false, preferences: {}, persistence: "runtime", editable: { rootPath: true, runtimeEngine: true, theme: true, pageBuilder: true }, restartRequired: false });
  if (path === `${api}/runtime/system-store/namespaces`) return send({ namespaces: [] });
  if (path === `${api}/runtime/projects`) return send({ projects: [project] });
  if (path === `${proxy}/database/documents/collections`) return send({ collections: [{ name: "articles", tenantId: "tenant-a", surface: "database", documentCount: 2 }] });
  if (path === `${proxy}/database/schemas`) return send({ collections: [] });
  if (path === `${proxy}/database/menu/tables`) return send({ items: [{ title: "Articles", search: { databaseTenant: "tenant-a", databaseTable: "articles" } }] });
  let text = ""; for await (const chunk of req) text += chunk; const body = text && req.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : {};
  if (path === `${api}/runtime/assistant/threads`) return send({ threads: [thread] });
  if (path === `${api}/runtime/assistant/threads/thread-1`) return send({ thread, approvals: [approval] });
  if (path === `${api}/runtime/assistant/threads/thread-1/approvals/approval-1`) {
    assert.equal(body.confirm, "view-lab"); assert.equal(body.decision, "approve"); approvalDecisions++; approval.status = "executed"; return send({ approval });
  }
  if (path === `${api}/runtime/assistant/threads/thread-1/messages`) { thread.messages.push({ id: "reply-2", role: "assistant", content: `Received: ${body.content}` }); return send({ thread }); }
  if (path === `${api}/runtime/assistant/provider`) return send({ source: "stored", model: "test-model", provider: "openai", hasApiKey: true });
  if (path === `${api}/runtime/edge/onboard`) return send({ status: "configured" });
  if (path === `${api}/runtime/services` || path === `${proxy}/runtime/services`) {
    if (req.method === "POST") { assert.equal(body.specifier, "npm:@fixture/plugin@1.2.3"); installs.add(path); }
    return send({ services: [fixtureService, { name: "@fixture/plugin", version: "1.2.3", kind: "plugin", scope: "extension", status: installs.has(path) ? "installed" : "available", installVia: "acquire" }] });
  }
  if (path === `${proxy}/storage/files`) return send({ files: uploaded ? [{ path: "assets/test.txt", size: 4, contentType: "text/plain" }] : [] });
  if (path === `${proxy}/storage/files/assets/test.txt` && req.method === "PUT") { assert.equal(text, "test"); uploaded = true; return send({ file: { path: "assets/test.txt" } }); }
  if (path === `${proxy}/database/schemas/articles`) {
    if (req.method === "POST") {
      assert.equal(body.tenantId, "tenant-a");
      if (schemas.some(schema => schema.version === body.version)) return send({ error: "Schema version already exists" }, 409);
      if (body.activate) schemas = schemas.map(schema => ({ ...schema, active: false }));
      const schema = { collection: "articles", version: body.version, active: body.activate, fields: body.fields }; schemas.push(schema); return send(schema);
    }
    return send({ collection: "articles", schemas });
  }
  if (path === `${proxy}/database/schemas/articles/activate`) { assert.equal(body.tenantId, "tenant-a"); schemas = schemas.map(schema => ({ ...schema, active: schema.version === body.version })); return send(schemas.find(schema => schema.active)); }
  if (body.tenantId && body.tenantId !== "tenant-a") return send({ error: "Forbidden tenant" }, 403);
  if (path === `${proxy}/database/documents/articles/page` || path === `${proxy}/database/documents/articles/query`) return send({ documents: documents.map(row => ({ ...row, data: { ...row.data, revision } })) });
  if (path === `${proxy}/database/tenants`) return send({ tenants: ["tenant-a"] });
  if (path === `${proxy}/database/documents/articles/row-a` && req.method === "PATCH") {
    if (denySave || body.expectedVersion !== documents[0].version) return send({ error: "Version conflict" }, 409);
    documents[0] = { ...documents[0], data: body.data, version: documents[0].version + 1 }; saved++; return send({ document: documents[0] });
  }
  return send({ error: `Unknown fixture route: ${path}` }, 404);
});
let app, browser;
const previous = process.env.ZELAVIS_DEV_SERVER;
try {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  process.env.ZELAVIS_DEV_SERVER = upstreamOrigin;
  const fixtureFetch = async request => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers); headers.set("origin", upstreamOrigin);
    return fetch(new URL(url.pathname + url.search, upstreamOrigin), { method: request.method, headers, signal: request.signal, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }) });
  };
  const frontend = await zelavisUiFrontend({ rootPath: mount, createRuntimeConfig: async () => config, fetch: fixtureFetch });
  const { handler: buildHandler } = await import(new URL("../.fuzor/dist-backend/entry.mjs", import.meta.url));
  const handler = async request => { const entering = requestIntoBuild(request, mount); return entering ? responseOutOfBuild(await buildHandler(entering), mount) : new Response("Not found", { status: 404 }); };
  app = createNodeHttpServer({ fetch: async request => {
    const url = new URL(request.url);
    if (url.pathname.startsWith(`${mount}/api/`)) return fixtureFetch(request);
    const result = await handler(request);
    if (result.status !== 404 || !["GET", "HEAD"].includes(request.method) || !url.pathname.startsWith(`${mount}/assets/`)) return result;
    const asset = await frontend.bundleStore.read(undefined, url.pathname.slice(mount.length + 1));
    if (!asset) return result;
    await result.body?.cancel();
    return new Response(asset.body, { headers: { "content-type": asset.contentType, "cache-control": asset.cacheControl } });
  } });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
  await context.addCookies([{ name: "view-session", value: "owner", url: origin }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const route = `${origin}/zelavis/projects/view-lab/database?databaseTenant=tenant-a&databaseTable=articles&databaseRow=row-a&sidebar=projects/project/database`;
  // A trackpad click often moves slightly between pointerdown and pointerup.
  // Swiper must not consume mouse clicks, even while touch swiping is disabled.
  const pointerClick = async (locator, drift) => {
    await locator.click({ trial: true, timeout: 5000 }).catch(async error => { console.error("Sidebar state:", page.url(), await page.locator("body").innerText(), "Workspace:", await page.frameLocator("iframe[data-feature-workspace]").locator("body").innerText().catch(() => "none"), "Observed:", observed); throw error; });
    const box = await locator.boundingBox(); assert.ok(box);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + drift, y);
    await page.mouse.up();
  };
  await page.goto(`${origin}/zelavis/?sidebar=`, { waitUntil: "networkidle" });
  // The sidebar is rebuilt once when the Platform's full menu arrives; interact after that.
  await page.waitForSelector(".dashboard[data-menu-ready]");
  await pointerClick(page.getByRole("link", { name: "Server", exact: true }), 1);
  await page.waitForURL(/\/zelavis\/server\?sidebar=server/, { timeout: 10000 });
  await pointerClick(page.getByRole("button", { name: "Back to Platform", exact: true }), 1);
  await page.waitForURL(/\/zelavis\/\?sidebar=$/, { timeout: 10000 });
  await page.setViewportSize({ width: 800, height: 900 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.waitForURL(/sidebarView=menu/);
  await pointerClick(page.getByRole("link", { name: "Server", exact: true }), 1);
  await page.waitForURL(/\/zelavis\/server\?sidebar=server&sidebarView=menu/, { timeout: 10000 });
  // The page finishes loading and the sidebar settles; a key pressed before that can land on a rebuilt control.
  await page.waitForSelector(".content .k-page", { state: "attached" });
  await page.getByRole("button", { name: "Back to Platform", exact: true }).press("Enter");
  await page.waitForURL(/\/zelavis\/\?sidebar=&sidebarView=menu/, { timeout: 10000 }).catch(error => { throw new Error(`${error.message} (at ${page.url()})`); });
  const touch = await context.newCDPSession(page);
  const swipe = async (startX, endX) => {
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y: 650 }] });
    for (let step = 1; step <= 8; step++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: startX + (endX - startX) * step / 8, y: 650 }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await page.getByRole("link", { name: "Server", exact: true }).click({ trial: true });
  await swipe(700, 100);
  await page.waitForURL(/sidebarView=content/, { timeout: 10000 });
  await page.getByRole("button", { name: "Back to navigation", exact: true }).click({ trial: true });
  await swipe(100, 700);
  await page.waitForURL(/sidebarView=menu/, { timeout: 10000 });
  await touch.detach();
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log("Sidebar: desktop/mobile trackpad drift and keyboard Back navigate on the first click; real touch swipes still synchronize the URL");
  const refresh = async () => {
    const before = await page.locator(".server-view-status span").innerText();
    revision++;
    await page.getByRole("button", { name: "Refresh records", exact: true }).click();
    await page.waitForFunction(before => document.querySelector(".server-view-status span")?.textContent !== before, before);
  };
  for (const library of ["glide"]) {
    await page.goto(route, { waitUntil: "networkidle" });
    await page.getByLabel("Selected record JSON").waitFor({ timeout: 10000 }).catch(async error => { console.error("Database boot:", errors, observed, (await page.locator("body").innerText()).slice(-2500)); throw error; });
    const json = page.getByLabel("Selected record JSON");
    const queryRow = await page.evaluate(() => ["grid-filter", "grid-sort"].map(name => { const box = document.querySelector(`.${name}`)?.getBoundingClientRect(); return box && { top: box.top, bottom: box.bottom, right: box.right }; }));
    assert.ok(queryRow.every(Boolean) && Math.abs(queryRow[0].top - queryRow[1].top) < 2, `Filter and sort share one desktop row: ${JSON.stringify(queryRow)}`);
    if (process.argv.includes("--screenshots") && library === "glide") await page.screenshot({ path: "/tmp/new-ui-database-query-row.png" });
    // The dropdowns are fuzor/ui selects: a styled list in place of the browser's, keyboard-operable, and still firing `change`.
    const direction = page.locator('zv-select[data-dropdown="Sort direction"]');
    await page.evaluate(() => { window.directionChanges = 0; document.querySelector('zv-select[data-dropdown="Sort direction"]').addEventListener("change", () => { window.directionChanges += 1; }); });
    await direction.locator("zv-select-trigger").click();
    await page.locator("zv-select-item", { hasText: "descending" }).waitFor({ state: "visible", timeout: 5000 });
    if (process.argv.includes("--screenshots") && library === "glide") await page.screenshot({ path: "/tmp/new-ui-dropdown-open.png" });
    if (process.argv.includes("--screenshots") && library === "glide") {
      await page.evaluate(() => { document.documentElement.dataset.dashboardTheme = "dark"; });
      await page.screenshot({ path: "/tmp/new-ui-dropdown-dark.png" });
      await page.evaluate(() => { delete document.documentElement.dataset.dashboardTheme; });
      await page.setViewportSize({ width: 390, height: 800 });
      await page.screenshot({ path: "/tmp/new-ui-dropdown-mobile.png" });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.locator("zv-select-item", { hasText: "descending" }).click();
    await page.waitForFunction(() => document.querySelector('zv-select[data-dropdown="Sort direction"] zv-select-value').textContent === "descending", null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.directionChanges), 1, "Choosing an item raises one change event");
    assert.equal(await page.evaluate(() => document.querySelector('zv-select[data-dropdown="Sort direction"]').value), "desc");
    // A dropdown inside the Create Table dialog is not clipped by the dialog's own scrolling.
    await page.goto(route + "&databaseDialog=create-table", { waitUntil: "networkidle" });
    await page.locator('zv-select[data-dropdown="Tenant"] zv-select-trigger').click();
    const choice = page.locator('zv-dialog-content zv-select-item').first();
    await choice.waitFor({ state: "visible", timeout: 5000 }).catch(async error => { await page.screenshot({ path: "/tmp/new-ui-dropdown-dialog-fail.png" }); console.error(await page.evaluate(() => { const item = document.querySelector("zv-dialog-content zv-select-item"), content = document.querySelector("zv-dialog-content zv-select-content"); return JSON.stringify({ items: document.querySelectorAll("zv-dialog-content zv-select-item").length, content: content?.outerHTML.slice(0, 300), style: item && getComputedStyle(item).display, rect: item?.getBoundingClientRect() }); })); throw error; });
    const [itemBox, dialogBox] = await Promise.all([choice.boundingBox(), page.locator("zv-dialog-content").boundingBox()]);
    assert.ok(itemBox && dialogBox && itemBox.y >= dialogBox.y && itemBox.y + itemBox.height <= dialogBox.y + dialogBox.height + 1, `Tenant choices stay visible: ${JSON.stringify({ itemBox, dialogBox })}`);
    if (process.argv.includes("--screenshots") && library === "glide") await page.screenshot({ path: "/tmp/new-ui-dropdown-dialog.png" });
    await page.goto(route, { waitUntil: "networkidle" });
    await json.fill(JSON.stringify({ title: `Utility draft ${library}` }));
    const switches = page.getByRole("navigation", { name: "Sidebar view switches" });
    const footerBoxes = await switches.getByRole("button").evaluateAll(buttons => buttons.map(button => ({ top: button.getBoundingClientRect().top, width: button.getBoundingClientRect().width })));
    assert.equal(footerBoxes.length, 5);
    assert.ok(footerBoxes.every(box => Math.abs(box.top - footerBoxes[0].top) < 1 && box.width > 30), "Five usable footer controls share one horizontal row");
    await page.evaluate(() => { window.utilityInput = document.querySelector('[aria-label="Selected record JSON"]'); });
    await switches.getByRole("button", { name: "Account", exact: true }).click();
    await page.getByText("Owner dashboard", { exact: true }).waitFor();
    if (process.argv.includes("--screenshots") && library === "glide") await page.screenshot({ path: "/tmp/new-ui-sidebar-account.png" });
    await page.getByRole("button", { name: "Settings ›", exact: true }).click();
    await page.getByRole("link", { name: "Global settings", exact: true }).waitFor();
    await page.goBack();
    await page.getByText("Owner dashboard", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Settings ›", exact: true }).click();
    await page.getByRole("button", { name: "Language ›", exact: true }).click();
    await page.getByRole("button", { name: "Deutsch (Deutschland)", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Deutsch (Deutschland)", exact: true }).getAttribute("aria-pressed"), "true");
    await switches.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search Zelavis" }).fill("laboratory");
    await page.getByRole("link", { name: "View laboratory", exact: true }).waitFor();
    assert.equal(await page.locator(".sidebar-utilities").getByRole("link").count(), 1);
    await switches.getByRole("button", { name: "Notifications", exact: true }).click();
    await page.getByRole("link", { name: "Security checklist", exact: true }).waitFor();
    await switches.getByRole("button", { name: "Assistant", exact: true }).click();
    assert.match(await page.getByRole("link", { name: "Open chat", exact: true }).getAttribute("href"), /project=view-lab/);
    await page.locator(".sidebar-utilities").getByRole("button", { name: "Back to navigation", exact: true }).click();
    assert.ok(await page.evaluate(() => window.utilityInput === document.querySelector('[aria-label="Selected record JSON"]')), `${library}: utilities retain input identity`);
    assert.equal(JSON.parse(await json.inputValue()).title, `Utility draft ${library}`);
    const first = JSON.parse(await json.inputValue());
    await json.fill(JSON.stringify({ ...first, title: `Unsaved ${library}` }, null, 2));
    await page.evaluate(() => { const swiper = document.querySelector("swiper-container"); window.viewIdentity = { input: document.querySelector('[aria-label="Selected record JSON"]'), client: document.querySelector("fuzor-client[data-fuzor-component]"), swiper, index: swiper.swiper.activeIndex, grid: document.querySelector(".database-grid").firstElementChild }; });
    await refresh();
    assert.equal(JSON.parse(await json.inputValue()).title, `Unsaved ${library}`);
    assert.ok(await page.evaluate(() => { const id = window.viewIdentity; return id.input === document.querySelector('[aria-label="Selected record JSON"]') && id.client === document.querySelector("fuzor-client[data-fuzor-component]") && id.swiper === document.querySelector("swiper-container") && id.index === id.swiper.swiper.activeIndex && id.grid === document.querySelector(".database-grid").firstElementChild; }), `${library}: state and DOM owners retained`);
    await page.getByRole("button", { name: "Stage record JSON", exact: true }).click();
    await refresh();
    assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).isEnabled(), true);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByLabel("Selected record JSON").waitFor();
    assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, `Unsaved ${library}`);
    assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).isEnabled(), true);
    denySave = true;
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByText(/Save stopped; remaining drafts are retained/).waitFor();
    denySave = false;
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByText("1 record saved.", { exact: true }).waitFor();
    assert.equal(documents[0].data.title, `Unsaved ${library}`);
    console.log(`${library}: retained grid/inspector/sidebar and draft; failed save retained draft; retry persisted it`);
  }
  assert.equal(saved, 1);
  await page.evaluate(() => { window.viewIdentity = { swiper: document.querySelector("swiper-container"), client: document.querySelector("fuzor-client[data-fuzor-component]") }; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Selected record JSON").fill('{"title":"Mobile draft"}');
  const mobileSwitches = page.getByRole("navigation", { name: "Sidebar view switches" });
  await mobileSwitches.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Settings ›", exact: true }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Global settings", exact: true }).waitFor();
  if (process.argv.includes("--screenshots")) await page.screenshot({ path: "/tmp/new-ui-sidebar-mobile-settings.png" });
  await page.locator(".sidebar-utilities").getByRole("button", { name: "Back to Account", exact: true }).click();
  await page.locator(".sidebar-utilities").getByRole("button", { name: "Back to navigation", exact: true }).click();
  await page.getByLabel("Selected record JSON").waitFor({ state: "visible" });
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, "Mobile draft");
  await page.evaluate(() => { window.viewIdentity = { swiper: document.querySelector("swiper-container"), client: document.querySelector("fuzor-client[data-fuzor-component]") }; });

  await mobileSwitches.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.waitForURL(url => url.searchParams.get("sidebarView") === "menu" && !url.searchParams.has("sidebarUtility"));
  await page.goBack();
  await page.getByRole("button", { name: "Log out", exact: true }).waitFor();
  await page.goBack();
  await page.getByLabel("Selected record JSON").waitFor({ state: "visible" });
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, "Mobile draft");
  assert.ok(await page.evaluate(() => window.viewIdentity.swiper === document.querySelector("swiper-container") && window.viewIdentity.client === document.querySelector("fuzor-client[data-fuzor-component]")));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Selected record JSON").waitFor({ state: "visible" });
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, "Mobile draft");
  await refresh();
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, "Mobile draft", "Restored unstaged text survives another server update");
  assert.ok(observed.some(entry => entry.path.includes("/projects/view-lab/proxy/") && entry.cookie.includes("view-session=owner")));
  const foreign = await context.request.get(route.replace("tenant-a", "foreign")); assert.ok((await foreign.text()).includes("Database request failed (403)"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Feature workspaces now use their original React route modules. Their real
  // actions, protected navigation and settings are qualified in test-route-parity.
  // Keep this fixture focused on native Fuzor grids, sidebar state and SDK grants.
  for (const [path, target] of [["/fixture/page", `${api}/plugins/fixture/ping`], ["/projects/view-lab/fixture/page", `${proxy}/plugins/fixture/ping`]]) {
    await page.goto(`${origin}/zelavis${path}`, { waitUntil: "networkidle" });
    const iframe = page.locator('iframe[title="Fixture page"]'); await iframe.waitFor();
    assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts allow-forms");
    const frame = await (await iframe.elementHandle()).contentFrame();
    assert.ok(await frame.evaluate(() => { try { void parent.document.body; return false; } catch { return true; } }), "Sandboxed page cannot read dashboard DOM");
    const response = await frame.evaluate(() => new Promise(resolve => { const receive = event => { if (event.data.zelavis === "service-page-response" && event.data.id === "ping") { removeEventListener("message", receive); resolve(event.data); } }; addEventListener("message", receive); parent.postMessage({ zelavis: "service-page-request", id: "ping", path: "/ping" }, "*"); }));
    assert.equal(response.body.target, target); assert.equal(response.status, 200);
    const forbidden = await frame.evaluate(() => new Promise(resolve => { const receive = event => { if (event.data.zelavis === "service-page-response" && event.data.id === "escape") { removeEventListener("message", receive); resolve(event.data); } }; addEventListener("message", receive); parent.postMessage({ zelavis: "service-page-request", id: "escape", path: "../runtime/access" }, "*"); }));
    assert.match(forbidden.error, /own API/);
    await page.reload({ waitUntil: "networkidle" }); await page.locator('iframe[title="Fixture page"]').waitFor();
  }
  await page.goto(route + "&databasePanel=schema", { waitUntil: "networkidle" });
  await page.getByLabel("Schema fields JSON").waitFor();
  const fieldName = page.getByLabel("Field name", { exact: true }); await fieldName.fill("published");
  await page.getByLabel("Field label", { exact: true }).fill("Published");
  await page.getByLabel("Field type", { exact: true }).click();
  await page.locator("zv-select-item", { hasText: "Boolean" }).click();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByRole("button", { name: "Refresh records", exact: true }).click();
  await page.getByText("published · BooleanField", { exact: false }).waitFor();
  await page.reload({ waitUntil: "networkidle" }); await page.getByLabel("Schema fields JSON").waitFor();
  assert.equal(JSON.parse(await page.getByLabel("Schema fields JSON").inputValue()).at(-1).name, "published");
  await page.getByRole("button", { name: "Save and activate new schema version", exact: true }).click();
  await page.locator("zv-select-item", { hasText: "v2 · active" }).waitFor({ state: "attached" });
  assert.equal(schemas.at(-1).fields.at(-1).name, "published");
  await page.getByRole("button", { name: "Records", exact: true }).click();
  await page.getByLabel("Article title", { exact: true }).waitFor();
  await page.getByLabel("Article title", { exact: true }).fill("Typed draft");
  await page.getByLabel("Published", { exact: true }).check();
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).published, true);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Article title", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Article title", { exact: true }).inputValue(), "Typed draft");
  assert.equal(await page.getByLabel("Published", { exact: true }).isChecked(), true);
  await page.getByRole("button", { name: "Stage record JSON", exact: true }).click();
  await page.getByLabel("Article title", { exact: true }).fill("Later unstaged draft");
  const firstSave = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/documents/articles/row-a"));
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); assert.equal((await firstSave).status(), 200);
  await page.getByText("1 record saved.", { exact: true }).waitFor();
  assert.equal(documents[0].data.title, "Typed draft");
  assert.equal(await page.getByLabel("Article title", { exact: true }).inputValue(), "Later unstaged draft");
  await page.getByRole("button", { name: "Stage record JSON", exact: true }).click();
  const secondSave = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/documents/articles/row-a"));
  await page.getByRole("button", { name: "Save changes", exact: true }).click(); assert.equal((await secondSave).status(), 200);
  assert.equal(documents[0].data.title, "Later unstaged draft");
  await page.getByText("1 record saved.", { exact: true }).waitFor();
  await page.getByLabel("Article title", { exact: true }).fill("Discard me");
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  assert.equal(await page.getByLabel("Article title", { exact: true }).inputValue(), "Later unstaged draft");
  console.log("Sandboxed service pages and broker grants in both scopes, schema versions and typed draft reload recovery passed.");
  await page.getByRole("navigation", { name: "Sidebar view switches" }).getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.waitForURL(/\/zelavis\/login/);
  assert.ok(signedOut, "Account logout calls the existing session endpoint");
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("zelavis:new-ui:drafts:1:")).length), 0, "Logout clears tab draft journals");
  console.log("Sidebar utilities: five footer switches, project search/chat links, Account/Settings/Language, desktop input identity, mobile reload/Back and logout passed.");
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Generated SSR registry, project proxy authorization, and the Glide grid adapter passed against the isolated API fixture.");
} finally {
  await browser?.close(); if (app) await closeNodeServer(app);
  await new Promise(resolve => upstream.close(resolve));
  if (previous === undefined) delete process.env.ZELAVIS_DEV_SERVER; else process.env.ZELAVIS_DEV_SERVER = previous;
}
