import "./link-local.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { createNodeServer, closeNodeServer } from "fuzor/server/node";
import { packageRoot } from "./link-local.mjs";
import { resolve } from "node:path";

let revision = 1, saved = 0, denySave = false;
const documents = [{ id: "row-a", version: 1, data: { title: "Server A", count: 1, "literal.key": true, ["__proto__"]: { independent: true }, constructor: "database field" } }, { id: "row-b", version: 1, data: { title: "Server B", count: 2 } }];
const project = { id: "view-lab", name: "View laboratory", recipe: { name: "@zelavis/app" }, runtime: { status: "running" } };
const api = "/zelavis/api/v1", proxy = `${api}/runtime/projects/view-lab/proxy${api}`;
const config = { rootPath: "/zelavis", api: { basePath: api }, capabilities: { database: { available: true, used: true } } };
const observed = [];
const upstream = createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  const send = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === `${api}/runtime/config` || path === `${proxy}/runtime/config`) return send(config);
  if (path === `${api}/auth/bootstrap`) return send({ required: false, providers: ["password"], enrollmentProviders: [] });
  if (!req.headers.cookie?.includes("view-session=owner")) return send({ error: "Unauthorized" }, 401);
  observed.push({ path, cookie: req.headers.cookie });
  if (path === `${api}/runtime/access`) return send({ user: { id: "owner" } });
  if (path === `${api}/runtime/projects`) return send({ projects: [project] });
  if (path === `${proxy}/database/menu/tables`) return send({ items: [{ title: "Articles", search: { databaseTenant: "tenant-a", databaseTable: "articles" } }] });
  let text = ""; for await (const chunk of req) text += chunk; const body = text ? JSON.parse(text) : {};
  if (body.tenantId && body.tenantId !== "tenant-a") return send({ error: "Forbidden tenant" }, 403);
  if (path === `${proxy}/database/documents/articles/query`) return send({ documents: documents.map(row => ({ ...row, data: { ...row.data, revision } })) });
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
  const { handler } = await import(new URL("../dist-spa-server/server/entry.mjs", import.meta.url));
  app = createNodeServer({ assetsDir: resolve(packageRoot, "dist-spa-server/client"), base: "/zelavis/", handler: async request => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/zelavis/api/")) {
      const headers = new Headers(request.headers); headers.set("origin", upstreamOrigin);
      return fetch(new URL(url.pathname + url.search, upstreamOrigin), { method: request.method, headers, signal: request.signal, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }) });
    }
    return handler(request);
  } });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "view-session", value: "owner", url: origin }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const route = `${origin}/zelavis/projects/view-lab/database?databaseTenant=tenant-a&databaseTable=articles&databaseRow=row-a&sidebar=projects/project/database`;
  const refresh = async () => {
    const before = await page.locator(".server-view-status span").innerText();
    revision++;
    await page.getByRole("button", { name: "Refresh records", exact: true }).click();
    await page.waitForFunction(before => document.querySelector(".server-view-status span")?.textContent !== before, before);
  };
  for (const library of ["tabulator", "vtable", "glide"]) {
    await page.goto(route + `&grid=${library}`, { waitUntil: "networkidle" });
    await page.getByLabel("Selected record JSON").waitFor();
    const json = page.getByLabel("Selected record JSON");
    const first = JSON.parse(await json.inputValue());
    await json.fill(JSON.stringify({ ...first, title: `Unsaved ${library}` }, null, 2));
    await page.evaluate(() => { const swiper = document.querySelector("swiper-container"); window.viewIdentity = { input: document.querySelector('[aria-label="Selected record JSON"]'), client: document.querySelector("fuzor-island[data-fuzor-component]"), swiper, index: swiper.swiper.activeIndex, grid: document.querySelector(".database-grid").firstElementChild }; });
    await refresh();
    assert.equal(JSON.parse(await json.inputValue()).title, `Unsaved ${library}`);
    assert.ok(await page.evaluate(() => { const id = window.viewIdentity; return id.input === document.querySelector('[aria-label="Selected record JSON"]') && id.client === document.querySelector("fuzor-island[data-fuzor-component]") && id.swiper === document.querySelector("swiper-container") && id.index === id.swiper.swiper.activeIndex && id.grid === document.querySelector(".database-grid").firstElementChild; }), `${library}: state and DOM owners retained`);
    await page.getByRole("button", { name: "Stage record JSON", exact: true }).click();
    await refresh();
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
  assert.equal(saved, 3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Selected record JSON").fill('{"title":"Mobile draft"}');
  await page.getByRole("button", { name: "Back to navigation", exact: true }).click();
  await page.waitForURL(/sidebarView=menu/);
  await page.goBack();
  await page.getByLabel("Selected record JSON").waitFor({ state: "visible" });
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, "Mobile draft");
  assert.ok(await page.evaluate(() => window.viewIdentity.swiper === document.querySelector("swiper-container") && window.viewIdentity.client === document.querySelector("fuzor-island[data-fuzor-component]")));
  assert.ok(observed.some(entry => entry.path.includes("/projects/view-lab/proxy/") && entry.cookie.includes("view-session=owner")));
  const foreign = await context.request.get(route.replace("tenant-a", "foreign")); assert.ok((await foreign.text()).includes("Database request failed (403)"));
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Generated SSR registry, project proxy authorization, and all three MIT grid adapters passed against the isolated API fixture.");
} finally {
  await browser?.close(); if (app) await closeNodeServer(app);
  await new Promise(resolve => upstream.close(resolve));
  if (previous === undefined) delete process.env.ZELAVIS_DEV_SERVER; else process.env.ZELAVIS_DEV_SERVER = previous;
}
