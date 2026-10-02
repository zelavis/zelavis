import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compareVersions, isExactVersion, parseUpdateRun, updateChannel } from "../dist/updates.js";
import { createNodeUpdateControl } from "../dist/adapters/_node-updates.js";
import { runUpdate } from "../dist/adapters/_update-runner.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { Zelavis } from "../dist/index.js";

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-updates-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("versions order by semver, with numeric prerelease parts", () => {
  assert.ok(compareVersions("2.0.0-alpha.10", "2.0.0-alpha.9") > 0);
  assert.ok(compareVersions("2.0.0-alpha.9", "2.0.0-alpha.10") < 0);
  assert.ok(compareVersions("2.0.0", "2.0.0-alpha.99") > 0, "a release is newer than its prereleases");
  assert.ok(compareVersions("1.9.9", "2.0.0-alpha.1") < 0);
  assert.equal(compareVersions("2.0.0-alpha.8", "2.0.0-alpha.8"), 0);
  assert.ok(isExactVersion("2.0.0-alpha.8") && !isExactVersion("latest") && !isExactVersion("^2.0.0") && !isExactVersion("2.0"));
});

test("a version follows the channel it was published on", () => {
  assert.equal(updateChannel("2.0.0-alpha.8"), "alpha");
  assert.equal(updateChannel("2.0.0"), "latest");
  assert.equal(updateChannel("2.0.0-beta.1"), undefined, "an unpublished channel is never moved by itself");
  assert.equal(updateChannel("not a version"), undefined);
});

test("a status file written by another process is read as data, not trusted", () => {
  const good = { id: "u1", state: "succeeded", from: "2.0.0-alpha.8", to: "2.0.0-alpha.9", startedAt: "2026-10-02T10:00:00Z", finishedAt: "2026-10-02T10:01:00Z", message: "Updated.", log: ["a", "b"] };
  assert.deepEqual(parseUpdateRun(good), good);
  for (const bad of [null, [], "x", {}, { ...good, state: "weird" }, { ...good, from: "latest" }, { ...good, startedAt: "yesterday" }, { ...good, id: "x".repeat(200) }]) {
    assert.equal(parseUpdateRun(bad), undefined, JSON.stringify(bad)?.slice(0, 50));
  }
  assert.equal(parseUpdateRun({ ...good, to: "^3" }).to, undefined, "an unusable version is dropped, not kept");
  assert.equal(parseUpdateRun({ ...good, log: Array.from({ length: 100 }, (_, i) => String(i)) }).log.length, 40);
});

function registry(tags, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), redirect: init.redirect });
    if (tags instanceof Error) throw tags;
    return new Response(JSON.stringify(tags), { status: 200 });
  };
}

