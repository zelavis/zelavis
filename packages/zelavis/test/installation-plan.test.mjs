import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeZelavisInstallationPlan, planZelavisReleaseInstall, planZelavisUninstall } from "../dist/core/runtime/installation-plan.js";

const paths = {
  prefix: "/opt/zelavis", dataDirectory: "/var/lib/zelavis", configDirectory: "/etc/zelavis",
  commandPath: "/usr/local/bin/zelavis", systemCommandPath: "/usr/bin/zelavis",
  systemdDirectories: ["/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"],
  aptSource: "/etc/apt/sources.list.d/zelavis.sources", aptKeyring: "/usr/share/keyrings/zelavis-archive-keyring.gpg",
};
const templates = {};
for (const file of ["zelavis.service", "zelavis-agent.service", "zelavis@.service", "zelavis-agent@.service", "zelavis-traefik.service", "traefik.yml"]) {
  templates[file] = await readFile(new URL(`../../../distribution/runtime/${file}`, import.meta.url), "utf8");
}

class FakeHost {
  files = new Map(); links = new Map(); directories = new Set(); accounts = new Set(); actions = [];
  pathCommand; tokens = 0; fail;
  constructor() { this.release("1.0.0"); }
  release(version) {
    this.files.set("/stage/manifest.json", JSON.stringify({ version }));
    for (const [file, content] of Object.entries(templates)) this.files.set(`/stage/share/${file}`, content);
  }
  resolve(path) {
    for (const [link, target] of this.links) if (path === link || path.startsWith(`${link}/`)) return this.resolve(target + path.slice(link.length));
    return path;
  }
  async exists(path) { return this.links.has(path) || this.files.has(this.resolve(path)) || this.directories.has(this.resolve(path)); }
  async read(path) { return this.files.get(this.resolve(path)); }
  async readlink(path) { return this.links.get(path); }
  async which() { return this.pathCommand; }
  async accountExists(kind, name) { return this.accounts.has(`${kind}:${name}`); }
  async execute(a) {
    if (this.fail?.(a)) throw new Error("simulated host failure");
    this.actions.push(a);
    switch (a.kind) {
      case "mkdir": this.directories.add(a.path); break;
      case "copy":
        this.directories.add(a.path);
        for (const [path, content] of [...this.files]) if (path.startsWith(`${a.source}/`)) this.files.set(a.path + path.slice(a.source.length), content);
        break;
      case "link": this.links.set(a.path, a.target); break;
      case "write": if (!a.ifAbsent || !await this.exists(a.path)) this.files.set(a.path, a.content); break;
      case "bootstrap": if (!await this.exists(a.path)) { this.tokens++; this.files.set(a.path, "ZELAVIS_BOOTSTRAP_TOKEN=secret\n"); return "new token"; } break;
      case "agent-environment": {
        const content = await this.read(a.path);
        if (!/^ZELAVIS_AGENT_ENDPOINT=/m.test(content)) this.files.set(a.path, content + `ZELAVIS_AGENT_ENDPOINT=${a.endpoint}\n`);
        break;
      }
      case "command":
        if (a.command === "groupadd") this.accounts.add(`group:${a.args.at(-1)}`);
        if (a.command === "useradd") this.accounts.add(`user:${a.args.at(-1)}`);
        break;
      case "remove-link": if (this.links.get(a.path)?.startsWith(`${a.prefix}/`)) this.links.delete(a.path); break;
      case "remove":
        for (const store of [this.files, this.links, this.directories]) for (const path of store.keys()) if (path === a.path || a.recursive && path.startsWith(`${a.path}/`)) store.delete(path);
        break;
    }
  }
}
const install = (host, options = {}) => planZelavisReleaseInstall({ host, paths, source: "/stage", system: true, ...options });

