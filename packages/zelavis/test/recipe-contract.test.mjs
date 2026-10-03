import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";
import {
  RecipeHost, RecipeError, defineRecipe, parseRecipeManifest, selectRecipeMethod, parseProcessPlan,
} from "zelavis/recipe";

const input = () => ({
  contract: 1,
  methods: [
    { id: "native", driver: "js", entry: "./dist/recipe.js", requires: ["nginx", "php-fpm", "mariadb"] },
    { id: "container", driver: "oci", image: `registry.example/app@sha256:${"a".repeat(64)}`, requires: ["docker"] },
  ],
  software: [{ version: "7.1.2", archive: "https://example.com/app.tar.gz", sha256: "b".repeat(64), maxBytes: 64 * 1024 * 1024 }],
  ports: [{ name: "web", protocol: "http" }],
});

test("verified recipe metadata is a strict immutable snapshot with independent software versions", () => {
  const source = input();
  const parsed = parseRecipeManifest(source);
  source.methods[0].requires[0] = "changed";
  source.software[0].version = "99.0";
  assert.equal(parsed.software[0].version, "7.1.2");
  assert.equal(parsed.methods[0].requires[0], "nginx");
  assert.ok(Object.isFrozen(parsed.methods[0].requires));
  assert.ok(Object.isFrozen(parsed.software[0]));
  assert.ok(Object.isFrozen(parsed.ports));
});

test("recipe manifests refuse ambiguous identities, paths, unpinned bytes and unbounded declarations", () => {
  const changes = [
    (m) => { m.contract = 2; },
    (m) => { m.methods[0].driver = "shell"; },
    (m) => { m.methods[0].id = "../native"; },
    (m) => { m.methods[0].entry = "./dist/../recipe.js"; },
    (m) => { m.methods[0].entry = "/tmp/recipe.js"; },
    (m) => { m.methods[1].image = "example/app:latest"; },
    (m) => { m.methods[1].image = `example/app@sha256:${"a".repeat(63)}`; },
    (m) => { m.methods[0].requires = ["nginx;id"]; },
    (m) => { m.methods[0].requires = Array.from({ length: 33 }, (_, i) => `tool-${i}`); },
    (m) => { m.methods[0].requires.push("nginx"); },
    (m) => { m.methods[1].id = m.methods[0].id; },
    (m) => { m.software.push({ ...m.software[0] }); },
    (m) => { m.ports.push({ ...m.ports[0] }); },
    (m) => { m.software[0].archive = "http://example.com/app.tar.gz"; },
    (m) => { m.software[0].archive = "https://user:secret@example.com/app.tar.gz"; },
    (m) => { m.software[0].maxBytes = 0; },
    (m) => { m.software[0].sha256 = "unknown"; },
    (m) => { m.software[0].version = "latest"; },
    (m) => { m.software[0].unexpected = true; },
    (m) => { m.methods[0].privileged = true; },
    (m) => { m.unexpected = true; },
    (m) => { m.methods = []; },
  ];
  for (const change of changes) {
    const manifest = input();
    change(manifest);
    assert.throws(() => parseRecipeManifest(manifest), (error) => error._tag === "InvalidRecipeManifest");
  }
});

test("selection uses host capabilities only at creation and never substitutes an explicit method", () => {
  const manifest = parseRecipeManifest(input());
  const host = { drivers: ["js"], requirements: ["nginx", "php-fpm", "mariadb"] };
  assert.equal(selectRecipeMethod(manifest, host).id, "native");
  assert.equal(selectRecipeMethod(manifest, { drivers: ["oci"], requirements: ["docker"] }).id, "container");
  assert.throws(() => selectRecipeMethod(manifest, { ...host, method: "container" }), /no alternative/);
  assert.throws(() => selectRecipeMethod(manifest, { ...host, method: "missing" }), /no alternative/);
  assert.throws(() => selectRecipeMethod(manifest, { ...host, requirements: [] }), /cannot satisfy/);
});

