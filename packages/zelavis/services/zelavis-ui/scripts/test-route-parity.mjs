import "./fuzor-source.mjs";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { packageRoot } from "./fuzor-source.mjs";
import { dashboardRoutes } from "../app/dashboard-routes.ts";
import { selectItems } from "../app/marketplace-pages.ts";

const io = work => Effect.tryPromise({ try: work, catch: cause => cause instanceof Error ? cause : new Error(String(cause)) });
const qualify = Effect.scoped(Effect.gen(function*() {
  const listener = createServer();
  yield* io(() => new Promise(resolve => listener.listen(0, "127.0.0.1", resolve)));
  const port = listener.address().port;
  yield* io(() => new Promise(resolve => listener.close(resolve)));
  const data = yield* Effect.acquireRelease(io(() => mkdtemp(join(tmpdir(), "zelavis-route-parity-"))), path => io(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie));
  // A real package discovered at <data>/services before the Platform composes its runtime.
  const platformExtension = join(data, "services", "platform-page");
  yield* io(() => mkdir(join(platformExtension, "dashboard"), { recursive: true }));
  yield* io(() => writeFile(join(platformExtension, "package.json"), JSON.stringify({ name: "@example/platform-page", version: "1.0.0", type: "module", exports: "./index.js", zelavis: { kind: "plugin", namespace: "platformpage" } })));
  yield* io(() => writeFile(join(platformExtension, "index.js"), 'import { zelavis } from "zelavis/sdk"; export function register() { zelavis.plugins.ui.menus.create({ title: "Platform extension", surface: "platform", path: "/platform-extension", page: { id: "main", title: "Platform extension", bundle: "dashboard", file: "page.html" } }); }'));
  yield* io(() => writeFile(join(platformExtension, "dashboard", "page.html"), '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><p id="out">Platform extension</p><zv-select></zv-select><zv-dialog></zv-dialog><script type="module" src="./app.js"></script></body></html>'));
  yield* io(() => writeFile(join(platformExtension, "dashboard", "style.css"), '#out{color:rgb(1,2,3)}'));
  yield* io(() => writeFile(join(platformExtension, "dashboard", "app.js"), 'await Promise.all([customElements.whenDefined("zv-select"), customElements.whenDefined("zv-dialog")]); document.querySelector("#out").dataset.result = JSON.stringify({ opaque: self.origin === "null", select: Boolean(customElements.get("zv-select")), dialog: Boolean(customElements.get("zv-dialog")) });'));
  yield* io(() => writeFile(join(platformExtension, "private.txt"), "outside the Platform bundle"));
  const origin = `http://127.0.0.1:${port}`, api = `${origin}/zelavis/api/v1`, token = randomBytes(32).toString("base64url"), password = randomBytes(32).toString("base64url");
  let logs = "";
  const child = yield* Effect.acquireRelease(Effect.sync(() => {
    const child = spawn(process.execPath, ["scripts/runtime.ts"], { cwd: packageRoot, env: { ...process.env, PORT: String(port), ZELAVIS_TEST_FRONTEND: "fuzor", ZELAVIS_DEV_SERVER: origin, ZELAVIS_UI_DEV_SERVER: "", ZELAVIS_DATA_DIR: data, ZELAVIS_BOOTSTRAP_TOKEN: token, ZELAVIS_GITHUB_MAINTENANCE: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-16000); }); child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-16000); }); return child;
  }), child => Effect.gen(function*() {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    for (let count = 0; child.exitCode === null && count < 50; count++) yield* Effect.sleep("100 millis");
    if (child.exitCode === null) child.kill("SIGKILL");
  }));
  let ready = false;
  for (let count = 0; count < 150; count++) {
    if (child.exitCode !== null) throw new Error(logs);
    ready = yield* io(() => fetch(api + "/auth/bootstrap").then(response => response.ok)).pipe(Effect.catch(() => Effect.succeed(false)));
    if (ready) break;
    yield* Effect.sleep("200 millis");
  }
  assert.ok(ready, logs);
  const browser = yield* Effect.acquireRelease(io(() => chromium.launch()), browser => io(() => browser.close()).pipe(Effect.orDie));
  const context = yield* io(() => browser.newContext({ viewport: { width: 1440, height: 1000 } }));
  const page = yield* io(() => context.newPage());
  page.setDefaultTimeout(15000);
  yield* Effect.addFinalizer(() => io(async () => { console.log("Final route:", page.url()); console.log("Final errors:", await page.locator(".errors").innerText({ timeout: 1000 }).catch(() => "")); console.log("Final workspace:", "native".slice(-1800)); }).pipe(Effect.orDie));
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  yield* io(() => page.goto(origin + "/zelavis/projects", { waitUntil: "networkidle" }));
  yield* io(() => page.waitForURL(/\/zelavis\/setup/));
  yield* io(() => page.getByRole("button", { name: "Get started", exact: true }).click());
  yield* io(() => page.waitForURL(/step=owner/));
  yield* io(() => page.getByLabel("Email or username", { exact: true }).fill("parity@example.test"));
  yield* io(() => page.getByLabel("Display name", { exact: false }).fill("Route qualification"));
  yield* io(() => page.getByRole("button", { name: "Continue", exact: true }).click());
  yield* io(() => page.waitForURL(/step=security/));
  yield* io(() => page.getByRole("button", { name: "Back", exact: true }).click());
  yield* io(() => page.waitForURL(/step=owner/));
  assert.equal(yield* io(() => page.getByLabel("Email or username", { exact: true }).inputValue()), "parity@example.test", "Wizard identity survives step navigation");
  yield* io(() => page.getByRole("button", { name: "Continue", exact: true }).click());
  yield* io(() => page.getByLabel("One-time bootstrap token", { exact: true }).fill(token));
  yield* io(() => page.getByLabel("Owner password", { exact: true }).fill(password));
  yield* io(() => page.getByLabel("Confirm password", { exact: true }).fill(password));
  yield* io(() => page.getByRole("button", { name: "Finish setup", exact: true }).click());
  yield* io(() => page.waitForURL(/step=edge/));
  const status = yield* io(() => context.request.get(api + "/auth/bootstrap").then(response => response.json()));
  assert.equal(status.required, false, "The existing authority closes owner bootstrap");
  yield* io(() => page.getByRole("button", { name: /Configure later/ }).click());
  yield* io(() => page.getByRole("button", { name: "Finish setup", exact: true }).click());
  yield* io(() => page.getByRole("button", { name: "Open dashboard", exact: true }).click());
  yield* io(() => page.waitForURL(/\/zelavis\/projects/));
  console.log("Wizard: welcome, owner, security, identity retention, durable owner claim, Edge and dashboard complete.");
  const request = (path, method = "GET", body) => io(async () => {
    const response = await context.request.fetch(api + path, { method, headers: { origin }, ...(body ? { data: body } : {}) });
    const result = await response.json(); assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`); return result;
  });
  yield* request("/runtime/projects", "POST", { id: "parity-lab", name: "Parity laboratory", recipeName: "@zelavis/app", start: true });
  const proxy = "/runtime/projects/parity-lab/proxy/zelavis/api/v1";
  for (let count = 0; count < 150; count++) {
    const response = yield* io(() => context.request.get(api + proxy + "/runtime/config"));
    if (response.ok()) break;
    if (count === 149) throw new Error("Project failed to start: " + logs);
    yield* Effect.sleep("200 millis");
  }
  yield* request(proxy + "/database/documents/collections", "POST", { tenantId: "zelavis-app", name: "articles", surface: "content-studio" });
  yield* request(proxy + "/database/schemas/articles", "POST", { tenantId: "zelavis-app", version: 1, activate: true, fields: [{ name: "title", field: { _tag: "TextField", label: "Article title", required: true } }] });
  yield* request(proxy + "/database/documents/articles", "POST", { tenantId: "zelavis-app", id: "entry-a", data: { title: "Parity record" } });
  const workload = yield* request(proxy + "/workloads", "POST", { projectId: "parity-lab", type: "function", name: "route-fixture", route: "/api/parity", code: 'export default () => new Response("qualification")', enabled: true });
  const examples = { projectId: "parity-lab", contentType: "articles", entryId: "entry-a", workloadKind: "functions", workloadId: workload.id, managedSection: "domains", fabricSection: "nodes", fabricDetail: "health", collection: "articles" };
  const cases = [...dashboardRoutes.filter(path => !["/setup", "/logout"].includes(path)), "/*"].map(path => ({ path, file: path, example: path === "/*" ? "/not-a-dashboard-route" : path.replace(/:([a-zA-Z]+)/g, (_, key) => examples[key]) }));
  for (const path of ["/server/fabric/placements", "/server/fabric/migrations", "/server/fabric/data", "/server/fabric/data/shards", "/server/fabric/data/replicas", "/server/fabric/data/schema-rollouts", "/server/fabric/infrastructure", "/server/fabric/infrastructure/providers", "/server/fabric/infrastructure/autoscaling", "/server/fabric/settings", "/server/fabric/settings/placement-policies", "/server/fabric/settings/networking", "/server/fabric/settings/limits", "/projects?new=1"]) cases.push({ path, example: path, file: "nested/query page" });
  const results = [{ path: "/setup", file: "routes/setup.tsx", status: "qualified wizard flow" }];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    yield* io(() => page.setViewportSize(viewport));
    for (const entry of process.argv.includes("--actions-only") ? [] : cases) {
      const url = origin + "/zelavis" + entry.example;
      yield* io(() => page.goto(url, { waitUntil: "networkidle" }));
      if (entry.path === "/*") { yield* io(() => page.getByRole("heading", { name: "Page not found", exact: true }).waitFor()); }
      else if (entry.example === "/projects/parity-lab/database") {
        yield* io(() => page.locator(".database-head").getByRole("link", { name: "Manage tenants", exact: true }).waitFor());
      } else {
        yield* io(() => page.locator(".content .k-page, .content .panel, .content .empty, .content .auth-card").first().waitFor());
        const text = yield* io(() => page.locator(".content").innerText());
        assert.ok(text.trim().length > 15 && !/Page being ported|Could not/.test(text), `${entry.file}: ${text}`);
      }
      assert.equal(errors.length, 0, `${entry.file}: ${errors.join("\n")}`);
      results.push({ path: entry.example, file: entry.file, viewport: viewport.width, status: "loaded" });
      console.log(`${viewport.width}: ${entry.file} → ${entry.example}`);
    }
  }
  yield* io(() => page.setViewportSize({ width: 1440, height: 1000 }));
  const visit = path => io(() => page.goto(origin + "/zelavis" + path, { waitUntil: "networkidle" }));
  // A service page gets the component runtime without asking, both as a trusted frame and as the sandboxed frame an
  // installed extension runs in (an opaque origin, which sends no ambient credentials of its own).
  yield* visit("/projects");
  const configuration = yield* request("/runtime/config");
  const platformService = configuration.services.find(service => service.name === "@example/platform-page");
  assert.equal(platformService?.scope, "extension", "folder discovery forces extension trust on the Platform");
  const platformRegistry = (yield* request("/runtime/services")).services;
  assert.equal(platformRegistry.find(service => service.name === platformService.name)?.scope, platformService.scope, "config and registry agree");
  assert.ok(selectItems(platformRegistry, "plugins").some(service => service.name === platformService.name), "Platform Marketplace lists the folder extension");
  yield* visit("/platform-extension");
  const platformFrame = page.locator("iframe.service-frame");
  assert.equal(yield* io(() => platformFrame.getAttribute("sandbox")), "allow-scripts allow-forms");
  const platformSrc = yield* io(() => platformFrame.getAttribute("src"));
  assert.match(platformSrc ?? "", /\/runtime\/page-capabilities\/[^/]+\/dashboard\/page\.html$/);
  const extensionResult = page.frameLocator("iframe.service-frame").locator("#out");
  yield* io(() => page.frameLocator("iframe.service-frame").locator("#out[data-result]").waitFor());
  const resultText = yield* io(() => extensionResult.getAttribute("data-result"));
  assert.deepEqual(JSON.parse(resultText), { opaque: true, select: true, dialog: true });
  assert.match(yield* io(() => page.locator("nav, aside, .sidebar").first().innerText()), /Extensions[\s\S]*Platform extension/);
  const platformAnonymous = yield* io(() => fetch(new URL(platformSrc, origin)));
  assert.equal(platformAnonymous.status, 200, "Platform capability needs no cookie");
  assert.equal((yield* io(() => fetch(new URL(platformSrc.replace("page.html", "private.txt"), origin)))).status, 404, "Platform capability cannot fall back to package root");
  console.log("Platform folder extension: config/registry/Marketplace agree, Extensions slide, opaque frame, own module and components loaded, package-root read refused.");
  yield* visit("/projects");
  const authPage = configuration.services.find(service => service.name === "@zelavis/auth")?.menu?.page?.src;
  assert.ok(authPage, "the Auth service ships a framed page");
  const runtimeLoads = [];
  const onRuntime = response => { if (/\/runtime\/service-(ui\.(js|css)|page\.css)$/.test(new URL(response.url()).pathname)) runtimeLoads.push(`${response.status()} ${new URL(response.url()).pathname.split("/").pop()} ${response.frame()?.name() ?? ""}`); };
  page.on("response", onRuntime);
  const frames = yield* io(() => page.evaluate(src => new Promise(resolve => {
    const make = (sandbox, name) => { const frame = document.createElement("iframe"); frame.name = name; frame.setAttribute("sandbox", sandbox); frame.src = src; frame.style.display = "none"; document.body.append(frame); return frame; };
    const trusted = make("allow-scripts allow-same-origin", "trusted"); make("allow-scripts", "sandboxed");
    setTimeout(() => resolve({ select: Boolean(trusted.contentWindow.customElements.get("zv-select")), dialog: Boolean(trusted.contentWindow.customElements.get("zv-dialog")) }), 3000);
  }), authPage));
  page.off("response", onRuntime);
  // The page's own files too: the dashboard frames a sandboxed page at a capability URL, so what the page itself loads
  // (relative links resolve under the capability) needs no session.
  const capability = yield* request("/runtime/service-page-capability?" + new URLSearchParams({ service: "@zelavis/auth", bundle: "dashboard", file: "auth.html" }));
  assert.match(capability.src, /\/runtime\/page-capabilities\/[^/]+\/dashboard\/auth\.html$/);
  const fromCapability = [];
  const onCapability = response => { const path = new URL(response.url()).pathname; if (/\/(page-capabilities\/|service-ui\.|service-page\.css)/.test(path)) fromCapability.push(`${response.status()} ${path.split("/").pop()} ${response.frame()?.name() ?? ""}`); };
  page.on("response", onCapability);
  yield* io(() => page.evaluate(src => new Promise(resolve => {
    const frame = document.createElement("iframe"); frame.name = "capability"; frame.setAttribute("sandbox", "allow-scripts"); frame.src = src; frame.style.display = "none"; document.body.append(frame);
    setTimeout(resolve, 3000);
  }), capability.src));
  page.off("response", onCapability);
  for (const file of ["auth.html", "service-ui.js", "service-ui.css", "service-page.css"]) assert.ok(fromCapability.some(entry => entry.startsWith(`200 ${file} `)), `the sandboxed capability frame loads ${file}: ${fromCapability.join(", ")}`);
  // An extension installed inside a Project: a real folder service in the Project's own services folder, with a page that
  // loads its own script and stylesheet. Its page is read from the Project's runtime, through the Platform's Gateway, at a
  // capability URL, by a sandboxed frame that sends no session.
  yield* request("/runtime/projects", "POST", { id: "ext-lab", name: "Extension laboratory", recipeName: "@zelavis/app", start: true });
  const extProxy = "/runtime/projects/ext-lab/proxy/zelavis/api/v1";
  const waitRunning = Effect.gen(function*() {
    for (let count = 0; count < 150; count++) {
      const response = yield* io(() => context.request.get(api + extProxy + "/runtime/config"));
      if (response.ok()) return;
      yield* Effect.sleep("200 millis");
    }
    throw new Error("The extension Project failed to start: " + logs);
  });
  yield* waitRunning;
  const extension = join(data, "projects", "ext-lab", ".zelavis", "services", "ext-page");
  yield* io(async () => {
    await mkdir(join(extension, "dashboard"), { recursive: true });
    await writeFile(join(extension, "package.json"), JSON.stringify({ name: "@example/ext-page", version: "1.0.0", type: "module", exports: "./index.js", zelavis: { kind: "plugin", namespace: "extpage" } }));
    await writeFile(join(extension, "index.js"), 'import { zelavis } from "zelavis/sdk";\nexport function register() { zelavis.plugins.ui.menus.create({ title: "Ext Page", path: "/ext-page", page: { id: "main", title: "Ext Page", bundle: "dashboard", file: "page.html" } }); }\n');
    await writeFile(join(extension, "dashboard", "page.html"), '<!doctype html><html><head><title>Ext</title><link rel="stylesheet" href="./styles.css"></head><body><p id="out">extension page</p><script type="module" src="./app.js"></script></body></html>');
    await writeFile(join(extension, "dashboard", "styles.css"), "#out{color:rgb(1,2,3)}");
    await writeFile(join(extension, "dashboard", "app.js"), 'document.body.insertAdjacentHTML("beforeend", "<zv-select></zv-select><zv-dialog></zv-dialog>"); await Promise.all([customElements.whenDefined("zv-select"), customElements.whenDefined("zv-dialog")]); parent.postMessage({ extension: "ran", sandboxed: self.origin === "null", select: Boolean(customElements.get("zv-select")), dialog: Boolean(customElements.get("zv-dialog")) }, "*");\n');
  });
  yield* request("/runtime/projects/ext-lab/restart", "POST", {});
  yield* waitRunning;
  const listed = yield* Effect.gen(function*() {
    for (let count = 0; count < 100; count++) {
      const config = yield* io(() => context.request.get(api + extProxy + "/runtime/config").then(response => response.json()));
      if (config.services?.some(service => service.name === "@example/ext-page")) return config;
      yield* Effect.sleep("300 millis");
    }
    throw new Error("The Project never listed the extension: " + logs);
  });
  // A folder-discovered package is an extension, never the operator's own: its page must not run with the viewer's session.
  assert.equal(listed.services.find(service => service.name === "@example/ext-page")?.scope, "extension");
  // The Marketplace lists the Project's own extension under Plugins, from the registry the Project reports.
  const extRegistry = (yield* request(extProxy + "/runtime/services")).services;
  assert.equal(extRegistry.find(service => service.name === "@example/ext-page")?.scope, "extension");
  assert.ok(selectItems(extRegistry, "plugins").some(service => service.name === "@example/ext-page"), "the Marketplace's Plugins tab lists the extension");
  const extCapability = yield* request("/runtime/service-page-capability?" + new URLSearchParams({ service: "@example/ext-page", bundle: "dashboard", file: "page.html", projectId: "ext-lab" }));
  assert.match(extCapability.src, /\/runtime\/page-capabilities\/[^/]+\/dashboard\/page\.html$/);
  // No cookie: the Platform reads the Project's files for the capability alone.
  const extPage = yield* io(() => fetch(new URL(extCapability.src, origin)));
  assert.equal(extPage.status, 200, "the Project's page is served at its capability");
  const extHtml = yield* io(() => extPage.text());
  assert.match(extHtml, /extension page/);
  assert.match(extHtml, /service-ui\.js/, "the Platform adds the component runtime to a Project's page");
  const extScript = yield* io(() => fetch(new URL(extCapability.src.replace("page.html", "app.js"), origin)));
  assert.equal(extScript.status, 200);
  assert.equal((yield* io(() => fetch(new URL(extCapability.src.replace("page.html", "../../../x.txt"), origin)))).status === 200, false);
  // The same URL in a sandboxed frame: the page's own script runs and finds the components defined.
  const ran = yield* io(() => page.evaluate(src => new Promise(resolve => {
    const onMessage = event => { if (event.data?.extension === "ran") { removeEventListener("message", onMessage); resolve(event.data); } };
    addEventListener("message", onMessage);
    const frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-scripts"); frame.src = src; frame.style.display = "none"; document.body.append(frame);
    setTimeout(() => resolve({ timedOut: true }), 8000);
  }), extCapability.src));
  assert.deepEqual(ran, { extension: "ran", sandboxed: true, select: true, dialog: true });
  // And through the dashboard itself, which frames a Project's extension page at a capability.
  yield* visit("/projects/ext-lab/ext-page");
  const framed = yield* io(() => page.locator("iframe.service-frame").getAttribute("src"));
  assert.match(framed ?? "", /\/runtime\/page-capabilities\//, "the dashboard frames the extension page at a capability URL");
  // The sidebar puts an extension's menu in the Extensions slide, never in a trusted one such as Backend.
  const sidebar = yield* io(() => page.locator("nav, aside, .sidebar").first().innerText());
  assert.ok(/Extensions\nAgents\nExt Page\s*$/.test(sidebar), `the extension's menu is the Extensions slide's: ${JSON.stringify(sidebar.slice(-120))}`);
  assert.ok(!/Workloads\n›?\n?Ext Page/.test(sidebar), "and is not beside the Backend items");
  assert.equal(yield* io(() => page.locator("iframe.service-frame").getAttribute("sandbox")), "allow-scripts allow-forms", "an extension's page is sandboxed without the dashboard's origin");
  console.log("Project extension page: served through its capability, sandboxed frame ran its own script with the components defined.");
  const anonymous = yield* io(() => fetch(new URL(capability.src, origin)));
  assert.equal(anonymous.status, 200, "a capability URL needs no cookie");
  assert.equal((yield* io(() => fetch(new URL(capability.src.replace(/\/[^/]+\/dashboard\/auth\.html$/, "/tampered.token/dashboard/auth.html"), origin)))).status, 404);
  assert.deepEqual(frames, { select: false, dialog: false }, "a page without component tags does not load unused families");
  for (const frame of ["trusted", "sandboxed"]) for (const file of ["service-ui.js", "service-ui.css", "service-page.css"]) assert.ok(runtimeLoads.includes(`200 ${file} ${frame}`), `the ${frame} frame loads ${file}: ${runtimeLoads.join(", ")}`);
  console.log(`Service page runtime requests: ${runtimeLoads.join(", ")}`);
  yield* visit("/projects/parity-lab/database?databaseDialog=create-table");
  yield* io(() => page.getByRole("dialog").getByLabel("Table name").waitFor());
  const databaseLinks = yield* io(() => page.locator('nav a[href^="/"]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute("href"))));
  assert.ok(databaseLinks.length > 0 && databaseLinks.every(path => path.startsWith("/zelavis/")), "Feature links preserve the dashboard mount when opened in another tab");
  yield* io(() => page.getByRole("dialog").getByLabel("Table name").fill("ui_created_table"));
  yield* io(() => page.getByRole("button", { name: "Create and Open Table", exact: true }).click());
  yield* io(() => page.waitForURL(url => url.pathname.endsWith("/database") && url.searchParams.get("databaseTable") === "ui_created_table"));
  yield* io(() => page.locator(".database-title").getByText("ui_created_table", { exact: true }).waitFor());
  assert.match(yield* io(() => page.locator(".database-title").innerText()), /ui_created_table\s+in zelavis-app/, "The heading names the open table and its Tenant");
  assert.equal(yield* io(() => page.getByRole("dialog").count()), 0, "The dialog closes once the table exists");
  const tables = yield* request(proxy + "/database/documents/collections?tenantId=zelavis-app");
  assert.ok(tables.collections.some(table => table.name === "ui_created_table"));
  console.log("Action: table creation redirects into the native database under the correct Project and tenant.");

  yield* visit("/projects/parity-lab/content/new");
  yield* io(() => page.getByLabel("Content type label").fill("UI Notes"));
  yield* io(() => page.getByLabel("Content type slug").fill("ui-notes"));
  yield* io(() => page.getByRole("button", { name: "Create and Open Fields", exact: true }).click());
  yield* io(() => page.waitForURL(/content\/ui-notes\/fields/));
  const schemas = yield* request(proxy + "/database/schemas/ui-notes?tenantId=zelavis-app");
  assert.ok(schemas.schemas.some(schema => schema.active && schema.fields.length > 0));
  yield* visit("/projects/parity-lab/content/articles/entry-a");
  yield* io(() => page.getByPlaceholder("Enter article title", { exact: true }).fill("Edited through Fuzor"));
  const switches = page.getByRole("navigation", { name: "Sidebar view switches" });
  yield* io(() => switches.getByRole("button", { name: "Search", exact: true }).click());
  yield* io(() => switches.getByRole("button", { name: "Search", exact: true }).click());
  assert.equal(yield* io(() => page.getByPlaceholder("Enter article title", { exact: true }).inputValue()), "Edited through Fuzor", "Utility switches retain editor draft");
  yield* io(() => page.getByRole("button", { name: "Save Entry", exact: true }).click());
  yield* io(() => page.getByText("Saved entry-a.", { exact: true }).waitFor());
  yield* visit("/projects/parity-lab/content/articles/entry-a");
  assert.equal(yield* io(() => page.getByPlaceholder("Enter article title", { exact: true }).inputValue()), "Edited through Fuzor");
  console.log("Actions: content type/schema creation, content editing/save/reload and a draft kept across sidebar view switches passed.");

  yield* request(proxy + "/database/documents/collections", "POST", { tenantId: "zelavis-app", name: "tags", surface: "content-studio" });
  yield* request(proxy + "/database/schemas/tags", "POST", { tenantId: "zelavis-app", version: 1, activate: true, fields: [{ name: "title", field: { _tag: "TextField", label: "Tag title", required: true } }] });
  yield* request(proxy + "/database/documents/tags", "POST", { tenantId: "zelavis-app", id: "tag-a", data: { title: "Scoped tag alpha" } });
  yield* request(proxy + "/database/schemas/articles", "POST", { tenantId: "zelavis-app", version: 2, activate: true, fields: [{ name: "title", field: { _tag: "TextField", label: "Article title", required: true } }, { name: "tag", field: { _tag: "ReferenceField", label: "Tag", required: false, collection: "tags", multiple: false } }] });
  const relationRequests = [];
  const relationObserver = request => { if (request.url().includes("/documents/tags/query")) relationRequests.push(request.url()); };
  page.on("request", relationObserver);
  yield* visit("/projects/parity-lab/content/articles/entry-a");
  yield* io(() => page.locator("zv-select-item", { hasText: "Scoped tag alpha" }).waitFor({ state: "attached" }));
  yield* io(() => page.locator(".content zv-select-trigger").click());
  yield* io(() => page.locator("zv-select-item", { hasText: "Scoped tag alpha" }).click());
  yield* io(() => page.getByRole("button", { name: "Save Entry", exact: true }).click());
  yield* io(() => page.getByText("Saved entry-a.", { exact: true }).waitFor());
  const records = yield* request(proxy + "/database/documents/articles/query", "POST", { tenantId: "zelavis-app" });
  assert.deepEqual(records.documents.find(entry => entry.id === "entry-a").data.tag, { collection: "tags", id: "tag-a" });
  assert.ok(relationRequests.length > 0 && relationRequests.every(url => url.includes(proxy + "/database/")), "Relation resource loader never uses the Platform database");
  page.off("request", relationObserver);
  console.log("Action: relation picker resource loading and saving retain exact Project scope.");

  yield* request(proxy + "/database/documents/ui-notes", "POST", { tenantId: "zelavis-app", id: "note-a", data: { title: "A note", slug: "a-note", excerpt: "Short", _content: "<p>Hello <strong>rich</strong> text</p>" } });
  yield* visit("/projects/parity-lab/content/ui-notes/note-a");
  yield* io(() => page.locator(".rte-surface").click());
  yield* io(() => page.keyboard.press("End"));
  yield* io(() => page.keyboard.type(" and more"));
  yield* io(() => page.getByRole("button", { name: "Bold", exact: true }).click());
  yield* io(() => page.getByRole("button", { name: "Save Entry", exact: true }).click());
  yield* io(() => page.getByText("Saved note-a.", { exact: true }).waitFor());
  const note = yield* request(proxy + "/database/documents/ui-notes/note-a?tenantId=zelavis-app");
  assert.match(note.data._content, /Hello .*rich.* text.*and more/s, "The rich text editor saves what was typed: " + note.data._content);
  console.log("Action: the vanilla Lexical editor loads stored HTML, takes typing and saves it.");

  yield* visit("/projects/parity-lab/workloads/new");
  yield* io(() => page.getByLabel("Name", { exact: true }).fill("ui-created-function"));
  yield* io(() => page.getByLabel("Route", { exact: true }).fill("/api/ui-created"));
  yield* io(() => page.getByRole("button", { name: "Create", exact: true }).click());
  yield* io(() => page.waitForURL(/workloads\/functions\/[^/?]+/));
  const id = new URL(page.url()).pathname.split("/").at(-1);
  assert.equal((yield* request(proxy + "/workloads/" + id)).name, "ui-created-function");
  yield* io(() => page.getByRole("button", { name: "Run", exact: true }).click());
  yield* io(() => page.getByText("Run output", { exact: true }).waitFor());
  yield* io(() => page.getByLabel("Name", { exact: true }).fill("ui-renamed-function"));
  yield* io(() => page.getByRole("button", { name: "Save", exact: true }).click());
  yield* io(() => page.waitForURL(url => url.pathname.endsWith("/workloads")));
  assert.equal((yield* request(proxy + "/workloads/" + id)).name, "ui-renamed-function");
  yield* io(() => page.goBack({ waitUntil: "networkidle" }));
  yield* io(() => page.waitForURL(/workloads\/functions\/[^/?]+/));
  assert.equal(yield* io(() => page.getByLabel("Name", { exact: true }).inputValue()), "ui-renamed-function");
  console.log("Actions: workload creation, run, update and browser Back passed.");

  yield* visit("/projects");
  yield* io(() => page.getByPlaceholder("Search projects", { exact: true }).fill("Parity laboratory"));
  yield* io(() => page.getByPlaceholder("Search projects", { exact: true }).press("Enter"));
  yield* io(() => page.waitForURL(url => url.searchParams.get("q") === "Parity laboratory"));
  yield* io(() => page.getByRole("button", { name: "New project", exact: true }).click());
  yield* io(() => page.waitForURL(url => url.searchParams.get("new") === "1"));
  yield* io(() => page.getByLabel("Name", { exact: true }).fill("UI lifecycle test"));
  yield* io(() => page.getByRole("button", { name: "Create", exact: true }).click());
  yield* io(() => page.getByText("UI lifecycle test is running in its own project runtime.", { exact: true }).waitFor());
  const created = (yield* request("/runtime/projects")).projects.find(project => project.name === "UI lifecycle test");
  assert.ok(created?.id && created.runtime.status === "running");
  console.log("Action: native Projects create form preserves URL-backed input and creates a real App runtime.");

  yield* visit("/settings/appearance");
  yield* io(() => page.getByLabel("Theme", { exact: true }).click());
  yield* io(() => page.locator("zv-select-item", { hasText: "Dark" }).click());
  yield* io(() => page.waitForFunction(() => document.documentElement.dataset.dashboardTheme === "dark"));
  assert.equal((yield* request("/runtime/settings")).theme, "dark");
  console.log("Action: theme persists through the existing runtime API and synchronizes with the Fuzor shell.");

  // Hosting pages need managed recipe metadata. This read-only UI fixture
  // qualifies their rendering without provisioning host packages or cloud servers.
  const managedProjects = async route => {
    const response = await route.fetch(); const data = await response.json();
    data.projects = data.projects.map(project => project.id === "parity-lab" ? { ...project, recipe: { ...project.recipe, managed: { adminTitle: "App Admin", adminPath: "/admin" } } } : project);
    await route.fulfill({ response, json: data });
  };
  yield* io(() => page.route("**/api/v1/runtime/projects", managedProjects));
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    yield* io(() => page.setViewportSize(viewport));
    for (const [section, title] of [["domains", "Domains"], ["files", "Files"], ["app-database", "App database"], ["setup", "Setup"], ["backups", "Backups"], ["logs", "Logs"], ["updates", "Updates"], ["admin", "App Admin"]]) {
      yield* visit("/projects/parity-lab/" + section);
      yield* io(() => page.locator(".content").getByText(title, { exact: true }).first().waitFor());
      assert.equal(errors.length, 0, errors.join("\n"));
      results.push({ path: "/projects/:projectId/" + section, viewport: viewport.width, status: "managed recipe UI fixture loaded; provisioning not exercised" });
    }
  }
  yield* io(() => page.unroute("**/api/v1/runtime/projects", managedProjects));
  yield* io(() => page.setViewportSize({ width: 1440, height: 1000 }));
  console.log("Managed recipe UI fixture: all eight hosting sections render on desktop and mobile; planned controls remain labelled planned.");

  yield* visit("/projects/parity-lab/storage");
  yield* io(() => page.getByLabel("File", { exact: true }).setInputFiles({ name: "parity.txt", mimeType: "text/plain", buffer: Buffer.from("uploaded through Fuzor") }));
  yield* io(() => page.getByLabel("Label metadata", { exact: true }).fill("Parity file"));
  yield* io(() => page.getByRole("button", { name: "Upload file", exact: true }).click());
  yield* io(() => page.getByText("Uploaded parity.txt.", { exact: true }).waitFor());
  const stored = yield* request(proxy + "/storage/files/parity.txt?format=metadata");
  assert.equal(stored.file.metadata?.label, "Parity file", JSON.stringify(stored));
  yield* io(() => page.getByRole("button", { name: "Delete parity.txt", exact: true }).click().catch(() => undefined));
  console.log("Action: native storage upload carries its metadata and lands in the Project's storage.");

  yield* visit("/projects/parity-lab/media");
  yield* io(() => page.getByRole("heading", { name: "Asset details", exact: true }).waitFor());
  console.log("Action: the media gallery island mounts.");

  if (process.env.PARITY_SHOTS) {
    // Looking is part of qualifying: every native page and island is captured so a person can compare it with the original.
    yield* io(() => mkdir(process.env.PARITY_SHOTS, { recursive: true }));
    for (const shot of ["/projects", "/projects?new=1", "/server", "/server/fabric", "/server/access/users", "/settings", "/marketplace", "/projects/parity-lab", "/projects/parity-lab/storage", "/projects/parity-lab/media", "/projects/parity-lab/workloads/new", "/projects/parity-lab/content", "/projects/parity-lab/content/articles", "/projects/parity-lab/content/articles/entry-a", "/projects/parity-lab/content/ui-notes/note-a", "/projects/parity-lab/content/ui-notes/fields?view=editor", "/projects/parity-lab/content/ui-notes/fields?view=settings", "/projects/parity-lab/settings", "/assistant", "/projects/parity-lab/database", "/projects/parity-lab/auth", "/projects/parity-lab/marketplace"]) {
      yield* visit(shot);
      yield* io(() => page.waitForTimeout(800));
      if (shot === "/projects/parity-lab/content") { yield* io(() => page.getByRole("button", { name: /Content/ }).first().click().catch(() => undefined)); yield* io(() => page.waitForTimeout(600)); }
      yield* io(() => page.screenshot({ path: `${process.env.PARITY_SHOTS}/${shot.replace(/[^a-z0-9]+/gi, "_")}.png`, fullPage: true }));
    }
  }

  // The update banner: a newer version is announced everywhere, and Update now sends the one trusted request.
  const updateStatus = { current: "2.0.0-alpha.1", latest: "2.0.0-alpha.2", available: true, managed: true, state: "idle", channel: "alpha" };
  const applied = [];
  yield* io(() => page.route("**/api/v1/runtime/updates**", async route => {
    const request = route.request();
    if (request.method() === "POST" && request.url().endsWith("/apply")) applied.push(request.url());
    await route.fulfill({ json: applied.length ? { ...updateStatus, available: false, state: "requested" } : updateStatus });
  }));
  yield* visit("/server/backups");
  yield* io(() => page.getByTestId("update-banner").getByText("2.0.0-alpha.2", { exact: true }).waitFor());
  yield* io(() => page.getByRole("button", { name: "Update now", exact: true }).click());
  yield* io(() => page.getByText("Starting the update", { exact: false }).waitFor());
  assert.equal(applied.length, 1, "Update now sends exactly one apply request");
  yield* io(() => page.unroute("**/api/v1/runtime/updates**"));
  console.log("Action: the update banner announces a newer version and Update now requests the update once.");

  yield* visit("/logout");
  yield* io(() => page.waitForURL(/\/zelavis\/login/));
  yield* visit("/projects/parity-lab/workloads/functions/" + id);
  yield* io(() => page.waitForURL(/\/zelavis\/login/));
  yield* io(() => page.getByLabel("Email or username", { exact: true }).fill("parity@example.test"));
  yield* io(() => page.getByLabel("Password", { exact: true }).fill(password));
  yield* io(() => page.getByRole("button", { name: "Login", exact: true }).click());
  yield* io(() => page.waitForURL(url => url.pathname.endsWith("/workloads/functions/" + id)));
  assert.equal(yield* io(() => page.getByLabel("Name", { exact: true }).inputValue()), "ui-renamed-function");
  assert.ok(!page.url().includes("/zelavis/zelavis/"));
  const localLinks = yield* io(() => page.locator('.content a[href^="/"]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute("href"))));
  assert.ok(localLinks.every(path => path.startsWith("/zelavis/") || path.startsWith("/zelavis?")), "Feature links preserve the dashboard mount when opened in another tab");
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("Actions: logout, protected route redirect and password login return to the original deep link passed.");
  yield* io(() => mkdir(new URL("../test-results/", import.meta.url), { recursive: true }));
  yield* io(() => writeFile(new URL(process.argv.includes("--actions-only") ? "../test-results/route-actions.json" : "../test-results/route-parity.json", import.meta.url), JSON.stringify(results, null, 2)));

  console.log("Route inventory load checks and representative mutation/history scenarios passed.");
}));
await Effect.runPromise(qualify);
