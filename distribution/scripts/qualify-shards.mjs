#!/usr/bin/env node
// Qualifies a remote App shard across machines: a Platform with a real @zelavis/app Project in one container, the Agent that
// hosts its shard in another, on a private Docker network. The drill places a shard, cuts the Agent's network while the
// Project keeps running (the remote shard must refuse writes and lose no acknowledged one), brings it back, and releases the
// shard (every acknowledged write must read, and the Agent's storage must be gone). The drill then adds a replica
// of a local shard, verifies the local shard still takes writes during the replica's outage, and removes the replica.
//
// ZELAVIS_QUALIFY_KEEP=1 keeps a failed run's data directories and container logs. Run on the owner's machine or any host
// with Docker: `pnpm release:qualify:shards`. Needs the repository built (`pnpm build`). IMAGE is a Node 22 image
// (`node:22-slim` by default); the repository is mounted read-only.
//
// Across machines: ZELAVIS_QUALIFY_SHARDS_AGENT_SSH=<user>@<host> (and ZELAVIS_QUALIFY_SHARDS_SSH_KEY=<key file>) runs the
// Agent on that machine instead: the packed candidate is unpacked into a directory of its own under /var/tmp there, and the
// Agent runs from it as `nobody` in a transient systemd unit (512 MiB, half a CPU), listening on 127.0.0.1 only. This
// machine reaches it through an SSH tunnel, and the network cut is the tunnel being killed. Needs root there (systemd-run)
// and the installed Zelavis release's private Node; nothing else on that machine is touched, and everything is removed
// afterwards.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE = process.env.ZELAVIS_QUALIFY_IMAGE ?? "node:22-slim";
const KEEP = process.env.ZELAVIS_QUALIFY_KEEP === "1";
const REMOTE = process.env.ZELAVIS_QUALIFY_SHARDS_AGENT_SSH;
const SSH_KEY = process.env.ZELAVIS_QUALIFY_SHARDS_SSH_KEY;
const REMOTE_PORT = 18443;
const run = process.pid.toString(36);
const docker = (...args) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
};
const dockerQuiet = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const wait = (millis) => new Promise((resolveWait) => setTimeout(resolveWait, millis));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "  ok  " : " FAIL "} ${what}`); if (!ok) failures.push(what); };
const parseEvents = (text) => text.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const events = (container) => {
  const logs = dockerQuiet("logs", container);
  return parseEvents(`${logs.stdout}\n${logs.stderr}`);
};
const sshOptions = [...(SSH_KEY ? ["-i", SSH_KEY, "-o", "IdentitiesOnly=yes"] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=5"];
const ssh = (command) => spawnSync("ssh", [...sshOptions, REMOTE, command], { encoding: "utf8" });
const sshOrThrow = (command) => {
  const result = ssh(command);
  if (result.status !== 0) throw new Error(`ssh ${REMOTE} ${command}\n${result.stdout}${result.stderr}`);
  return result.stdout;
};
const scp = (from, to) => {
  const result = spawnSync("scp", [...sshOptions, "-q", ...from, `${REMOTE}:${to}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`scp to ${to}\n${result.stderr}`);
};
const until = async (what, condition, millis = 240_000) => {
  for (const started = Date.now(); !condition(); await wait(200)) if (Date.now() - started > millis) throw new Error(`timed out waiting for ${what}`);
};
// The data directories live in the containers (a Unix socket cannot be created on a macOS bind mount), so ask the container.
const sqliteFiles = (container) => {
  const found = dockerQuiet("exec", container, "find", "/data/shards", "-name", "*.sqlite");
  return found.status === 0 ? found.stdout.split("\n").filter(Boolean).length : 0;
};

/** The Agent in a container on the drill's network: cut by disconnecting it. */
const containerAgent = (start, net) => {
  const container = start("agent", "agent", "agent.mjs");
  return {
    events: () => events(container),
    sqliteFiles: () => sqliteFiles(container),
    reads: () => docker("kill", "-s", "USR1", container),
    cut: () => docker("network", "disconnect", net, container),
    heal: () => docker("network", "connect", "--alias", "agent", net, container),
    close: () => undefined,
  };
};