test("the Platform checks npm for its own channel and leaves a request for the root updater", async (t) => {
  const data = await scratch(t);
  await mkdir(join(data, "update"));
  const calls = [];
  const control = createNodeUpdateControl({ dataDirectory: data, currentVersion: "2.0.0-alpha.8", platform: "linux", schedule: false, fetch: registry({ latest: "1.0.1-alpha.2", alpha: "2.0.0-alpha.9" }, calls) });

  let status = await control.status();
  assert.deepEqual({ current: status.current, channel: status.channel, available: status.available, managed: status.managed, state: status.state }, { current: "2.0.0-alpha.8", channel: "alpha", available: false, managed: true, state: "idle" });
  assert.equal(status.latest, undefined, "nothing is known before a check, and status makes no call");
  assert.equal(calls.length, 0);

  status = await control.check();
  assert.equal(status.latest, "2.0.0-alpha.9");
  assert.equal(status.available, true);
  assert.equal(calls[0].redirect, "error", "a redirect is somewhere nobody named");
  assert.match(calls[0].url, /^https:\/\/registry\.npmjs\.org\//);

  status = await control.apply("owner@example.com");
  assert.equal(status.state, "requested");
  const request = JSON.parse(await readFile(join(data, "update", "request.json"), "utf8"));
  assert.deepEqual(Object.keys(request).sort(), ["id", "requestedAt", "requestedBy"], "the request names no version for the updater to follow");
  await assert.rejects(control.apply("again"), { code: "busy" });
});

test("an update is refused when it cannot or need not run", async (t) => {
  const data = await scratch(t);
  const options = { dataDirectory: data, platform: "linux", schedule: false };
  // No updater folder: this install was not set up to update itself.
  const unmanaged = createNodeUpdateControl({ ...options, currentVersion: "2.0.0-alpha.8", fetch: registry({ alpha: "2.0.0-alpha.9" }) });
  assert.equal((await unmanaged.status()).managed, false);
  await assert.rejects(unmanaged.apply("x"), { code: "unmanaged" });
  assert.equal((await createNodeUpdateControl({ ...options, platform: "darwin", currentVersion: "2.0.0-alpha.8" }).status()).managed, false, "only Linux servers update themselves");

  await mkdir(join(data, "update"));
  const current = createNodeUpdateControl({ ...options, currentVersion: "2.0.0-alpha.9", fetch: registry({ alpha: "2.0.0-alpha.9" }) });
  await assert.rejects(current.apply("x"), { code: "up-to-date" });
  const older = createNodeUpdateControl({ ...options, currentVersion: "2.0.0-alpha.9", fetch: registry({ alpha: "2.0.0-alpha.3" }) });
  assert.equal((await older.check()).available, false, "an older version is never an update");
  await assert.rejects(older.apply("x"), { code: "up-to-date" });
  const offline = createNodeUpdateControl({ ...options, currentVersion: "2.0.0-alpha.8", fetch: registry(new Error("offline")) });
  const status = await offline.check();
  assert.equal(status.checkError, "offline");
  await assert.rejects(offline.apply("x"), { code: "unchecked" });
  const odd = createNodeUpdateControl({ ...options, currentVersion: "2.0.0-alpha.8", fetch: registry({ alpha: "latest" }) });
  assert.match((await odd.check()).checkError, /no version/, "a tag is never taken for a version");
  const beta = createNodeUpdateControl({ ...options, currentVersion: "2.0.0-beta.1", fetch: registry({ alpha: "2.0.0-alpha.9" }) });
  assert.equal((await beta.status()).managed, false);
});

test("progress comes from the file the root updater writes, and a silent run is not shown as running forever", async (t) => {
  const data = await scratch(t);
  await mkdir(join(data, "update"));
  let clock = Date.parse("2026-10-02T10:00:00Z");
  const control = createNodeUpdateControl({ dataDirectory: data, currentVersion: "2.0.0-alpha.8", platform: "linux", schedule: false, now: () => clock, fetch: registry({ alpha: "2.0.0-alpha.9" }) });
  const run = { id: "u1", state: "running", from: "2.0.0-alpha.8", to: "2.0.0-alpha.9", startedAt: "2026-10-02T10:00:00Z", message: "Installing 2.0.0-alpha.9." };
  await writeFile(join(data, "update", "status.json"), JSON.stringify(run));
  assert.deepEqual((await control.status()).run.message, "Installing 2.0.0-alpha.9.");
  assert.equal((await control.status()).state, "running");
  clock += 21 * 60_000;
  const stale = await control.status();
  assert.equal(stale.state, "failed");
  assert.match(stale.run.message, /stopped reporting/);
  await writeFile(join(data, "update", "status.json"), "not json");
  assert.equal((await control.status()).state, "idle", "an unreadable file is ignored");
});

test("the same status is available over HTTP and the SDK, and updating needs its own permission", async (t) => {
  const data = await scratch(t);
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: false, projects: false }) });
  t.after(() => zv.close());
  const call = (path, principal, method = "GET") => zv.fetch(new Request(`http://localhost/zelavis/api/v1/runtime/updates${path}`, { method }), { principal });
  const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
  const viewer = { id: "v", type: "user", permissions: ["system.updates.view"] };
  const nobody = { id: "n", type: "user", permissions: [] };

  assert.equal((await call("", nobody)).status, 403);
  assert.equal((await call("/check", viewer, "POST")).status, 403, "looking is not updating");
  assert.equal((await call("/apply", viewer, "POST")).status, 403);

  const http = await (await call("", owner.principal ?? owner)).json();
  assert.equal(http.managed, false, "a development run cannot update itself");
  assert.ok(http.unmanagedReason);
  const refused = await call("/apply", owner, "POST");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "unmanaged");

  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), { principal: owner }) });
  assert.deepEqual(await client.updates.status(), http, "the SDK returns what the route returns");
  await assert.rejects(client.updates.apply(), { status: 409 });
});

