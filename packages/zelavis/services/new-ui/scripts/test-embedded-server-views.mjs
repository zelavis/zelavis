import "./link-local.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { packageRoot } from "./link-local.mjs";
import { createServer as createViteServer } from "vite";

const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`, api = `${origin}/zelavis/api/v1`;
const data = await mkdtemp(join(tmpdir(), "zelavis-view-platform-"));
const token = randomBytes(32).toString("base64url"), password = randomBytes(32).toString("base64url");
const child = spawn(process.execPath, ["scripts/runtime.ts"], { cwd: packageRoot, env: { ...process.env, PORT: String(port), ZELAVIS_TEST_FRONTEND: "fuzor", ZELAVIS_DEV_SERVER: origin, ZELAVIS_UI_DEV_SERVER: "", ZELAVIS_DATA_DIR: data, ZELAVIS_BOOTSTRAP_TOKEN: token, ZELAVIS_GITHUB_MAINTENANCE: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser, dev;
const previousOrigin = process.env.ZELAVIS_DEV_SERVER;
const devMode = process.argv.includes("--dev");
child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-12000); }); child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-12000); });
try {
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
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let sessionInstalled = false;
  page.on("console", message => { if (message.type() === "error" && !(!sessionInstalled && /Failed to load resource:.*401/.test(message.text()))) errors.push(message.text()); });
  await page.goto(`${uiOrigin}/zelavis/projects/view-lab/database`);
  await page.waitForURL(/\/zelavis\/setup/).catch(async error => { console.error("Dashboard startup:", page.url(), (await page.locator("body").innerText()).slice(0, 800), errors); throw error; });
  const bootstrap = await fetch(`${api}/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ bootstrapToken: token, provider: "password", account: { email: "views@example.test", displayName: "Server view qualification" }, credential: { identifier: "views@example.test", password } }) });
  assert.ok(bootstrap.ok, `Owner bootstrap succeeds (${bootstrap.status})`);
  const cookie = bootstrap.headers.getSetCookie().find(value => value.startsWith("zelavis_session="));
  const session = cookie?.match(/^zelavis_session=([^;]+)/)?.[1] ?? (await bootstrap.json()).session.token;
  const request = async (path, method = "GET", body) => {
    const response = await fetch(api + path, { method, headers: { origin, cookie: `zelavis_session=${session}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`); return result;
  };
  await request("/runtime/projects", "POST", { id: "view-lab", name: "View laboratory", recipeName: "@zelavis/app", start: true });
  const proxy = "/runtime/projects/view-lab/proxy/zelavis/api/v1";
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await fetch(api + proxy + "/runtime/config", { headers: { cookie: `zelavis_session=${session}` } });
    if (response.ok) break; if (attempt === 149) throw new Error(`Project did not become ready: ${await response.text()}`); await delay(200);
  }
  await request(proxy + "/database/documents/collections", "POST", { tenantId: "tenant-a", name: "articles", surface: "database" });
  await request(proxy + "/database/documents/articles", "POST", { tenantId: "tenant-a", id: "row-a", data: { title: "Actual database", count: 1 } });
  const route = `${uiOrigin}/zelavis/projects/view-lab/database?databaseTenant=tenant-a&databaseTable=articles&databaseRow=row-a&grid=tabulator&sidebar=projects/project/database`;
  const anonymous = await browser.newPage(); await anonymous.goto(route); await anonymous.waitForURL(/\/zelavis\/login/); await anonymous.close();
  await page.context().addCookies([{ name: "zelavis_session", value: session, url: uiOrigin + "/zelavis" }]);
  sessionInstalled = true;
  const html = await page.goto(route, { waitUntil: "networkidle" }); assert.equal(html.status(), 200);
  await page.getByLabel("Selected record JSON").waitFor();
  await page.getByLabel("Selected record JSON").fill('{"title":"Actual retained edit","count":2}');
  await page.getByRole("button", { name: "Stage record JSON", exact: true }).click();
  await page.evaluate(() => { window.retainedGrid = document.querySelector(".tabulator"); window.retainedSwiper = document.querySelector("swiper-container"); });
  const before = await page.locator(".server-view-status span").innerText();
  await page.getByRole("button", { name: "Refresh records", exact: true }).click();
  await page.waitForFunction(before => document.querySelector(".server-view-status span").textContent !== before, before);
  assert.equal(JSON.parse(await page.getByLabel("Selected record JSON").inputValue()).title, "Actual retained edit");
  assert.ok(await page.evaluate(() => window.retainedGrid === document.querySelector(".tabulator") && window.retainedSwiper === document.querySelector("swiper-container")));
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
  await page.getByRole("option", { name: `v${nextVersion} · active`, exact: true }).waitFor({ state: "attached", timeout: 10000 }).catch(async error => { console.error("Schema save:", errors, previousSchemas, (await page.locator("body").innerText()).slice(-2500)); throw error; });
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
} finally {
  await browser?.close();
  await dev?.close();
  if (previousOrigin === undefined) delete process.env.ZELAVIS_DEV_SERVER; else process.env.ZELAVIS_DEV_SERVER = previousOrigin;
  if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(10000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); })]); }
  await rm(data, { recursive: true, force: true });
}
