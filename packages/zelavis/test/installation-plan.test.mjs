import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeZelavisInstallationPlan, planZelavisReleaseInstall, planZelavisUninstall } from "../dist/core/runtime/installation-plan.js";

const paths = {
  prefix: "/opt/zelavis", dataDirectory: "/var/lib/zelavis", configDirectory: "/etc/zelavis",
  commandPath: "/usr/local/bin/zelavis", systemCommandPath: "/usr/bin/zelavis",
  systemdDirectories: ["/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"],
};
const templates = {};
for (const file of ["zelavis.service", "zelavis-agent.service", "zelavis@.service", "zelavis-agent@.service", "zelavis-host-agent.service", "zelavis-host-agent@.service", "zelavis-traefik.service", "zelavis-update.service", "zelavis-update.path", "zelavis.socket", "traefik.yml"]) {
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
        const variable = a.variable ?? "ZELAVIS_AGENT_ENDPOINT";
        if (!new RegExp(`^${variable}=`, "m").test(content)) this.files.set(a.path, content + `${variable}=${a.endpoint}\n`);
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
  assert.ok(host.actions.some((a) => a.command === "systemctl" && a.args.join(" ") === "enable zelavis-traefik.service"));
  for (const directory of ["edge", "edge/traefik", "edge/traefik/active"]) {
    const path = `${paths.dataDirectory}/${directory}`;
    assert.ok(host.actions.some(action => action.kind === "mkdir" && action.path === path && action.mode === 0o750));
    assert.ok(host.actions.some(action => action.command === "chown" && action.args.join(" ") === `root:zelavis ${path}`));
  }
  assert.ok(host.actions.some((a) => a.command === "systemctl" && a.args.join(" ") === "enable --now zelavis-agent.service"));
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
  const plan = await install(host, {});
  assert.doesNotMatch(JSON.stringify(plan), /operator-secret/);
  await executeZelavisInstallationPlan(host, plan);
  const receipt = JSON.parse(await host.read("/opt/zelavis/installation.json"));
  assert.equal(receipt.ownsUser, false); assert.equal(receipt.ownsGroup, false);
  assert.equal(host.tokens, 0);
  assert.match(await host.read("/etc/zelavis/zelavis.env"), /ENDPOINT=\/operator\/agent/);
  assert.ok(plan.steps.some((step) => step.id === "agent-enable"));
});

test("the separately supervised Agent endpoint is added once, after systemd reload", async () => {
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host, {}));
  const plan = await install(host, {});
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

test("the dashboard port is held by a socket unit, and a live update leaves the running Platform alone", async () => {
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host, { public: true }));
  assert.match(await host.read("/etc/systemd/system/zelavis.socket"), /ListenStream=0\.0\.0\.0:3000/);
  assert.ok(host.actions.some((a) => a.command === "systemctl" && a.args.join(" ") === "enable --now zelavis.socket"));
  host.release("1.0.1"); host.actions.length = 0;
  const plan = await install(host, { live: true, stopPlatform: true });
  assert.ok(!plan.steps.some((step) => ["platform-stop", "data-reservation", "data-handover", "data-owner"].includes(step.id)));
  await executeZelavisInstallationPlan(host, plan);
  // Selection and receipt changes belong to the nonce-bound host commit.
  assert.equal(host.links.get("/opt/zelavis/current"), "/opt/zelavis/releases/1.0.0");
  assert.equal(JSON.parse(await host.read("/opt/zelavis/installation.json")).version, "1.0.0");
  assert.ok(!host.actions.some((a) => a.command === "systemctl"));
  assert.ok(host.actions.some((a) => a.command === "/opt/zelavis/releases/1.0.1/runtime/node/bin/node" && a.args[0].endsWith("_node-runtime-select-cli.js")));
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
  await assert.rejects(install(host, { paths: userPaths, system: true, user: true }), /do not support/);
});


const namedPaths = (name) => ({ ...paths, instance: name, dataDirectory: `/var/lib/zelavis-${name}`, configDirectory: `/etc/zelavis-${name}` });
test("named instances select independent releases, accounts, units and tokens with Edge off", async () => {
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host));
  const defaultToken = await host.read("/etc/zelavis/zelavis.env");
  const secondary = namedPaths("preview");
  host.release("2.0.0");
  const plan = await install(host, { paths: secondary, port: 3100 });
  assert.equal(plan.instance, "preview");
  assert.ok(!plan.steps.some((step) => ["edge-owner", "edge-enable", "command"].includes(step.id)));
  assert.ok(!plan.steps.some((step) => step.action.args?.includes("zelavis.service")));
  await executeZelavisInstallationPlan(host, plan);
  assert.equal(host.links.get("/opt/zelavis/current"), "/opt/zelavis/releases/1.0.0");
  assert.equal(host.links.get("/opt/zelavis/instances/preview/current"), "/opt/zelavis/releases/2.0.0");
  assert.equal(await host.read("/etc/zelavis/zelavis.env"), defaultToken);
  assert.ok(host.accounts.has("user:zelavis-preview"));
  assert.match(await host.read("/etc/systemd/system/zelavis@.service"), /User=zelavis-%i[\s\S]*serve --instance %i/);
  const socket = await host.read("/etc/systemd/system/zelavis-preview.socket");
  assert.match(socket, /Service=zelavis@preview\.service/); assert.match(socket, /ListenStream=127\.0\.0\.1:3100/);
  assert.ok(host.actions.some((a) => a.command === "systemctl" && a.args.join(" ") === "enable --now zelavis@preview.service"));
  const watch = await host.read("/etc/systemd/system/zelavis-update-preview.path");
  assert.match(watch, /PathExists=\/var\/lib\/zelavis-preview\/update\/request\.json/); assert.match(watch, /Unit=zelavis-update-preview\.service/);
  assert.match(await host.read("/etc/systemd/system/zelavis-update-preview.service"), /Environment=ZELAVIS_DATA_DIR=\/var\/lib\/zelavis\n/);
  assert.match(await host.read("/etc/systemd/system/zelavis-update-preview.service"), /ExecStart=\/opt\/zelavis\/instances\/preview\/current\/bin\/zelavis update --run --instance preview/);
  assert.ok(host.actions.some((a) => a.command === "systemctl" && a.args.join(" ") === "enable --now zelavis-update-preview.path"));
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
    assert.ok(!plan.steps.some((step) => [paths.prefix, "/etc/systemd/system/zelavis@.service"].includes(step.action.path)));
    const account = plan.steps.find((step) => step.action.kind === "remove-account").action;
    assert.equal(account.account, selected.instance ? "zelavis-preview" : "zelavis");
    if (selected.instance) assert.ok(!plan.steps.some((step) => step.action.kind === "release-edge"));
  }
});