test("the same recipe runs entirely on an in-memory Effect host and returns data for supervision", async () => {
  const files = new Map();
  const events = [];
  const host = Layer.succeed(RecipeHost, {
    files: {
      mkdir: () => Effect.void,
      write: (path, text) => Effect.sync(() => { files.set(path, text); }),
      read: (path) => Effect.succeed(files.get(path)),
      remove: (path) => Effect.sync(() => { files.delete(path); }),
    },
    download: ({ destination }) => Effect.sync(() => { files.set(destination, "verified archive"); }),
    extract: () => Effect.void,
    run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    secret: (name) => Effect.succeed({ secret: name }),
    progress: (event) => Effect.sync(() => { events.push(event); }),
  });
  const manifest = parseRecipeManifest(input());
  const context = { projectId: "site-1", hostname: "site.example", config: {}, ports: { web: 12345 },
    software: manifest.software[0], method: manifest.methods[0] };
  const recipe = defineRecipe({
    install: Effect.fn("example.install")(function* (ctx) {
      const host = yield* RecipeHost;
      yield* host.download({ url: ctx.software.archive, sha256: ctx.software.sha256,
        maxBytes: ctx.software.maxBytes, destination: "archive.tar.gz" });
      yield* host.files.write("db-password", yield* host.secret("database"));
      yield* host.progress({ phase: "install", message: "Ready" });
    }),
    start: () => Effect.succeed({ processes: [{ name: "web", command: "nginx", args: ["-g", "daemon off;"],
      env: {}, dependsOn: [], readiness: { port: "web", timeoutMs: 30000 } }] }),
  });
  await Effect.runPromise(recipe.install(context).pipe(Effect.provide(host)));
  const plan = await Effect.runPromise(recipe.start(context).pipe(Effect.provide(host)));
  assert.equal(files.get("archive.tar.gz"), "verified archive");
  assert.deepEqual(files.get("db-password"), { secret: "database" });
  assert.equal(plan.processes[0].command, "nginx");
  assert.deepEqual(events, [{ phase: "install", message: "Ready" }]);
});

test("a failing phase retains its typed error and releases its scope", async () => {
  let released = false;
  const failure = new RecipeError({ operation: "install", message: "download refused" });
  const recipe = defineRecipe({
    install: () => Effect.scoped(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { released = true; }));
      return yield* failure;
    })),
    start: () => Effect.succeed({ processes: [] }),
  });
  const result = await Effect.runPromise(Effect.result(recipe.install({})));
  assert.equal(result._tag, "Failure");
  assert.equal(result.failure._tag, "RecipeError");
  assert.equal(released, true);
});

test("supervision plans reject undeclared commands and ports, missing dependencies and cycles", () => {
  const process = (name, dependsOn = []) => ({ name, command: "nginx", args: [], env: {}, dependsOn,
    readiness: { port: "web", timeoutMs: 30000 } });
  const allowed = { commands: ["nginx"], ports: ["web"] };
  const source = { processes: [process("db"), process("web", ["db"])] };
  source.processes[1].env.DB_PASSWORD = { secret: "database" };
  const parsed = parseProcessPlan(source, allowed);
  source.processes[1].env.DB_PASSWORD.secret = "changed";
  assert.equal(parsed.processes[1].env.DB_PASSWORD.secret, "database");
  assert.ok(Object.isFrozen(parsed.processes[1].env.DB_PASSWORD));
  const invalid = [
    { processes: [] },
    { processes: [process("web"), process("web")] },
    { processes: [{ ...process("web"), command: "sh" }] },
    { processes: [{ ...process("web"), command: "/bin/sh" }] },
    { processes: [process("web", ["missing"])] },
    { processes: [process("db", ["web"]), process("web", ["db"])] },
    { processes: [process("web", ["web"])] },
    { processes: [process("db"), process("web", ["db", "db"])] },
    { processes: [{ ...process("web"), readiness: { port: "public", timeoutMs: 30000 } }] },
    { processes: [{ ...process("web"), readiness: { port: "web", timeoutMs: 0 } }] },
    { processes: [{ ...process("web"), args: ["\0"] }] },
    { processes: [{ ...process("web"), privileged: true }] },
    { processes: [{ ...process("web"), env: { TOKEN: { secret: "secret", value: "leaked" } } }] },
  ];
  for (const plan of invalid) assert.throws(() => parseProcessPlan(plan, allowed), (error) => error._tag === "RecipeError");
  assert.throws(() => parseProcessPlan({ processes: [{ ...process("web"), env: {
    TOKEN: { secret: "secret", value: "sensitive-material" },
  } }] }, allowed), (error) => !String(error).includes("sensitive-material"));
});