test("fresh install plans the existing inventory, without mutations or secret material", async () => {
  const host = new FakeHost();
  const plan = await install(host);
  assert.equal(host.actions.length, 0);
  assert.equal(plan.instance, "default");
  assert.equal(plan.steps.find((step) => step.id === "user").idempotent, false);
  assert.equal(plan.steps.find((step) => step.id === "bootstrap").idempotent, true);
  assert.doesNotMatch(JSON.stringify(plan), /ZELAVIS_BOOTSTRAP_TOKEN=/);
  await executeZelavisInstallationPlan(host, plan);
  assert.equal(host.links.get("/opt/zelavis/current"), "/opt/zelavis/releases/1.0.0");
  assert.equal(host.tokens, 1);
  assert.match(await host.read("/etc/systemd/system/zelavis.service"), /--host 127\.0\.0\.1/);
  assert.ok(host.actions.some((a) => a.command === "systemctl" && a.args.join(" ") === "disable zelavis-traefik.service"));
  assert.ok(!host.actions.some((a) => a.command === "systemctl" && a.args.includes("zelavis-agent.service")));
  assert.deepEqual(JSON.parse(await host.read("/opt/zelavis/installation.json")), { schemaVersion: 2, port: 3000, edge: true, mode: "system", source: "release", instance: "default", installedBy: "cli", version: "1.0.0", prefix: paths.prefix, configDirectory: paths.configDirectory, dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, ownsUser: true, ownsGroup: true });
});

test("rerun repairs units without recopying releases, recreating accounts or rotating tokens", async () => {
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host));
  host.files.set("/etc/zelavis/edge/traefik/traefik.yml", "operator config");
  const plan = await install(host);
  assert.ok(!plan.steps.some((step) => ["release", "user", "group"].includes(step.id)));
  await executeZelavisInstallationPlan(host, plan);
  assert.equal(host.tokens, 1);
  assert.equal(await host.read("/etc/zelavis/edge/traefik/traefik.yml"), "operator config");
  assert.equal(JSON.parse(await host.read("/opt/zelavis/installation.json")).ownsUser, true);
});

test("existing user and group remain operator-owned; existing env and Agent endpoint survive", async () => {
  const host = new FakeHost();
  host.accounts = new Set(["user:zelavis", "group:zelavis"]);
  host.files.set("/etc/zelavis/zelavis.env", "ZELAVIS_BOOTSTRAP_TOKEN=operator-secret\nZELAVIS_AGENT_ENDPOINT=/operator/agent\n");
  const plan = await install(host, { enableAgent: true });
  assert.doesNotMatch(JSON.stringify(plan), /operator-secret/);
  await executeZelavisInstallationPlan(host, plan);
  const receipt = JSON.parse(await host.read("/opt/zelavis/installation.json"));
  assert.equal(receipt.ownsUser, false); assert.equal(receipt.ownsGroup, false);
  assert.equal(host.tokens, 0);
  assert.match(await host.read("/etc/zelavis/zelavis.env"), /ENDPOINT=\/operator\/agent/);
  assert.ok(plan.steps.some((step) => step.id === "agent-enable"));
});

test("Agent opt-in adds its endpoint once, after systemd reload", async () => {
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host, { enableAgent: true }));
  const plan = await install(host, { enableAgent: true });
  await executeZelavisInstallationPlan(host, plan);
  assert.equal((await host.read("/etc/zelavis/zelavis.env")).match(/ZELAVIS_AGENT_ENDPOINT=/g).length, 1);
  assert.ok(plan.steps.findIndex((s) => s.id === "reload") < plan.steps.findIndex((s) => s.id === "agent-enable"));
});

test("upgrade keeps previous releases; downgrade requires an explicit flag including alpha versions", async () => {
  const host = new FakeHost(); host.release("2.0.0-alpha.9");
  await executeZelavisInstallationPlan(host, await install(host));
  host.release("2.0.0-alpha.10");
  const plan = await install(host);
  assert.ok(plan.steps.some((s) => s.id === "platform-restart"));
  await executeZelavisInstallationPlan(host, plan);
  assert.ok(await host.exists("/opt/zelavis/releases/2.0.0-alpha.9"));
  host.release("2.0.0-alpha.2");
  const before = host.actions.length;
  await assert.rejects(install(host), /Refusing downgrade/);
  assert.equal(host.actions.length, before);
  await executeZelavisInstallationPlan(host, await install(host, { allowDowngrade: true }));
});