test("system updates wire a distinct root operation Agent and uninstall owns its inventory", async () => {
  const host = new FakeHost();
  const plan = await planZelavisReleaseInstall({ host, source: "/stage", paths, system: true });
  const operationUnit = plan.steps.find((step) => step.id === "zelavis-host-agent.service").action.content;
  assert.match(operationUnit, /^User=root$/m);
  assert.match(operationUnit, /--operations-only --endpoint-group-access/);
  assert.match(operationUnit, /--require-root-owned-operations --operation-cgroup delegated/);
  assert.match(operationUnit, /^Group=zelavis$/m);
  assert.deepEqual(plan.steps.find((step) => step.id === "host-agent-environment").action, { kind: "agent-environment", path: "/etc/zelavis/zelavis.env", endpoint: "/opt/zelavis/host-agent/agent", variable: "ZELAVIS_HOST_OPERATIONS_ENDPOINT" });
  assert.ok(plan.steps.findIndex((step) => step.id === "host-agent-enable") < plan.steps.findIndex((step) => step.id === "platform-enable"));
  assert.equal(plan.steps.some((step) => step.action.command === "apt-get"), false);
  const uninstall = planZelavisUninstall({ paths, hostCommands: true, ownsUser: true, ownsGroup: true });
  assert.ok(uninstall.steps.find((step) => step.id === "package-policy"));
  assert.ok(uninstall.steps.find((step) => step.action.path === "/etc/systemd/system/zelavis-host-agent@.service"));
  const retained = planZelavisUninstall({ paths, hostCommands: true, ownsUser: true, ownsGroup: true, retainShared: true });
  assert.equal(retained.steps.some((step) => step.id === "package-policy"), false, "another instance still owns the shared package policy");
  assert.ok(retained.steps.find((step) => step.action.path === "/opt/zelavis/host-agent"));
});

test("live host assets share fresh-install rendering without restarting services or changing data", async () => {
  const { planZelavisRuntimeHostAssetsProgram } = await import("../dist/core/runtime/installation-plan.js");
  const { Effect } = await import("effect");
  const files = new Map();
  for (const unit of ["zelavis@.service", "zelavis-agent@.service", "zelavis-host-agent@.service", "zelavis-update.path", "zelavis-update.service", "zelavis.socket"]) {
    files.set(`/candidate/share/${unit}`, unit.endsWith(".socket") ? "[Socket]\nListenStream=127.0.0.1:3000\nService=zelavis.service\n" : "[Service]\nExecStart=/opt/zelavis/current/bin/zelavis\nPathExists=/var/lib/zelavis/update/request.json\nupdate --run\n");
  }
  const selected = namedPaths("blue");
  const steps = await Effect.runPromise(planZelavisRuntimeHostAssetsProgram({ host: { read: async path => files.get(path) }, paths: selected, source: "/candidate", port: 3100, public: true }));
  assert.ok(steps.every(step => step.action.kind === "write"));
  const socket = steps.find(step => step.id === "zelavis-blue.socket");
  assert.match(socket.action.content, /ListenStream=0\.0\.0\.0:3100/);
  assert.match(socket.action.content, /Service=zelavis@blue\.service/);
  const update = steps.find(step => step.id === "zelavis-update-blue.service");
  assert.match(update.action.content, /instances\/blue\/current/);
  assert.match(update.action.content, /update --run --instance blue/);
  assert.ok(steps.every(step => step.action.path.startsWith("/etc/systemd/system/")));
});

test("host inventory materializes only the selected Edge publication and refuses malformed generations", async () => {
  const { planZelavisRuntimeHostAssetsProgram } = await import("../dist/core/runtime/installation-plan.js");
  const { Effect } = await import("effect");
  const host = new FakeHost(), base = "/var/lib/zelavis/edge/traefik";
  host.files.set(`${base}/active-generation.json`, JSON.stringify({ activeGeneration: "42" }));
  const configuration = JSON.stringify({ http: { routers: { platform: { rule: "PathPrefix(`/`)" } } } });
  host.files.set(`${base}/generations/42/traefik-dynamic.json`, configuration);
  const plan = () => Effect.runPromise(planZelavisRuntimeHostAssetsProgram({ host, paths, source: "/stage", port: 3000 }));
  const step = (await plan()).find(step => step.id === "edge-publication");
  assert.equal(step.action.path, `${base}/active/traefik-dynamic.yml`);
  assert.equal(step.action.content, configuration);
  assert.equal(step.action.atomic, true);
  for (const state of ["{", JSON.stringify({ activeGeneration: "../foreign" }), JSON.stringify({})]) {
    host.files.set(`${base}/active-generation.json`, state);
    await assert.rejects(plan());
  }
  assert.equal(host.actions.length, 0);
});
