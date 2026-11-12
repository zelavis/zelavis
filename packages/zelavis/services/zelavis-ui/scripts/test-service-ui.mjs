import "./fuzor-source.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { zelavis } from "../../../dist/index.js";
import { injectServiceUi } from "../../../dist/platform/service-page-ui.js";
import { zelavisUiFrontend } from "../dist/frontend.js";

const mount = "/nested/control", assets = `${mount}/api/v1/runtime`;
const runtime = await zelavis({ rootPath: mount, frontend: zelavisUiFrontend });
const select = '<form id="form"><zv-select name="plan" value="basic"><zv-select-trigger><zv-select-value></zv-select-value></zv-select-trigger><zv-select-content><zv-select-item value="basic">Basic</zv-select-item><zv-select-item value="plus">Plus</zv-select-item></zv-select-content></zv-select><button type="reset">Reset</button></form>';
const requests = [];
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<iframe name="trusted" sandbox="allow-scripts allow-same-origin" src="/fixture?select=1"></iframe><iframe name="opaque" sandbox="allow-scripts allow-forms" src="/fixture?select=1"></iframe>');
      return;
    }
    if (url.pathname === "/fixture") {
      response.setHeader("content-type", "text/html");
      response.end(injectServiceUi(`<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>${url.searchParams.has("select") ? select : "<p>No components</p>"}</body></html>`, { script: `${assets}/service-ui.js`, stylesheet: `${assets}/service-ui.css` }));
      return;
    }
    const result = await runtime.fetch(new Request(url, { headers: request.headers }));
    const body = Buffer.from(await result.arrayBuffer());
    if (url.pathname.startsWith(assets + "/service-ui")) requests.push({ path: url.pathname, bytes: body.byteLength, gzip: gzipSync(body).byteLength, status: result.status });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(body);
  })().catch(error => { console.error(error); response.writeHead(500); response.end("Test server failed"); });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch();
  // No tags means no component family, even after the discovery entry has run.
  const context = await browser.newContext();
  context.setDefaultTimeout(15000);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/fixture`, { waitUntil: "networkidle" });
  const emptyRequests = requests.filter(item => item.path.endsWith(".js"));
  assert.ok(emptyRequests.length > 0, "the discovery entry ran");
  assert.ok(emptyRequests.every(item => item.status === 200));
  const emptyBytes = emptyRequests.reduce((sum, item) => sum + item.bytes, 0);
  const emptyGzip = emptyRequests.reduce((sum, item) => sum + item.gzip, 0);
  assert.ok(emptyBytes < 110_000, `empty page JavaScript budget: ${emptyBytes}`);
  assert.equal(await page.evaluate(() => Boolean(customElements.get("zv-select") || customElements.get("zv-dialog"))), false);
  console.log(`Empty page: ${emptyBytes} JavaScript bytes (${emptyGzip} gzip); no unused component registrations.`);

  // Late markup is discovered once. A family is shared by its canonical tag and alias.
  requests.length = 0;
  await page.evaluate(html => document.body.insertAdjacentHTML("beforeend", html), select);
  await page.waitForFunction(() => Boolean(customElements.get("zv-select")));
  await page.locator("zv-select-trigger").click();
  await page.screenshot({ path: "/tmp/zelavis-chunk-select.png" });
  await page.getByRole("option", { name: "Plus", exact: true }).click().catch(async error => {
    console.error("Late select failure:", errors, requests, await page.locator("body").innerHTML());
    throw error;
  });
  assert.equal(await page.evaluate(() => new FormData(document.getElementById("form")).get("plan")), "plus");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.waitForFunction(() => new FormData(document.getElementById("form")).get("plan") === "basic");
  await page.evaluate(() => { for (let index = 0; index < 40; index++) document.body.append(document.createElement(index % 2 ? "zv-select" : "fuzor-select")); });
  await page.waitForLoadState("networkidle");
  assert.equal(requests.filter(item => /\/select-[\w-]+\.js$/.test(item.path)).length, 1, "one import for repeated canonical and branded tags");
  assert.equal(await page.evaluate(() => Boolean(customElements.get("zv-dialog"))), false, "select does not import dialog");
  assert.ok(requests.every(item => item.status === 200));
  const selectBytes = requests.filter(item => item.path.endsWith(".js")).reduce((sum, item) => sum + item.bytes, 0);
  const selectGzip = requests.filter(item => item.path.endsWith(".js")).reduce((sum, item) => sum + item.gzip, 0);
  const measurements = { empty: { bytes: emptyBytes, gzip: emptyGzip }, select: { bytes: emptyBytes + selectBytes, gzip: emptyGzip + selectGzip } };
  await writeFile("/tmp/zelavis-chunk-browser-metrics.json", JSON.stringify(measurements, null, 2));
  console.log(`Select page: ${measurements.select.bytes} total JavaScript bytes (${measurements.select.gzip} gzip); first interaction, FormData, reset and deduplication passed.`);

  requests.length = 0;
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<zv-toggle-group><zv-toggle-group-item value="bold">Bold</zv-toggle-group-item></zv-toggle-group>'));
  await page.waitForFunction(() => Boolean(customElements.get("zv-toggle-group-item")));
  await page.getByRole("radio", { name: "Bold", exact: true }).click();
  assert.equal(await page.locator("zv-toggle-group-item").getAttribute("aria-checked"), "true");
  assert.equal(requests.filter(item => /\/toggle-group-[\w-]{8}\.js$/.test(item.path)).length, 1);
  assert.equal(requests.filter(item => /\/toggle-[\w-]{8}\.js$/.test(item.path)).length, 0, "a longer family name never loads its shorter prefix");
  assert.equal(await page.evaluate(() => Boolean(customElements.get("zv-toggle"))), false);

  // Page lifetime stops discovery and a restored document resumes it.
  await page.evaluate(() => { dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); document.body.append(document.createElement("fuzor-dialog")); });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => Boolean(customElements.get("fuzor-dialog"))), false);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.waitForFunction(() => Boolean(customElements.get("fuzor-dialog") && customElements.get("zv-dialog")));
  assert.deepEqual(errors, []);
  await context.close();

  // Initial markup and imports work at a nested mount in both trusted and opaque documents.
  const framesContext = await browser.newContext();
  framesContext.setDefaultTimeout(15000);
  const framesPage = await framesContext.newPage();
  const frameErrors = [];
  framesPage.on("pageerror", error => frameErrors.push(error.message));
  await framesPage.goto(origin);
  for (const name of ["trusted", "opaque"]) {
    const frame = framesPage.frame({ name });
    await frame.waitForFunction(() => Boolean(customElements.get("zv-select")));
    await frame.locator("zv-select-trigger").click();
    await frame.getByRole("option", { name: "Plus", exact: true }).click();
    assert.equal(await frame.evaluate(() => new FormData(document.getElementById("form")).get("plan")), "plus");
    assert.equal(await frame.evaluate(() => self.origin === "null"), name === "opaque");
  }
  assert.deepEqual(frameErrors, []);
  await framesContext.close();
  console.log("Nested mount, initial markup, trusted and opaque frames: real select interaction and FormData passed.");

  // A failed family reports one observable error and never spins on subsequent DOM mutations.
  const failureContext = await browser.newContext();
  failureContext.setDefaultTimeout(15000);
  const failurePage = await failureContext.newPage();
  let failedImports = 0;
  await failurePage.route("**/service-ui/select-*.js", route => { failedImports++; return route.abort(); });
  await failurePage.goto(`${origin}/fixture`, { waitUntil: "networkidle" });
  await failurePage.evaluate(html => {
    window.componentFailures = [];
    document.addEventListener("zelavis-service-ui-error", event => window.componentFailures.push(event.detail.component));
    document.body.insertAdjacentHTML("beforeend", html);
  }, select);
  await failurePage.waitForFunction(() => window.componentFailures.length > 0);
  await failurePage.evaluate(() => { for (let index = 0; index < 20; index++) document.body.append(document.createElement("zv-select")); document.body.append(document.createElement("zv-dialog")); });
  await failurePage.waitForFunction(() => Boolean(customElements.get("zv-dialog")));
  assert.equal(failedImports, 1);
  assert.deepEqual(await failurePage.evaluate(() => window.componentFailures), ["select"]);
  await failureContext.close();
  console.log("Import failure: observable component error, no retry loop, unrelated family still loads.");
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
