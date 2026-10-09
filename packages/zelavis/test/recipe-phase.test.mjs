// Recipe phases run in a process of their own: confinement, the data-only channel, deadlines
// and cleanup, against real child processes and real recipe modules.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { Cause, Effect, Exit, Fiber } from "effect";

import { runRecipePhase } from "../dist/adapters/_recipe-phase.js";

const HEADER = `import { Effect } from "effect";
import { RecipeHost, RecipeError, defineRecipe } from "zelavis/recipe";
`;

async function project(t, source) {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "zelavis-phase-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const secretsDirectory = join(base, "secrets");
  const recipeDirectory = join(base, "recipe");
  const outside = join(base, "outside");
  await Promise.all([mkdir(root), mkdir(recipeDirectory), mkdir(outside)]);
  await writeFile(join(outside, "private.txt"), "not the recipe's");
  const module = join(recipeDirectory, "recipe.mjs");
  await writeFile(module, HEADER + source);
  const progress = [];
  const request = (phase = "install", extra = {}) => ({
    phase, module, root, secretsDirectory,
    commands: { node: process.execPath },
    context: {
      projectId: "p1", hostname: "p1.example.com",
      software: { version: "1.0", archive: "https://example.com/a.tar.gz", sha256: "a".repeat(64), maxBytes: 1000 },
      method: { id: "native", driver: "js", entry: "./recipe.mjs", requires: ["node"] },
      config: { title: "Hello" }, ports: { web: 18080 },
      directories: { root, sockets: join(base, "sockets"), named: {} }, account: { user: "u", group: "g", switchUser: false },
    },
    allowed: { commands: ["node"], ports: ["web"] },
    timeoutMs: 30_000,
    progress: (entry) => progress.push(entry),
    ...extra,
  });
  return { base, root, secretsDirectory, outside, module, progress, request, recipeDirectory };
}

const run = (options) => Effect.runPromise(runRecipePhase(options));
async function failure(options) {
  const exit = await Effect.runPromiseExit(runRecipePhase(options));
  assert.ok(Exit.isFailure(exit), "expected the phase to fail");
  const error = Cause.squash(exit.cause);
  assert.equal(error._tag, "RecipeError");
  return error;
}