test("foreign command refuses before any mutation; force and PATH shadowing retain diagnostics", async () => {
  const host = new FakeHost(); host.links.set(paths.commandPath, "/foreign/npm/cli.js");
  await assert.rejects(install(host), /npm uninstall --global zelavis/);
  assert.equal(host.actions.length, 0);
  host.pathCommand = "/foreign/bin/zelavis";
  const plan = await install(host, { force: true });
  assert.match(plan.warnings.join("\n"), /Replacing.*PATH resolves/s);
});

test("public exposure changes only the template's bind address", async () => {
  const host = new FakeHost();
  const plan = await install(host, { public: true });
  await executeZelavisInstallationPlan(host, plan);
  assert.match(await host.read("/etc/systemd/system/zelavis.service"), /--host 0\.0\.0\.0/);
});

test("interrupted install rerun preserves recorded account ownership and repairs later steps", async () => {
  const host = new FakeHost(); host.fail = (a) => a.kind === "bootstrap";
  await assert.rejects(executeZelavisInstallationPlan(host, await install(host)), /simulated host failure/);
  host.fail = undefined;
  await executeZelavisInstallationPlan(host, await install(host));
  assert.equal(JSON.parse(await host.read("/opt/zelavis/installation.json")).ownsUser, true);
  assert.equal(host.tokens, 1);
});

test("uninstall inspects all paths and requires acknowledgement before executing the same inventory", async () => {
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host));
  host.files.set("/outside/backups/platform.tar.gz", "keep");
  host.links.set(paths.systemCommandPath, "/foreign/cli.js");
  const plan = planZelavisUninstall({ paths, hostCommands: true, ownsUser: true, ownsGroup: true });
  const before = host.actions.length;
  await assert.rejects(executeZelavisInstallationPlan(host, plan, "yes"), /DELETE-ALL/);
  assert.equal(host.actions.length, before);
  await executeZelavisInstallationPlan(host, plan, "DELETE-ALL-ZELAVIS-DATA");
  assert.equal(await host.exists(paths.prefix), false);
  assert.equal(await host.exists(paths.dataDirectory), false);
  assert.equal(await host.exists(paths.configDirectory), false);
  assert.equal(host.links.get(paths.systemCommandPath), "/foreign/cli.js");
  assert.equal(await host.read("/outside/backups/platform.tar.gz"), "keep");
});

test("user installation owns only its prefix, private environment and command; repair preserves token", async () => {
  const host = new FakeHost();
  const prefix = "/home/operator/.local/share/zelavis";
  const userPaths = { ...paths, prefix, dataDirectory: `${prefix}/data`, configDirectory: `${prefix}/config`, commandPath: "/home/operator/.local/bin/zelavis" };
  const create = () => install(host, { paths: userPaths, system: false, user: true });
  const plan = await create();
  assert.ok(plan.steps.every((step) => step.action.kind !== "command"));
  assert.deepEqual(plan.steps.find((step) => step.id === "bootstrap").action, { kind: "bootstrap", path: `${prefix}/config/zelavis.env`, dataDirectory: `${prefix}/data`, public: undefined });
  await executeZelavisInstallationPlan(host, plan);
  await executeZelavisInstallationPlan(host, await create());
  assert.equal(host.tokens, 1);
  assert.equal(JSON.parse(await host.read(`${prefix}/installation.json`)).mode, "user");
  assert.equal(await host.exists("/etc/systemd/system/zelavis.service"), false);
  await assert.rejects(install(host, { paths: userPaths, system: false, user: true, enableAgent: true }), /do not support/);
});


