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
const marketplaceFixtures = [
  { name: "@fixture/app", version: "1.0.0", kind: "app", scope: "system", status: "installed", marketplace: { title: "Fixture App" } },
  { name: "@fixture/plugin", version: "1.2.3", kind: "plugin", scope: "extension", status: "available", installVia: "acquire", marketplace: { title: "Fixture Plugin" } },
  { name: "@fixture/theme", version: "1.0.0", kind: "frontend", scope: "extension", status: "available", installVia: "acquire", marketplace: { title: "Fixture Frontend" } }
];
config.serviceRegistry.push(...marketplaceFixtures.map(service => structuredClone(service)));
const projectRegistry = config.serviceRegistry.map(service => structuredClone(service));
const observed = [];
const installs = new Set(); let approvalDecisions = 0, uploaded = false, signedOut = false;
const thread = { id: "thread-1", title: "Qualification", messages: [{ id: "reply-1", role: "assistant", content: "![untrusted image](https://example.test/image.png)" }] };
const approval = { id: "approval-1", label: "Delete Project", target: { kind: "project", id: "view-lab" }, irreversible: true, status: "pending" };

const upstream = createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  const send = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === `${api}/runtime/config`) return send(config);
  if (path === `${proxy}/runtime/config`) return send({ ...config, serviceRegistry: projectRegistry });
  if (path === `${api}/auth/bootstrap`) return send({ available: true, required: false, providers: ["password"], enrollmentProviders: [] });
  if (path === `${api}/auth/registration`) return send({ enabled: false, providers: [] });
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
    if (req.method === "POST") {
      assert.equal(body.packageSource, "npm:@fixture/plugin@1.2.3"); installs.add(path);
      const inventory = path.startsWith(proxy) ? projectRegistry : config.serviceRegistry;
      inventory.find(service => service.name === "@fixture/plugin").status = "installed";
    }
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
  // Native refresh must retain a real frame before either application code or startup data is ready.
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const noJs = await browser.newPage({ javaScriptEnabled: false, viewport });
    await noJs.goto(`${origin}/zelavis/marketplace`, { waitUntil: "load" });
    assert.ok(await noJs.locator(".header").isVisible(), "the document supplies the header without JavaScript");
    assert.ok(await noJs.locator("#workspace").isVisible(), "the document supplies the workspace without JavaScript");
    assert.ok(await noJs.locator("[data-shell-footer]").isVisible(), "the document supplies the footer without JavaScript");
    assert.equal((await noJs.locator("body").innerText()).includes("Connecting to Zelavis"), false);
    await noJs.close();
    const startup = await context.newPage(), startupErrors = [];
    startup.on("pageerror", error => startupErrors.push(error.message));
    await startup.setViewportSize(viewport);
    await startup.goto(`${origin}/zelavis/marketplace`, { waitUntil: "networkidle" });
    await startup.getByRole("tab", { name: /^Apps/ }).waitFor();
    await startup.addInitScript(() => {
      localStorage.setItem("theme", "dark");
      const capture = () => {
        const selectors = ["#dashboard-shell", ".header", ".main", "#dashboard-navigation", "#workspace", "[data-shell-footer]"];
        const nodes = selectors.map(selector => document.querySelector(selector));
        if (nodes.every(Boolean) && !window.startupShell) window.startupShell = { selectors, nodes, detached: false };
        if (window.startupShell && window.startupShell.nodes.some(node => !node.isConnected)) window.startupShell.detached = true;
      };
      new MutationObserver(capture).observe(document, { childList: true, subtree: true });
      capture();
    });
    let releaseScripts, releaseData, blockedScripts = 0, blockedData = 0;
    const scriptGate = new Promise(resolve => { releaseScripts = resolve; });
    const dataGate = new Promise(resolve => { releaseData = resolve; });
    await startup.route("**/*", async route => {
      const request = route.request();
      if (request.resourceType() === "script") { blockedScripts++; await scriptGate; }
      else if (request.url().includes("/api/v1/runtime/config") || request.url().includes("/api/v1/auth/bootstrap")) { blockedData++; await dataGate; }
      await route.continue();
    });
    try {
      await startup.reload({ waitUntil: "commit" });
      await startup.locator(".header").waitFor({ state: "visible" });
      await startup.waitForFunction(() => Boolean(window.startupShell));
      const header = await startup.locator(".header").boundingBox();
      const footer = await startup.locator("[data-shell-footer]").boundingBox();
      const workspace = await startup.locator("#workspace").boundingBox();
      assert.ok(blockedScripts > 0, "the application scripts are actually held");
      assert.ok(await startup.locator("[data-screen-content] .shell-workspace-pending").isVisible());
      assert.equal(await startup.locator("html").getAttribute("data-dashboard-theme"), "dark", "saved appearance applies before application startup");
      releaseScripts();
      await startup.waitForFunction(() => document.querySelector("#dashboard-shell")?.classList.contains("dashboard-starting"));
      for (let attempt = 0; blockedData === 0 && attempt < 750; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(blockedData > 0, "startup data is actually held after the scripts load");
      assert.ok(await startup.locator(".header").isVisible());
      assert.ok(await startup.locator("#workspace").isVisible());
      assert.ok(await startup.locator("[data-shell-footer]").isVisible());
      assert.equal(await startup.getByRole("heading", { name: "Fixture App", exact: true }).count(), 0, "private workspace data has not appeared while startup is held");
      releaseData();
      await startup.getByRole("tab", { name: /^Apps/ }).waitFor();
      await startup.waitForFunction(() => !document.querySelector("#dashboard-shell")?.classList.contains("dashboard-starting"));
      assert.ok(await startup.evaluate(() => !window.startupShell.detached && window.startupShell.nodes.every((node, index) => node === document.querySelector(window.startupShell.selectors[index]))), "startup adopts every frame node from the document");
      const nextHeader = await startup.locator(".header").boundingBox(), nextFooter = await startup.locator("[data-shell-footer]").boundingBox();
      for (const key of ["x", "y", "width", "height"]) {
        assert.ok(Math.abs(header[key] - nextHeader[key]) < 1, `header ${key} stays stable through startup`);
        assert.ok(Math.abs(footer[key] - nextFooter[key]) < 1, `footer ${key} stays stable through startup: ${JSON.stringify(footer)} -> ${JSON.stringify(nextFooter)}`);
      }
      const nextWorkspace = await startup.locator("#workspace").boundingBox();
      for (const key of ["x", "y", "width"]) assert.ok(Math.abs(workspace[key] - nextWorkspace[key]) < 1, `workspace ${key} stays stable through startup: ${JSON.stringify(workspace)} -> ${JSON.stringify(nextWorkspace)}`);
      assert.equal((await startup.locator("body").innerText()).includes("Connecting to Zelavis"), false);
      assert.deepEqual(startupErrors, [], "shell adoption raises no browser errors");
      await startup.evaluate(() => localStorage.removeItem("theme"));
    } finally { releaseScripts(); releaseData(); await startup.close(); }
  }
  console.log("Static shell: desktop/mobile HTML frame without JavaScript, native refresh with held scripts/data, prepaint appearance and retained frame geometry passed.");
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/zelavis/marketplace?sidebarView=content`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /^Apps/ }).waitFor();
    const workspace = page.locator("#workspace");
    await workspace.evaluate(element => {
      const spacer = document.createElement("div");
      spacer.style.height = "1600px";
      element.append(spacer);
    });
    const header = page.locator(".header");
    const headerTop = (await header.boundingBox()).y;
    const bounds = await workspace.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 650);
    await page.waitForFunction(() => document.querySelector("#workspace").scrollTop > 0);
    await page.mouse.wheel(-650, 2500);
    await page.waitForFunction(() => {
      const workspace = document.querySelector("#workspace");
      return workspace.scrollTop + workspace.clientHeight >= workspace.scrollHeight - 1;
    });
    assert.equal((await header.boundingBox()).y, headerTop);
    assert.deepEqual(await page.evaluate(() => ({
      x: window.scrollX, y: window.scrollY,
      width: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      overscroll: getComputedStyle(document.documentElement).overscrollBehavior,
    })), { x: 0, y: 0, width: 0, height: 0, overscroll: "none" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log("Workspace: native content scrolls inside a fixed desktop and mobile shell.");
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
  await page.goto(`${origin}/zelavis/`, { waitUntil: "networkidle" });
  // The sidebar is rebuilt once when the Platform's full menu arrives; interact after that.
  await page.waitForSelector(".dashboard[data-menu-ready]");
  await pointerClick(page.getByRole("link", { name: "Server", exact: true }), 1);
  await page.waitForURL(/\/zelavis\/server\?sidebar=server/, { timeout: 10000 });
  await pointerClick(page.getByRole("button", { name: "Back to Platform", exact: true }), 1);
  await page.waitForURL(/\/zelavis\/$/, { timeout: 10000 });
  await page.setViewportSize({ width: 800, height: 900 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.waitForURL(/sidebarView=menu/);
  await pointerClick(page.getByRole("link", { name: "Server", exact: true }), 1);
  await page.waitForURL(/\/zelavis\/server\?sidebar=server&sidebarView=menu/, { timeout: 10000 });
  // The page finishes loading and the sidebar settles; a key pressed before that can land on a rebuilt control.
  await page.waitForSelector(".content .k-page", { state: "attached" });
  await page.getByRole("button", { name: "Back to Platform", exact: true }).press("Enter");
  await page.waitForURL(/\/zelavis\/\?sidebarView=menu$/, { timeout: 10000 }).catch(error => { throw new Error(`${error.message} (at ${page.url()})`); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".dashboard[data-menu-ready]");
  assert.equal(new URL(page.url()).searchParams.has("sidebar"), false, "mobile root reload needs no empty trail");
  await page.getByRole("link", { name: "Server", exact: true }).click();
  await page.waitForURL(/sidebar=server/);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.waitForURL(/\/zelavis\/\?sidebarView=menu$/);
  await page.getByRole("link", { name: "Server", exact: true }).click({ trial: true });
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
  for (const viewport of [{ width: 1440, height: 360 }, { width: 390, height: 360 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/zelavis/server?sidebar=server&sidebarView=menu`, { waitUntil: "networkidle" });
    const rail = page.locator("#dashboard-navigation");
    const menu = rail.locator('swiper-container[aria-label="Platform navigation"] .navigation-panel[aria-hidden="false"]');
    await menu.getByRole("navigation", { name: "Server navigation" }).waitFor();
    const assertScrollport = async panel => {
      const geometry = await panel.evaluate(element => {
        const aside = element.closest("aside");
        const sidebar = aside.getBoundingClientRect(), scrollport = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          edge: sidebar.right - parseFloat(getComputedStyle(aside).borderRightWidth) - scrollport.right,
          inset: parseFloat(style.paddingInlineEnd),
          thumb: getComputedStyle(element, "::-webkit-scrollbar").width,
          thumbColor: getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor,
          overflow: element.scrollHeight - element.clientHeight,
        };
      });
      assert.ok(Math.abs(geometry.edge) < 1, "the sidebar scrollport ends at its divider");
      assert.ok(geometry.inset >= 14 && geometry.overflow > 0, "inset content overflows within the sidebar");
      assert.equal(geometry.thumb, "3px");
      return geometry.thumbColor;
    };
    await page.locator("html").evaluate(root => { root.dataset.dashboardTheme = "light"; });
    assert.equal(await assertScrollport(menu), "rgb(201, 201, 201)");
    const menuBounds = await menu.boundingBox();
    const footer = rail.locator(".sidebar-switches");
    const footerTop = (await footer.boundingBox()).y;
    await page.mouse.move(menuBounds.x + 30, menuBounds.y + menuBounds.height / 2);
    await page.mouse.wheel(0, 160);
    await page.waitForFunction(() =>
      document.querySelector('#dashboard-navigation swiper-container[aria-label="Platform navigation"] .navigation-panel[aria-hidden="false"]')?.scrollTop > 0);
    assert.equal((await footer.boundingBox()).y, footerTop, "sidebar footer stays fixed when the menu scrolls");
    await page.mouse.move(viewport.width - 5, 5);
    await page.locator("html").evaluate(root => { root.dataset.dashboardTheme = "dark"; });
    assert.equal(await assertScrollport(menu), "rgb(90, 90, 96)");
    await footer.getByRole("button", { name: "Account", exact: true }).click();
    const utility = rail.locator('.sidebar-utilities .utility-panel[aria-hidden="false"]');
    await utility.getByRole("button", { name: "Log out", exact: true }).waitFor({ state: "attached" });
    await assertScrollport(utility);
    await page.locator("html").evaluate(root => { root.dataset.dashboardTheme = "light"; });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log("Sidebar: the menu and utility scrollports reach the edge with a 3px thumb in both themes.");

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/zelavis/server/resources`, { waitUntil: "networkidle" });
    await page.locator(".content .actions").getByRole("button", { name: "Overview", exact: true }).waitFor();
    const accessReads = observed.filter(entry => entry.path === `${api}/runtime/access`).length;
    await page.evaluate(() => {
      window.resourceTabs = [...document.querySelectorAll(".content .actions button")];
      window.resourcePage = window.resourceTabs[0].closest(".k-page");
      window.resourceRemoved = [];
      window.resourceObserver = new MutationObserver(records => {
        for (const record of records) for (const node of record.removedNodes) {
          if (node === window.resourcePage || window.resourceTabs.some(tab => node === tab || node.contains(tab))) window.resourceRemoved.push(node.nodeName);
        }
      });
      window.resourceObserver.observe(document.querySelector(".content"), { childList: true, subtree: true });
    });
    for (const [title, view] of [["Processes", "processes"], ["Storage", "storage"], ["Limits", "limits"], ["Overview", ""]]) {
      const tab = page.locator(".content .actions").getByRole("button", { name: title, exact: true });
      await tab.click();
      await page.waitForURL(url => (url.searchParams.get("resourceView") ?? "") === view);
      await page.waitForFunction(title => [...document.querySelectorAll(".content .actions button")].some(button => button.textContent === title && button.getAttribute("aria-pressed") === "true"), title);
      assert.ok(await page.evaluate(() => window.resourceTabs.every(tab => tab.isConnected && document.querySelector(".content").contains(tab))), `${title}: tab buttons retain their DOM identity`);
      assert.equal(await tab.evaluate(tab => tab === document.activeElement), true, `${title}: focus stays on the clicked tab`);
      assert.deepEqual(await page.locator(".content .k-page h2:visible").allTextContents(), title === "Overview" ? ["Processes", "Limits"] : [title], `${title}: only the selected view panels are visible`);
      assert.deepEqual(await page.evaluate(() => window.resourceRemoved), [], `${title}: navigation never removes the page or its buttons`);
    }
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.content .actions button[aria-pressed="true"]')?.textContent === "Limits");
    await page.goForward();
    await page.waitForFunction(() => document.querySelector('.content .actions button[aria-pressed="true"]')?.textContent === "Overview");
    assert.ok(await page.evaluate(() => window.resourceTabs.every(tab => tab.isConnected)));
    await page.evaluate(() => window.resourceObserver.disconnect());
    assert.equal(observed.filter(entry => entry.path === `${api}/runtime/access`).length, accessReads, "local view navigation never re-runs the screen loader");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/zelavis/server/resources?resourceView=storage`, { waitUntil: "networkidle" });
  await page.locator(".content .actions").getByRole("button", { name: "Storage", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.content .actions button[aria-pressed="true"]')?.textContent === "Storage");
  const accessBeforeDataQuery = observed.filter(entry => entry.path === `${api}/runtime/access`).length;
  await page.evaluate(() => {
    const link = Object.assign(document.createElement("a"), { id: "fixture-data-query", href: "?resourceView=storage&dataPage=2", textContent: "Fixture data query" });
    document.querySelector(".content .k-page").append(link);
  });
  await page.locator("#fixture-data-query").click();
  await page.waitForURL(/dataPage=2/);
  await page.waitForFunction(() => !document.querySelector("#fixture-data-query") && document.querySelector('.content .actions button[aria-pressed="true"]')?.textContent === "Storage");
  assert.ok(observed.filter(entry => entry.path === `${api}/runtime/access`).length > accessBeforeDataQuery, "an undeclared data query still reloads and revalidates access");
  console.log("Resources: framework-owned desktop/mobile view retention, uninterrupted focus, deep links and Back/Forward passed; data queries still reload and revalidate access.");
  await page.goto(route, { waitUntil: "networkidle" });
  for (const projectScope of [false, true]) {
    const path = projectScope ? "/projects/view-lab/marketplace" : "/marketplace";
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/zelavis${path}`, { waitUntil: "networkidle" });
      const tabs = page.getByRole("tablist", { name: "Marketplace sections" });
      await tabs.getByRole("tab", { name: /^Apps/ }).waitFor();
      assert.equal(await tabs.getByRole("tab", { name: /^Frontends/ }).getAttribute("aria-disabled"), projectScope ? null : "true");
      const accessReads = observed.filter(entry => entry.path === `${api}/runtime/access`).length;
      await page.getByLabel("Search the marketplace", { exact: true }).fill("Unsubmitted draft");
      await page.evaluate(() => {
        window.marketplaceRefs = [...document.querySelectorAll('.content [role="tab"], .content input[type="search"], .content .k-page')];
        window.marketplaceRemoved = [];
        window.marketplaceObserver = new MutationObserver(records => {
          for (const record of records) for (const node of record.removedNodes) if (window.marketplaceRefs.some(ref => node === ref || node.contains(ref))) window.marketplaceRemoved.push(node.nodeName);
        });
        window.marketplaceObserver.observe(document.querySelector(".content"), { childList: true, subtree: true });
      });
      for (const title of projectScope ? ["Plugins", "Frontends", "Apps"] : ["Plugins", "Apps"]) {
        const tab = tabs.getByRole("tab", { name: new RegExp(`^${title}`) });
        await tab.click();
        await page.waitForURL(url => (url.searchParams.get("tab") ?? "apps") === title.toLowerCase());
        await page.waitForFunction(title => [...document.querySelectorAll('.content [role="tab"]')].some(tab => tab.textContent.startsWith(title) && tab.getAttribute("aria-selected") === "true"), title);
        assert.ok(await page.evaluate(() => window.marketplaceRefs.every(ref => ref.isConnected)), `${path}: ${title} retains the toolbar, tabs and page`);
        assert.deepEqual(await page.evaluate(() => window.marketplaceRemoved), [], `${path}: no loading/rebuild while switching ${title}`);
        assert.equal(await tab.evaluate(tab => document.activeElement === tab), true, `${path}: ${title} keeps focus`);
        assert.equal(await page.getByLabel("Search the marketplace", { exact: true }).inputValue(), "Unsubmitted draft");
        assert.equal(await page.getByRole("list", { name: title, exact: true }).count(), 1);
      }
      await page.goBack();
      const backTo = projectScope ? "Frontends" : "Plugins";
      await page.waitForFunction(title => [...document.querySelectorAll('.content [role="tab"]')].some(tab => tab.textContent.startsWith(title) && tab.getAttribute("aria-selected") === "true"), backTo);
      await page.goForward();
      await page.waitForFunction(() => [...document.querySelectorAll('.content [role="tab"]')].some(tab => tab.textContent.startsWith("Apps") && tab.getAttribute("aria-selected") === "true"));
      assert.equal(observed.filter(entry => entry.path === `${api}/runtime/access`).length, accessReads, "Marketplace tab switches stay local");
      await page.evaluate(() => window.marketplaceObserver.disconnect());
      await page.getByRole("list", { name: "Apps", exact: true }).getByRole("button", { name: "Create project", exact: true }).click();
      await page.getByLabel("Project name", { exact: true }).fill("Retained project draft");
      await tabs.getByRole("tab", { name: /^Plugins/ }).click();
      await tabs.getByRole("tab", { name: /^Apps/ }).click();
      assert.equal(await page.getByLabel("Project name", { exact: true }).inputValue(), "Retained project draft");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/zelavis${path}?tab=plugins`, { waitUntil: "networkidle" });
    const plugins = page.getByRole("list", { name: "Plugins", exact: true });
    await plugins.getByRole("button", { name: "Install", exact: true }).click();
    await plugins.getByText("Installed", { exact: true }).waitFor();
    assert.ok(installs.has(`${projectScope ? proxy : api}/runtime/services`), "retained Marketplace actions use their exact scope");
  }
  console.log("Marketplace: platform/project tabs retain DOM, focus, search and create drafts on desktop/mobile; Back/Forward, deep links and scoped installs passed.");
  // Keep this inventory and its mutations local to Marketplace qualification.
  config.serviceRegistry.splice(1); projectRegistry.splice(1); installs.clear();
  await page.goto(route, { waitUntil: "networkidle" });
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
    // The dropdown is form-associated: a real browser's FormData sees its value, with no hidden native control behind it.
    const submitted = await page.evaluate(() => ({ tenant: new FormData(document.querySelector("zv-dialog-content form")).get("tenantId"), hidden: document.querySelectorAll('zv-select[data-dropdown="Tenant"] select').length }));
    assert.deepEqual(submitted, { tenant: "tenant-a", hidden: 0 });
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