/** The Agent on another machine, reached through an SSH tunnel: cut by killing the tunnel. */
const remoteAgent = (work, dirs) => {
  const directory = `/var/tmp/zv-drill-${run}`, unit = `zv-drill-${run}`;
  const packed = join(work, "pack");
  spawnSync("mkdir", ["-p", packed]);
  const pack = spawnSync("pnpm", ["--filter", "zelavis", "pack", "--pack-destination", packed], { cwd: root, encoding: "utf8" });
  if (pack.status !== 0) throw new Error(`pnpm pack failed\n${pack.stderr}`);
  const tarball = readdirSync(packed).find((name) => name.endsWith(".tgz"));
  /** One tunnel at a time: this machine's loopback port to the Agent's, the drill's only path to it. */
  const tunnel = (() => {
    let child;
    return {
      open: () => { child = spawn("ssh", [...sshOptions, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${REMOTE_PORT}:127.0.0.1:${REMOTE_PORT}`, REMOTE], { stdio: "ignore" }); },
      cut: () => { child?.kill("SIGKILL"); child = undefined; },
    };
  })();
  sshOrThrow(`set -e; mkdir -m 755 ${directory} ${directory}/certs ${directory}/shared; mkdir -m 700 ${directory}/data; chown nobody:nogroup ${directory}/data`);
  let trustCopy;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(trustCopy);
    tunnel.cut();
    ssh(`systemctl stop ${unit} 2>/dev/null; systemctl reset-failed ${unit} 2>/dev/null; rm -rf ${directory}`);
  };
  try {
    scp([join(packed, tarball), join(root, "distribution/scripts/shards/agent.mjs")], `${directory}/`);
    scp([join(dirs.certs, "tls.key"), join(dirs.certs, "tls.crt")], `${directory}/certs/`);
    const node = "/opt/zelavis/current/runtime/node/bin";
    sshOrThrow(`set -e; cd ${directory}; tar -xzf ${tarball}; chown -R nobody:nogroup certs shared; chmod 700 certs; chmod 600 certs/*; cd package; PATH=${node}:$PATH npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null`);
    sshOrThrow(`systemd-run --unit ${unit} --uid=nobody --gid=nogroup --property=MemoryMax=512M --property=CPUQuota=50% ` +
      `--setenv=ZELAVIS_DRILL_ROOT=${directory} --setenv=ZELAVIS_DRILL_PACKAGE=${directory}/package --setenv=ZELAVIS_DRILL_LISTEN=127.0.0.1:${REMOTE_PORT} ` +
      `${node}/node ${directory}/agent.mjs`);
  } catch (error) { close(); throw error; }
  tunnel.open();
  // The Agent trusts the Platform's keys once they are published; they are carried over as soon as they exist.
  trustCopy = setInterval(() => {
    if (!existsSync(join(dirs.shared, "trust.json"))) return;
    clearInterval(trustCopy);
    scp([join(dirs.shared, "trust.json")], `${directory}/shared/trust.json`);
    sshOrThrow(`chown nobody:nogroup ${directory}/shared/trust.json`);
  }, 500);
  return {
    events: () => {
      const logs = ssh(`journalctl -u ${unit} -o cat --no-pager`);
      return logs.status === 0 ? parseEvents(logs.stdout) : [];
    },
    sqliteFiles: () => {
      const found = ssh(`find ${directory}/data/shards -name '*.sqlite' 2>/dev/null`);
      return found.stdout.split("\n").filter(Boolean).length;
    },
    reads: () => sshOrThrow(`systemctl kill -s USR1 ${unit}`),
    cut: () => tunnel.cut(),
    heal: () => tunnel.open(),
    close,
  };
};

const net = `zvs-${run}`;
const work = mkdtempSync(join(tmpdir(), "zv-shards-"));
const dirs = { certs: join(work, "certs"), shared: join(work, "shared") };
const containers = [];
let completed = false;
let agent;
try {
  for (const directory of Object.values(dirs)) spawnSync("mkdir", ["-p", directory]);
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dirs.certs, "tls.key"), "-out", join(dirs.certs, "tls.crt"),
    "-days", "1", "-subj", "/CN=agent", "-addext", "subjectAltName=DNS:agent"], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`openssl failed\n${made.stderr}`);
  docker("network", "create", net);
  const start = (name, alias, script) => {
    const container = `${net}-${name}`;
    docker("run", "-d", "--name", container, "--network", net, "--network-alias", alias,
      ...(REMOTE && name === "platform" ? ["--add-host", "agent:host-gateway", "-e", `ZELAVIS_DRILL_AGENT_URL=https://agent:${REMOTE_PORT}`] : []),
      "-v", `${root}:/repo:ro`, "-v", `${dirs.certs}:/certs:ro`, "-v", `${dirs.shared}:/shared`, "--tmpfs", "/data:rw,exec,mode=1777,size=2g",
      IMAGE, "node", `/repo/distribution/scripts/shards/${script}`);
    containers.push(container);
    return container;
  };
  console.log(REMOTE ? `\n== remote shard across machines (Agent on ${REMOTE.split("@").pop()}) ==` : "\n== remote shard across containers ==");
  agent = REMOTE ? remoteAgent(work, dirs) : containerAgent(start, net);
  await until("the Agent", () => agent.events().some((event) => event.event === "agent-ready"), 120_000);
  const platform = start("platform", "platform", "platform.mjs");
  await until("the shard to be placed", () => events(platform).some((event) => event.event === "placed"));
  check(agent.sqliteFiles() === 1, "the Agent holds the shard's SQLite file");
  await until("reads after placement", () => events(platform).some((event) => event.event === "read-placed"));
  const readPlaced = events(platform).find((event) => event.event === "read-placed");
  check(readPlaced.missing.length === 0, "every acknowledged write reads from the remote shard");
  agent.reads();
  await until("the Agent's read count", () => agent.events().some((event) => event.event === "reads"));
  const readCount = agent.events().find((event) => event.event === "reads");
  check(readCount.served >= readPlaced.acked, "those reads were served by the shard's Agent");

  agent.cut();
  console.log("  the Agent's network is cut");
  dockerQuiet("kill", "-s", "USR1", platform);
  await until("the partition check", () => events(platform).some((event) => event.event === "partition-checked"));
  const checked = events(platform).find((event) => event.event === "partition-checked");
  check(checked.refused === true, "a write to the remote shard is refused while the Agent is cut off");
  check(checked.readRefused === true, "a read of the remote shard is refused while the Agent is cut off");
  check(checked.localWriteOk === true, "a Tenant on a local shard still takes writes");

  agent.heal();
  console.log("  the Agent's network is back");
  dockerQuiet("kill", "-s", "USR2", platform);
  await until("the heal check and the release", () => events(platform).some((event) => event.event === "released"));
  const healed = events(platform).find((event) => event.event === "healed");
  check(healed.missing.length === 0, `every acknowledged write (${healed.acked}) reads after the network returned`);
  const released = events(platform).find((event) => event.event === "released");
  check(released.phase === "done" && released.missing.length === 0, "the shard is released and every acknowledged write still reads");
  check(agent.sqliteFiles() === 0, "the Agent's storage is gone after the release");
  dockerQuiet("kill", "-s", "USR1", platform);
  await until("the replica to catch up", () => events(platform).some((event) => event.event === "replicated"));
  check(agent.sqliteFiles() === 1, "the Agent holds the replica's SQLite file");
  agent.cut();
  dockerQuiet("kill", "-s", "HUP", platform);
  await until("writes during the replica outage", () => events(platform).some((event) => event.event === "replica-cut"));
  check(events(platform).find((event) => event.event === "replica-cut").ok, "the local shard takes all writes during its replica's outage");

  agent.heal();
  dockerQuiet("kill", "-s", "USR2", platform);
  await until("the replica to catch up and be removed", () => events(platform).some((event) => event.event === "unreplicated"));
  const replicaHealed = events(platform).find((event) => event.event === "replica-healed");
  check(Date.parse(replicaHealed.heldAsOf) > replicaHealed.lastWrite, "the replica catches up through the writes made during its outage");
  check(events(platform).find((event) => event.event === "unreplicated").phase === "done", "unreplicate finishes");
  check(agent.sqliteFiles() === 0, "the Agent's storage is gone after unreplicate");
  completed = true;
} finally {
  const keep = KEEP && (!completed || failures.length > 0);
  if (keep) for (const container of containers) {
    const logs = dockerQuiet("logs", container);
    writeFileSync(join(work, `${container}.log`), `${logs.stdout}${logs.stderr}`);
  }
  if (keep && agent && REMOTE) writeFileSync(join(work, "remote-agent.log"), agent.events().map((event) => JSON.stringify(event)).join("\n"));
  agent?.close();
  for (const container of containers) dockerQuiet("rm", "-f", container);
  dockerQuiet("network", "rm", net);
  if (keep) console.log(`  kept for inspection: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
if (failures.length > 0 || !completed) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log("\nremote shard qualification passed.");
