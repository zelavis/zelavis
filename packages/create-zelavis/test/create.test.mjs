import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installationCommand, installationOverview, loadInstallerAssets, parseArguments, selectInstallMode } from "../dist/index.js";

test("create accepts machine-install flags and refuses folders and scaffold options", () => {
  const args = parseArguments(["--", "--user", "-y", "--public", "--dry-run"]);
  assert.equal(args.mode, "user"); assert.equal(args.yes, true); assert.equal(args.dryRun, true);
  assert.deepEqual(args.flags, ["--public"]);
  for (const input of [["my-app"], ["--global"], ["--no-install"], ["--pm", "bun"]]) assert.throws(() => parseArguments(input), /no folder argument/);
  assert.throws(() => parseArguments(["--user", "--system"]), /either/);
});

test("default modes cover Linux root/sudo/rootless and macOS; unsupported hosts refuse", () => {
  assert.equal(selectInstallMode(undefined, "linux", true, false), "system");
  assert.equal(selectInstallMode(undefined, "linux", false, true), "system");
  assert.equal(selectInstallMode(undefined, "linux", false, false), "user");
  assert.equal(selectInstallMode(undefined, "darwin", false, true), "user");
  assert.equal(selectInstallMode("user", "linux", true, true), "user");
  assert.throws(() => selectInstallMode("system", "darwin", false, true), /requires Linux/);
  assert.throws(() => selectInstallMode("system", "linux", false, false), /root or sudo/);
  assert.throws(() => selectInstallMode(undefined, "win32", false, false), /Unsupported/);
});

test("published create selects the exact Platform and ships the canonical bootstrap", async () => {
  const assets = await loadInstallerAssets();
  const platform = JSON.parse(await readFile(new URL("../../zelavis/package.json", import.meta.url), "utf8"));
  assert.equal(assets.version, platform.version);
  assert.equal(assets.script, await readFile(new URL("../../../distribution/installers/package-bootstrap.sh", import.meta.url), "utf8"));
});

test("sudo executes literal bootstrap code, never a user cache file or invoking runtime", async () => {
  const assets = await loadInstallerAssets();
  const command = installationCommand({ ...assets, mode: "system", root: false, flags: ["--force"] });
  assert.equal(command.command, "sudo");
  assert.deepEqual(command.args, ["--", "/bin/sh", "-c", assets.script, "--", assets.version, "--force"]);
  assert.doesNotMatch(command.args.join("\n"), /npx|node_modules|\.cache|process\.execPath/);
  assert.match(command.display, /^'sudo' '--' '\/bin\/sh'/);
  assert.throws(() => installationCommand({ ...assets, version: "latest", mode: "user", root: false }), /exact/);
  assert.throws(() => installationCommand({ ...assets, mode: "user", root: false, flags: ["--enable-agent"] }), /requires system/);
  assert.equal(installationCommand({ ...assets, mode: "user", root: false }).command, "/bin/sh");
});

test("dry-run and help create no state or subprocess bootstrap; no unattended install without yes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-create-dry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const dry = spawnSync(process.execPath, [cli, "--user", "--dry-run"], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: root } });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Exact installation command/);
  assert.match(dry.stdout, /No changes were made/);
  assert.match(dry.stdout, /\.local\/share\/zelavis/);
  const refused = spawnSync(process.execPath, [cli, "--user"], { cwd: root, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /pass --yes/);
  assert.deepEqual(await readdir(root), []);
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /No folder argument/);
});

test("overview shows fixed system paths and isolated user paths", () => {
  assert.match(installationOverview("system", "1.2.3"), /\/opt\/zelavis[\s\S]*\/var\/lib\/zelavis[\s\S]*\/etc\/zelavis/);
  assert.match(installationOverview("user", "1.2.3", "/home/operator"), /\/home\/operator\/\.local\/share\/zelavis\/data/);
});

test("invoking PATH is forwarded as literal diagnostic data while sudo execution keeps a trusted PATH", async () => {
  const assets = await loadInstallerAssets();
  const invokingPath = "/home/operator/.cache/bin:/tmp/$(touch unexpected):/usr/bin";
  const command = installationCommand({ ...assets, mode: "system", root: false, invokingPath, invokingHome: "/home/operator" });
  assert.deepEqual(command.args.slice(-4), ["--invoking-path", invokingPath, "--invoking-home", "/home/operator"]);
  assert.equal(command.args[1], "/bin/sh");
  assert.equal(command.args[3], assets.script);
  assert.match(assets.script, /PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.doesNotMatch(assets.script, /eval /);
});
