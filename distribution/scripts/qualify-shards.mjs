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
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE = process.env.ZELAVIS_QUALIFY_IMAGE ?? "node:22-slim";
const KEEP = process.env.ZELAVIS_QUALIFY_KEEP === "1";
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
const events = (container) => {
  const logs = dockerQuiet("logs", container);
  return `${logs.stdout}\n${logs.stderr}`.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
};
const until = async (what, condition, millis = 240_000) => {
  for (const started = Date.now(); !condition(); await wait(200)) if (Date.now() - started > millis) throw new Error(`timed out waiting for ${what}`);
};
// The data directories live in the containers (a Unix socket cannot be created on a macOS bind mount), so ask the container.
const sqliteFiles = (container) => {
  const found = dockerQuiet("exec", container, "find", "/data/shards", "-name", "*.sqlite");
  return found.status === 0 ? found.stdout.split("\n").filter(Boolean).length : 0;
};

const net = `zvs-${run}`;
const work = mkdtempSync(join(tmpdir(), "zv-shards-"));
const dirs = { certs: join(work, "certs"), shared: join(work, "shared") };
const containers = [];
let completed = false;
try {
  for (const directory of Object.values(dirs)) spawnSync("mkdir", ["-p", directory]);
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dirs.certs, "tls.key"), "-out", join(dirs.certs, "tls.crt"),
    "-days", "1", "-subj", "/CN=agent", "-addext", "subjectAltName=DNS:agent"], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`openssl failed\n${made.stderr}`);
  docker("network", "create", net);
  const start = (name, alias, script) => {
    const container = `${net}-${name}`;
    docker("run", "-d", "--name", container, "--network", net, "--network-alias", alias,
      "-v", `${root}:/repo:ro`, "-v", `${dirs.certs}:/certs:ro`, "-v", `${dirs.shared}:/shared`, "--tmpfs", "/data:rw,exec,mode=1777,size=2g",
      IMAGE, "node", `/repo/distribution/scripts/shards/${script}`);
    containers.push(container);
    return container;
  };
  console.log("\n== remote shard across containers ==");
  const agent = start("agent", "agent", "agent.mjs");
  await until("the Agent", () => events(agent).some((event) => event.event === "agent-ready"), 60_000);
  const platform = start("platform", "platform", "platform.mjs");
  await until("the shard to be placed", () => events(platform).some((event) => event.event === "placed"));
  check(sqliteFiles(agent) === 1, "the Agent's container holds the shard's SQLite file");
  await until("reads after placement", () => events(platform).some((event) => event.event === "read-placed"));
  const readPlaced = events(platform).find((event) => event.event === "read-placed");
  check(readPlaced.missing.length === 0, "every acknowledged write reads from the remote shard");
  docker("kill", "-s", "USR1", agent);
  await until("the Agent's read count", () => events(agent).some((event) => event.event === "reads"));
  const readCount = events(agent).find((event) => event.event === "reads");
  check(readCount.served >= readPlaced.acked, "those reads were served by the shard's Agent");

  docker("network", "disconnect", net, agent);
  console.log("  the Agent's network is cut");
  dockerQuiet("kill", "-s", "USR1", platform);
  await until("the partition check", () => events(platform).some((event) => event.event === "partition-checked"));
  const checked = events(platform).find((event) => event.event === "partition-checked");
  check(checked.refused === true, "a write to the remote shard is refused while the Agent is cut off");
  check(checked.readRefused === true, "a read of the remote shard is refused while the Agent is cut off");
  check(checked.localWriteOk === true, "a Tenant on a local shard still takes writes");

  docker("network", "connect", "--alias", "agent", net, agent);
  console.log("  the Agent's network is back");
  dockerQuiet("kill", "-s", "USR2", platform);
  await until("the heal check and the release", () => events(platform).some((event) => event.event === "released"));
  const healed = events(platform).find((event) => event.event === "healed");
  check(healed.missing.length === 0, `every acknowledged write (${healed.acked}) reads after the network returned`);
  const released = events(platform).find((event) => event.event === "released");
  check(released.phase === "done" && released.missing.length === 0, "the shard is released and every acknowledged write still reads");
  check(sqliteFiles(agent) === 0, "the Agent's storage is gone after the release");
  dockerQuiet("kill", "-s", "USR1", platform);
  await until("the replica to catch up", () => events(platform).some((event) => event.event === "replicated"));
  check(sqliteFiles(agent) === 1, "the Agent's container holds the replica's SQLite file");
  docker("network", "disconnect", net, agent);
  dockerQuiet("kill", "-s", "HUP", platform);
  await until("writes during the replica outage", () => events(platform).some((event) => event.event === "replica-cut"));
  check(events(platform).find((event) => event.event === "replica-cut").ok, "the local shard takes all writes during its replica's outage");

  docker("network", "connect", "--alias", "agent", net, agent);
  dockerQuiet("kill", "-s", "USR2", platform);
  await until("the replica to catch up and be removed", () => events(platform).some((event) => event.event === "unreplicated"));
  const replicaHealed = events(platform).find((event) => event.event === "replica-healed");
  check(Date.parse(replicaHealed.heldAsOf) > replicaHealed.lastWrite, "the replica catches up through the writes made during its outage");
  check(events(platform).find((event) => event.event === "unreplicated").phase === "done", "unreplicate finishes");
  check(sqliteFiles(agent) === 0, "the Agent's storage is gone after unreplicate");
  completed = true;
} finally {
  const keep = KEEP && (!completed || failures.length > 0);
  if (keep) for (const container of containers) {
    const logs = dockerQuiet("logs", container);
    writeFileSync(join(work, `${container}.log`), `${logs.stdout}${logs.stderr}`);
  }
  for (const container of containers) dockerQuiet("rm", "-f", container);
  dockerQuiet("network", "rm", net);
  if (keep) console.log(`  kept for inspection: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
if (failures.length > 0 || !completed) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log("\nremote shard qualification passed.");
