import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A Project's persistent host (`_node-project-runner.js`, one per running Project and one per managed app's
// integration runtime) only supervises its engine and holds the handover. Everything it imports stays resident
// for the Project's lifetime, so its module graph must not grow the Project driver, service loading, identity,
// the database or Effect's barrel (`effect` rather than `effect/<Module>`), which together more than doubled it.
const runner = fileURLToPath(new URL("../dist/adapters/_node-project-runner.js", import.meta.url));
const hook = `
import { registerHooks } from "node:module";
const seen = [];
registerHooks({ load(url, context, next) { seen.push(url); return next(url, context); } });
process.on("exit", () => { process.stderr.write("\\nLOADED " + JSON.stringify(seen) + "\\n"); });
`;

test("a Project's persistent host loads only what supervising its engine needs", () => {
  // Without its environment the runner refuses to start, after its whole static graph has loaded.
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, runner], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 30_000,
  });
  const line = result.stderr.split("\n").find(entry => entry.startsWith("LOADED "));
  assert.ok(line, `runner reported no modules: ${result.stderr}`);
  const loaded = JSON.parse(line.slice("LOADED ".length));
  const own = loaded.filter(url => url.includes("/dist/") && !url.includes("/node_modules/")).map(url => url.slice(url.lastIndexOf("/dist/") + 6));
  const forbidden = own.filter(path => /^(app|db|platform\/(shared|settings)|cli)\//.test(path) && path !== "db/format.js"
    || ["service.js", "project.js", "core/index.js", "adapters/_local-runtime.js", "adapters/_node-project-runtime.js", "adapters/_package-acquisition.js",
      "adapters/_node-runtime-artifact.js", "adapters/_node-runtime-catalog.js"].includes(path));
  assert.deepEqual(forbidden, [], "the host must not load the Project driver, service loading, identity or the database");
  assert.ok(!loaded.some(url => /\/node_modules\/effect\/dist\/index\.js$/.test(url)), "host files import effect/<Module>, never the effect barrel");
  assert.ok(!loaded.some(url => /\/node_modules\/(effect\/dist\/(Schema|Stream)\.js|jose\/)/.test(url)), "the host needs neither Schema, Stream nor jose");
  assert.ok(own.length <= 60, `the host loads ${own.length} Zelavis modules`);
});
