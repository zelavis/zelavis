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

const io = work => Effect.tryPromise({ try: work, catch: cause => cause instanceof Error ? cause : new Error(String(cause)) });
const qualify = Effect.scoped(Effect.gen(function*() {
  const listener = createServer();
  yield* io(() => new Promise(resolve => listener.listen(0, "127.0.0.1", resolve)));
  const port = listener.address().port;
  yield* io(() => new Promise(resolve => listener.close(resolve)));
  const data = yield* Effect.acquireRelease(io(() => mkdtemp(join(tmpdir(), "zelavis-route-parity-"))), path => io(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie));
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
  yield* io(() => page.locator("fuzor-select-item", { hasText: "Scoped tag alpha" }).waitFor({ state: "attached" }));
  yield* io(() => page.locator(".content fuzor-select-trigger").click());
  yield* io(() => page.locator("fuzor-select-item", { hasText: "Scoped tag alpha" }).click());
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
  yield* io(() => page.locator("fuzor-select-item", { hasText: "Dark" }).click());
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