const namedPaths = (name) => ({ ...paths, instance: name, dataDirectory: `/var/lib/zelavis-${name}`, configDirectory: `/etc/zelavis-${name}` });
test("named instances select independent releases, accounts, units and tokens with Edge off", async () => {
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host));
  const defaultToken = await host.read("/etc/zelavis/zelavis.env");
  const secondary = namedPaths("preview");
  host.release("2.0.0");
  const plan = await install(host, { paths: secondary, port: 3100, enableAgent: true });
  assert.equal(plan.instance, "preview");
  assert.ok(!plan.steps.some((step) => ["edge-owner", "edge-disable", "command"].includes(step.id)));
  assert.ok(!plan.steps.some((step) => step.action.args?.includes("zelavis.service")));
  await executeZelavisInstallationPlan(host, plan);
  assert.equal(host.links.get("/opt/zelavis/current"), "/opt/zelavis/releases/1.0.0");
  assert.equal(host.links.get("/opt/zelavis/instances/preview/current"), "/opt/zelavis/releases/2.0.0");
  assert.equal(await host.read("/etc/zelavis/zelavis.env"), defaultToken);
  assert.ok(host.accounts.has("user:zelavis-preview"));
  assert.match(await host.read("/etc/systemd/system/zelavis@.service"), /User=zelavis-%i[\s\S]*serve --instance %i/);
  assert.ok(host.actions.some((a) => a.command === "systemctl" && a.args.join(" ") === "enable --now zelavis@preview.service"));
  const runtime = JSON.parse(await host.read("/opt/zelavis/instances/preview/runtime.json"));
  assert.equal(runtime.edge, false); assert.equal(runtime.port, 3100);
  assert.equal(runtime.dataDirectory, secondary.dataDirectory);
  const receipt = JSON.parse(await host.read("/opt/zelavis/instances/preview/installation.json"));
  assert.equal(receipt.instance, "preview"); assert.equal(receipt.edge, false);
  const repair = await install(host, { paths: secondary });
  assert.ok(!repair.steps.some((step) => ["user", "group", "release"].includes(step.id)));
  await executeZelavisInstallationPlan(host, repair);
  assert.equal(host.tokens, 2);
  assert.equal(JSON.parse(await host.read("/opt/zelavis/instances/preview/runtime.json")).port, 3100);
  host.release("3.0.0");
  await executeZelavisInstallationPlan(host, await install(host, { paths: secondary }));
  assert.equal(host.links.get("/opt/zelavis/current"), "/opt/zelavis/releases/1.0.0");
});
test("named-first creates a shared command, validates names/ports, and refuses user instances", async () => {
  const host = new FakeHost();
  await assert.rejects(install(host, { paths: namedPaths("preview") }), /explicit --port/);
  for (const name of ["../escape", "UPPER", "x%2f", "a".repeat(25)]) await assert.rejects(install(host, { paths: namedPaths(name), port: 3100 }), /Instance names/);
  for (const port of [0, 80, 3100.5, 65536]) await assert.rejects(install(host, { paths: namedPaths("preview"), port }), /port must/);
  await assert.rejects(install(host, { paths: namedPaths("preview"), port: 3100, user: true, system: false }), /system mode/);
  await executeZelavisInstallationPlan(host, await install(host, { paths: namedPaths("preview"), port: 3100 }));
  assert.equal(host.links.get(paths.commandPath), "/opt/zelavis/current/bin/zelavis");
  assert.equal(host.links.get("/opt/zelavis/current"), "/opt/zelavis/releases/1.0.0");
  assert.equal(await host.read("/opt/zelavis/installation.json"), undefined);
});
test("removal retains shared releases/templates/command/packages while another instance exists", () => {
  for (const selected of [paths, namedPaths("preview")]) {
    const plan = planZelavisUninstall({ paths: selected, hostCommands: true, ownsUser: true, ownsGroup: true, retainShared: true });
    assert.ok(!plan.steps.some((step) => step.action.kind === "purge-packages" || step.action.kind === "remove-link"));
    assert.ok(!plan.steps.some((step) => [paths.prefix, paths.aptSource, "/etc/systemd/system/zelavis@.service"].includes(step.action.path)));
    const account = plan.steps.find((step) => step.action.kind === "remove-account").action;
    assert.equal(account.account, selected.instance ? "zelavis-preview" : "zelavis");
    if (selected.instance) assert.ok(!plan.steps.some((step) => step.action.kind === "release-edge"));
  }
});