// --- the root updater -------------------------------------------------------

/** A prefix as the installer leaves it: versioned releases, `current`, a receipt and a data folder. */
async function installation(t, version = "2.0.0-alpha.8") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zelavis-updater-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, "opt");
  const dataDirectory = join(root, "data");
  await mkdir(join(prefix, "releases", version, "platform", "dist", "installation-assets"), { recursive: true });
  await writeFile(join(prefix, "releases", version, "platform", "dist", "installation-assets", "install.sh"), "#!/bin/sh\n");
  await symlink(join(prefix, "releases", version), join(prefix, "current"));
  await writeFile(join(prefix, "installation.json"), JSON.stringify({ mode: "system", instance: "default", version, port: 3000 }));
  await mkdir(join(dataDirectory, "update"), { recursive: true });
  return { root, prefix, dataDirectory, version };
}
const request = (data, body = { id: "req-1" }) => writeFile(join(data, "update", "request.json"), JSON.stringify(body));
const status = async (data) => JSON.parse(await readFile(join(data, "update", "status.json"), "utf8"));
const exists = (path) => access(path).then(() => true, () => false);

function updater(t, state, overrides = {}) {
  const commands = [];
  const options = {
    prefix: state.prefix,
    dataDirectory: state.dataDirectory,
    socketUnitFile: join(state.root, "zelavis.socket"),
    channelVersion: async () => "2.0.0-alpha.9",
    sleep: async () => undefined,
    healthy: async () => true,
    healthTimeoutMs: 50,
    async run(command, args) {
      commands.push([command, ...args]);
      // Phase 1: the embedded installer prepares the release beside the running one.
      if (command === "sh") {
        const target = args[args.indexOf("--version") + 1];
        await mkdir(join(state.prefix, "releases", target, "platform", "dist", "installation-assets"), { recursive: true });
        return { code: 0, output: `Installing Zelavis ${target}\nFirst-run bootstrap token: SECRET\nPrepared Zelavis ${target}.\n` };
      }
      // Phase 2 (and a rollback): a release's own installer selects that release.
      if (args.includes("--from-release")) {
        await rm(join(state.prefix, "current"), { force: true });
        await symlink(args[args.indexOf("--from-release") + 1], join(state.prefix, "current"));
      }
      return { code: 0, output: "" };
    },
    ...overrides,
  };
  return { options, commands };
}