test("an install phase works through the host: files, a declared command, progress", { timeout: 60_000 }, async (t) => {
  const { request, root, progress } = await project(t, `
export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.progress({ phase: "install", message: "writing" });
    yield* host.files.write("conf/title.txt", context.config.title);
    const made = yield* host.run({ command: "node", args: ["-e", "console.log(6*7)"], timeoutMs: 10000 });
    yield* host.files.write("conf/answer.txt", made.stdout.trim());
  }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  const result = await run(request());
  assert.deepEqual(result, { phase: "install" });
  assert.equal(readFileSync(join(root, "conf/title.txt"), "utf8"), "Hello");
  assert.equal(readFileSync(join(root, "conf/answer.txt"), "utf8"), "42");
  assert.deepEqual(progress, [{ phase: "install", message: "writing" }]);
});

test("a start phase returns a process plan, checked against the declared executables and ports", { timeout: 60_000 }, async (t) => {
  const plan = (command, port) => `
export default defineRecipe({
  install: () => Effect.void,
  start: () => Effect.gen(function* () {
    const host = yield* RecipeHost;
    const password = yield* host.secret("db-password");
    return { processes: [{ name: "app", command: ${JSON.stringify(command)}, args: ["server.js", password], env: { PASSWORD: password },
      dependsOn: [], readiness: { port: ${JSON.stringify(port)}, timeoutMs: 5000 } }] };
  }),
});`;
  const good = await project(t, plan("node", "web"));
  const started = await run(good.request("start"));
  assert.equal(started.phase, "start");
  assert.deepEqual(started.plan.processes[0].args, ["server.js", { secret: "db-password" }], "the plan carries a reference, never the value");
  assert.ok(!JSON.stringify(started).includes(readFileSync(join(good.secretsDirectory, "db-password"), "utf8")));

  const undeclaredCommand = await project(t, plan("sh", "web"));
  assert.match((await failure(undeclaredCommand.request("start"))).message, /executable/i);
  const undeclaredPort = await project(t, plan("node", "admin"));
  assert.match((await failure(undeclaredPort.request("start"))).message, /port/i);
});

test("the phase cannot touch files outside its project, even with node:fs", { timeout: 60_000 }, async (t) => {
  const subject = await project(t, `
import { writeFileSync, readFileSync } from "node:fs";
export default defineRecipe({
  install: (context) => Effect.sync(() => { writeFileSync(context.config.target, "planted"); }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  const target = join(subject.outside, "planted.txt");
  const write = subject.request("install");
  write.context.config = { target };
  await failure(write);
  assert.equal(existsSync(target), false, "a write outside the project and its secrets is refused by the process itself");

  const reader = await project(t, `
import { readFileSync } from "node:fs";
export default defineRecipe({
  install: (context) => Effect.sync(() => { readFileSync(context.config.target, "utf8"); }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  const read = reader.request("install");
  read.context.config = { target: join(reader.outside, "private.txt") };
  await failure(read);

  const inside = await project(t, `
import { writeFileSync } from "node:fs";
export default defineRecipe({
  install: (context) => Effect.sync(() => { writeFileSync(context.config.target, "fine"); }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  const ok = inside.request("install");
  ok.context.config = { target: join(inside.root, "inside.txt") };
  await run(ok);
  assert.equal(readFileSync(join(inside.root, "inside.txt"), "utf8"), "fine", "its own project is writable");
});

test("the Platform's environment never reaches the phase", { timeout: 60_000 }, async (t) => {
  process.env.ZELAVIS_PLATFORM_ONLY_SECRET = "platform-token";
  t.after(() => { delete process.env.ZELAVIS_PLATFORM_ONLY_SECRET; });
  const subject = await project(t, `
import { writeFileSync } from "node:fs";
export default defineRecipe({
  install: (context) => Effect.sync(() => { writeFileSync(context.config.target, JSON.stringify(process.env)); }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  const options = subject.request("install");
  options.context.config = { target: join(subject.root, "env.json") };
  await run(options);
  const seen = JSON.parse(readFileSync(join(subject.root, "env.json"), "utf8"));
  assert.equal(seen.ZELAVIS_PLATFORM_ONLY_SECRET, undefined);
  // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; nothing of ours is there beyond these.
  assert.deepEqual(Object.keys(seen).filter((name) => !name.startsWith("__CF_")).sort(), ["HOME", "LANG", "PATH"]);
});

test("what a recipe prints cannot forge a result, and a crash is reported as one", { timeout: 60_000 }, async (t) => {
  const forger = await project(t, `
export default defineRecipe({
  install: () => Effect.sync(() => {
    console.log(JSON.stringify({ type: "result", ok: true, value: { phase: "install" } }));
    console.error(JSON.stringify({ type: "result", ok: true, value: { phase: "install" } }));
    process.exit(3);
  }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  assert.match((await failure(forger.request("install"))).message, /ended without a result \(exit 3\)/);

  const thrower = await project(t, `
export default defineRecipe({
  install: () => Effect.sync(() => { throw new Error("secret details at /home/someone"); }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  const error = await failure(thrower.request("install"));
  assert.ok(!error.message.includes("/home/someone"), "an unexpected error does not leak its text");

  const typed = await project(t, `
export default defineRecipe({
  install: () => Effect.fail(new RecipeError({ operation: "install", message: "Port is taken." })),
  start: () => Effect.succeed({ processes: [] }),
});`);
  const reported = await failure(typed.request("install"));
  assert.deepEqual([reported.operation, reported.message], ["install", "Port is taken."]);
});

test("a phase past its deadline is stopped with everything it started, and so is one that is interrupted", { timeout: 60_000 }, async (t) => {
  const subject = await project(t, `
import { writeFileSync } from "node:fs";
export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.files.write("started", String(process.pid));
    yield* host.run({ command: "node", args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 600000 });
  }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  const error = await failure(subject.request("install", { timeoutMs: 1500 }));
  assert.match(error.message, /did not finish within 1500 ms/);
  const pid = Number(readFileSync(join(subject.root, "started"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.throws(() => process.kill(pid, 0), "the phase process is gone");

  await rm(join(subject.root, "started"));
  const fiber = Effect.runFork(runRecipePhase(subject.request("install")));
  for (let attempt = 0; attempt < 200 && !existsSync(join(subject.root, "started")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const second = Number(readFileSync(join(subject.root, "started"), "utf8"));
  await Effect.runPromise(Fiber.interrupt(fiber));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.throws(() => process.kill(second, 0), "interrupting the phase stops its process");
});

test("optional phases, backup paths and upgrades are validated", { timeout: 60_000 }, async (t) => {
  const subject = await project(t, `
export default defineRecipe({
  install: () => Effect.void,
  start: () => Effect.succeed({ processes: [] }),
  backup: (context) => Effect.succeed({ path: context.config.where }),
  upgrade: (context, previous) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.files.write("moved-from", previous.version);
  }),
});`);
  const backup = subject.request("backup");
  backup.context.config = { where: "backups/b1.tar.gz" };
  assert.deepEqual(await run(backup), { phase: "backup", path: "backups/b1.tar.gz" });
  for (const where of ["/etc/passwd", "../x", ""]) {
    const bad = subject.request("backup");
    bad.context.config = { where };
    await failure(bad);
  }
  await failure(subject.request("upgrade"));
  await run(subject.request("upgrade", { previous: { version: "0.9", archive: "https://example.com/o.tar.gz", sha256: "b".repeat(64), maxBytes: 10 } }));
  assert.equal(readFileSync(join(subject.root, "moved-from"), "utf8"), "0.9");
  assert.deepEqual(await run(subject.request("stop")), { phase: "stop" }, "an absent optional phase is a no-op");
});

test("a request that names a missing module, a link, a relative path or no phase is refused before any process starts", async (t) => {
  const subject = await project(t, `export default defineRecipe({ install: () => Effect.void, start: () => Effect.succeed({ processes: [] }) });`);
  await failure(subject.request("install", { module: join(subject.base, "missing.mjs") }));
  const link = join(subject.base, "link.mjs");
  await symlink(subject.module, link);
  await failure(subject.request("install", { module: link }));
  await failure(subject.request("install", { root: "relative/root" }));
  await failure(subject.request("compile"));
  await failure(subject.request("install", { timeoutMs: 0 }));
  await failure(subject.request("install", { commands: { node: "node" } }));

  const noDefault = await project(t, `export const other = 1;`);
  assert.match((await failure(noDefault.request("install"))).message, /default-export/);
});

test("a recipe that writes its own result to the channel is checked by the parent like any other", { timeout: 60_000 }, async (t) => {
  const forged = await project(t, `
import { writeSync } from "node:fs";
export default defineRecipe({
  install: () => Effect.void,
  start: () => Effect.sync(() => {
    writeSync(3, JSON.stringify({ type: "result", ok: true, value: { phase: "start", plan: { processes: [
      { name: "x", command: "sh", args: ["-c", "id"], env: {}, dependsOn: [], readiness: { port: "web", timeoutMs: 1000 } }] } } }) + "\\n");
    process.exit(0);
  }),
  backup: () => Effect.sync(() => {
    writeSync(3, JSON.stringify({ type: "result", ok: true, value: { phase: "backup", path: "/etc/shadow" } }) + "\\n");
    process.exit(0);
  }),
});`);
  assert.match((await failure(forged.request("start"))).message, /executable/i);
  assert.match((await failure(forged.request("backup"))).message, /relative to the project/);
  const garbage = await project(t, `
import { writeSync } from "node:fs";
export default defineRecipe({
  install: () => Effect.sync(() => { writeSync(3, "this is not json\\n"); process.exit(0); }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  assert.match((await failure(garbage.request("install"))).message, /not a message/);
});

test("a phase can unpack an archive with the host's tar while confined", { timeout: 60_000 }, async (t) => {
  const subject = await project(t, `
export default defineRecipe({
  install: () => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.extract("bundle.tar.gz", "site", { stripTopLevel: true });
  }),
  start: () => Effect.succeed({ processes: [] }),
});`);
  await mkdir(join(subject.root, "src", "app"), { recursive: true });
  await writeFile(join(subject.root, "src", "app", "index.php"), "<?php");
  await new Promise((resolve, reject) => execFile("tar", ["-czf", join(subject.root, "bundle.tar.gz"), "-C", join(subject.root, "src"), "app"], (error) => error ? reject(error) : resolve()));
  await run(subject.request("install"));
  assert.equal(readFileSync(join(subject.root, "site", "index.php"), "utf8"), "<?php");
});