test("the root updater installs the newest version with the installer shipped in the current release", async (t) => {
  const state = await installation(t);
  await request(state.dataDirectory, { id: "req-1", version: "9.9.9-evil", requestedBy: "someone" });
  const { options, commands } = updater(t, state);
  const result = await runUpdate(options);

  assert.equal(result.state, "succeeded");
  assert.equal(result.to, "2.0.0-alpha.9", "the version comes from the registry, never from the request");
  // Prepare first, with the installer that shipped in the release that is running...
  assert.deepEqual(commands[0], ["sh", join(state.prefix, "releases", state.version, "platform", "dist", "installation-assets", "install.sh"), "--version", "2.0.0-alpha.9", "--stage-only"]);
  // ...then swap with the new release's own installer and its own Node.
  const target = join(state.prefix, "releases", "2.0.0-alpha.9");
  assert.deepEqual(commands[1], [join(target, "runtime", "node", "bin", "node"), join(target, "platform", "dist", "cli.js"), "install", "--from-release", target, "--installed-by", "script"]);
  assert.equal(await exists(join(state.dataDirectory, "update", "request.json")), false, "the request is consumed first");
  assert.deepEqual(await status(state.dataDirectory), result);
  assert.ok(!JSON.stringify(result).includes("SECRET"), "the installer's token never reaches the status file");
  assert.ok(await exists(join(state.prefix, "releases", state.version)), "the replaced release is kept for rollback");
});

test("with no request there is nothing to do, and an update to the same version is a no-op", async (t) => {
  const state = await installation(t);
  const { options, commands } = updater(t, state);
  assert.equal(await runUpdate(options), undefined);
  await request(state.dataDirectory);
  const same = await runUpdate({ ...options, channelVersion: async () => state.version });
  assert.equal(same.state, "succeeded");
  assert.match(same.message, /newest/);
  assert.equal(commands.length, 0, "nothing was installed");
  await request(state.dataDirectory);
  const older = await runUpdate({ ...options, channelVersion: async () => "2.0.0-alpha.1" });
  assert.equal(older.to, state.version, "an older version is never installed");
  assert.equal(commands.length, 0);
});

test("a failed lookup, a build off any channel and a non-system installation are refused", async (t) => {
  const state = await installation(t);
  await request(state.dataDirectory);
  const failed = await runUpdate({ ...updater(t, state).options, channelVersion: async () => { throw new Error("offline"); } });
  assert.equal(failed.state, "failed");
  assert.match(failed.message, /offline/);

  const beta = await installation(t, "2.0.0-beta.1");
  await request(beta.dataDirectory);
  assert.equal((await runUpdate(updater(t, beta).options)).state, "failed");

  const user = await installation(t);
  await writeFile(join(user.prefix, "installation.json"), JSON.stringify({ mode: "user", instance: "default", version: user.version, port: 3000 }));
  await request(user.dataDirectory);
  await assert.rejects(runUpdate(updater(t, user).options), /default system installation/);
});

test("a release that never answers is rolled back to the previous one, which is running again", async (t) => {
  const state = await installation(t);
  await request(state.dataDirectory);
  const { options, commands } = updater(t, state, {
    // Silent while the new release is selected; answers once the old one is selected again and
    // restarted (the updater's own restart is the fallback when the installer's did not bring it back).
    healthy: async () => commands.some((command) => command.includes("--allow-downgrade")) && commands.some((command) => command[0] === "systemctl"),
  });
  const result = await runUpdate(options);

  assert.equal(result.state, "rolled-back");
  assert.match(result.message, /did not answer/);
  assert.match(result.message, /Rolled back to 2\.0\.0-alpha\.8, which is running again/);
  const back = commands.find((command) => command.includes("--allow-downgrade"));
  assert.ok(back, "the previous release is selected again");
  assert.equal(back[0], join(state.prefix, "releases", state.version, "runtime", "node", "bin", "node"), "by the previous release's own Node");
  assert.deepEqual(back.slice(2, 5), ["install", "--from-release", join(state.prefix, "releases", state.version)]);
  assert.ok(commands.some((command) => command[0] === "systemctl" && command.includes("restart")));
  assert.equal((await status(state.dataDirectory)).state, "rolled-back");
  assert.deepEqual(await readdir(join(state.prefix, "releases")), [state.version], "the release that did not work is removed");
});

test("a release that cannot be prepared changes nothing: the running one is never touched", async (t) => {
  const state = await installation(t);
  await request(state.dataDirectory);
  const { options, commands } = updater(t, state, { async run(command) { commands.push([command]); return { code: 1, output: "npm error 404\n" }; } });
  const result = await runUpdate(options);
  assert.equal(result.state, "failed");
  assert.match(result.message, /Could not prepare 2\.0\.0-alpha\.9, so nothing was changed/);
  assert.match(result.log.join("\n"), /npm error/);
  assert.equal(commands.length, 1, "no swap and no restart were attempted");
  assert.equal((await readlink(join(state.prefix, "current"))), join(state.prefix, "releases", state.version));
});

test("a swap that fails is rolled back, and a rollback that does not recover says so", async (t) => {
  const state = await installation(t);
  await request(state.dataDirectory);
  const failing = updater(t, state, {
    async run(command, args) {
      if (command === "sh") { await mkdir(join(state.prefix, "releases", "2.0.0-alpha.9"), { recursive: true }); return { code: 0, output: "" }; }
      return args.includes("--allow-downgrade") ? { code: 0, output: "" } : { code: 1, output: "install error\n" };
    },
  });
  const result = await runUpdate(failing.options);
  assert.equal(result.state, "rolled-back");
  assert.match(result.message, /stopped with an error/);
  assert.match(result.log.join("\n"), /install error/);

  const hopeless = await installation(t);
  await request(hopeless.dataDirectory);
  const stuck = await runUpdate(updater(t, hopeless, { healthy: async () => false, async run(command) { return command === "sh" ? { code: 0, output: "" } : { code: 1, output: "" }; } }).options);
  assert.equal(stuck.state, "rolled-back");
  assert.match(stuck.message, /did not bring it back/);
});

test("the swap is live only once systemd holds the port, and a running release is not restarted for nothing", async (t) => {
  const first = await installation(t);
  await request(first.dataDirectory);
  const before = updater(t, first);
  await runUpdate(before.options);
  assert.ok(!before.commands[1].includes("--live"), "before the socket exists the full installer runs");

  const held = await installation(t);
  await writeFile(join(held.root, "zelavis.socket"), "[Socket]\n");
  await request(held.dataDirectory);
  const after = updater(t, held);
  const done = await runUpdate(after.options);
  assert.equal(done.state, "succeeded");
  assert.ok(after.commands[1].includes("--live"), "with the socket held the swap needs no stop");
  assert.ok(!after.commands.some((command) => command[0] === "systemctl"), "the updater does not restart a healthy Platform itself");

  // A swap that failed before it began leaves the old release answering, so nothing is restarted.
  const calm = await installation(t);
  await writeFile(join(calm.root, "zelavis.socket"), "[Socket]\n");
  await request(calm.dataDirectory);
  const early = updater(t, calm, { async run(command) { return command === "sh" ? { code: 0, output: "" } : { code: 1, output: "preflight refused\n" }; } });
  const refused = await runUpdate(early.options);
  assert.equal(refused.state, "rolled-back");
  assert.match(refused.message, /Rolled back to 2\.0\.0-alpha\.8, which is running again/);
});

test("after a good update only the new release, the one just replaced and instance selections are kept", async (t) => {
  const state = await installation(t);
  for (const old of ["1.0.0", "2.0.0-alpha.1"]) await mkdir(join(state.prefix, "releases", old), { recursive: true });
  await mkdir(join(state.prefix, "releases", "2.0.0-alpha.5"), { recursive: true });
  await mkdir(join(state.prefix, "instances", "preview"), { recursive: true });
  await symlink(join(state.prefix, "releases", "2.0.0-alpha.5"), join(state.prefix, "instances", "preview", "current"));
  await request(state.dataDirectory);
  assert.equal((await runUpdate(updater(t, state).options)).state, "succeeded");
  assert.deepEqual((await readdir(join(state.prefix, "releases"))).sort(), ["2.0.0-alpha.5", "2.0.0-alpha.8", "2.0.0-alpha.9"]);
});
