#!/usr/bin/env node
// Qualifies follower failover with real processes in separate containers on a private Docker network: a lease
// authority (the Platform's writer-lease routes), a writer and a follower, each with its own database. Two drills:
//
//   kill       SIGKILL the writer. The follower must be promoted once the lease lapses, hold every write the writer
//              acknowledged, and carry on writing; positions must continue without a gap.
//   partition  Cut the writer off from the network (it keeps running). It must refuse its own writes once its lease
//              cannot be proved, before the follower is promoted; the follower takes over; and when the network
//              returns the old writer sees it was superseded, follows the new one and ends holding exactly what it holds.
//
// Run on the owner's machine or any host with Docker: `pnpm release:qualify:failover`. Needs the repository built
// (`pnpm build`). IMAGE is a Node 22 image (`node:22-slim` by default); the repository is mounted read-only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE = process.env.ZELAVIS_QUALIFY_IMAGE ?? "node:22-slim";
const TTL = Number(process.env.ZELAVIS_QUALIFY_LEASE_MILLIS ?? 3000);
const run = process.pid.toString(36);
const docker = (...args) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
};
const dockerQuiet = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const wait = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "  ok  " : " FAIL "} ${what}`); if (!ok) failures.push(what); };

const events = (container) => dockerQuiet("logs", container).stdout.split("\n").concat(dockerQuiet("logs", container).stderr.split("\n"))
  .filter((line) => line.startsWith("{")).map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
const until = async (what, condition, millis = 60_000) => {
  for (const started = Date.now(); !condition(); await wait(100)) if (Date.now() - started > millis) throw new Error(`timed out waiting for ${what}`);
};

async function drill(name, body) {
  console.log(`\n== ${name} ==`);
  const net = `zvf-${run}-${name}`;
  const containers = [];
  const dirs = [];
  const start = (node, env, { alias } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "zv-failover-")); dirs.push(dir);
    const container = `${net}-${node}`;
    docker("run", "-d", "--name", container, "--network", net, "--network-alias", alias ?? node,
      ...Object.entries({ NAME: node, TTL_MILLIS: String(TTL), ...env }).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "-v", `${root}:/repo:ro`, "-v", `${dir}:/data`, IMAGE, `/repo/distribution/scripts/failover/${node === "authority" ? "authority" : "node"}.mjs`);
    containers.push(container);
    return container;
  };
  try {
    docker("network", "create", net);
    docker("network", "create", `${net}-r`);
    await body({ net, repl: `${net}-r`, start, events, until });
  } finally {
    for (const container of containers) dockerQuiet("rm", "-f", container);
    dockerQuiet("network", "rm", net);
    dockerQuiet("network", "rm", `${net}-r`);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

/** Stop a node writing but keep it serving, and give followers time to level out before anything is compared. */
const quiesce = async (container, followersMillis = 4000) => {
  dockerQuiet("kill", "-s", "USR2", container);
  await until(`${container} quiesced`, () => events(container).some((event) => event.event === "quiesced"));
  await wait(followersMillis);
};

/** The last `final` event of a container after a graceful stop. */
const finalOf = async (container) => {
  dockerQuiet("kill", "-s", "TERM", container);
  await until(`${container} final`, () => events(container).some((event) => event.event === "final"));
  return events(container).findLast((event) => event.event === "final");
};
const idsAcked = (list) => list.filter((event) => event.event === "acked").map((event) => event.id);
const number = (id) => Number(id.slice(1));

const common = (endpoint) => ({ AUTHORITY: "http://authority:8080", TOKEN: "drill-token", ENDPOINT: endpoint });

await drill("kill", async ({ start, until: wait_ }) => {
  start("authority", {});
  await wait(800);
  const a = start("A", { ROLE: "writer", ...common("http://A:8080") });
  await wait(800);
  const b = start("B", { ROLE: "standby", ...common("http://B:8080") });
  await wait_("the writer to have 25 acknowledged writes", () => idsAcked(events(a)).length >= 25, 90_000);
  const killedAt = Date.now();
  docker("kill", "-s", "KILL", a);
  console.log("  SIGKILL sent to the writer");
  await wait_("the follower to be promoted", () => events(b).some((event) => event.event === "promoted"), TTL * 6 + 30_000);
  const promoted = events(b).find((event) => event.event === "promoted");
  console.log(`  promoted ${promoted.at - killedAt} ms after the kill (lease ${TTL} ms): epoch ${promoted.epoch}, held ${promoted.held}, lost ${promoted.lostPositions}`);
  check(promoted.epoch === 2, "the new writer is at epoch 2");
  check(promoted.at - killedAt < TTL * 4, "promotion took no more than a few lease lifetimes");
  const acked = idsAcked(events(a));
  await wait_("the new writer to write", () => events(b).filter((event) => event.event === "committed" || event.event === "acked").length >= 10, 30_000);
  const final = await finalOf(b);
  const held = new Set(final.ids);
  check(acked.every((id) => held.has(id)), `every write the old writer acknowledged (${acked.length}) is on the new writer`);
  check(promoted.lostPositions === 0, "promotion reported no lost positions");
  const numbers = final.ids.map(number);
  const gaps = numbers.slice(1).filter((n, at) => n !== numbers[at] + 1);
  check(gaps.length === 0 || gaps.every((n, at) => n > numbers[numbers.indexOf(n) - 1]), "the log carries on after the kill");
  check(numbers.some((n) => n > Math.max(...acked.map(number))), "the new writer wrote past the old one");
});

await drill("partition", async ({ net, start, until: wait_ }) => {
  start("authority", {});
  await wait(800);
  const a = start("A", { ROLE: "writer", ...common("http://A:8080") });
  await wait(800);
  const b = start("B", { ROLE: "standby", ...common("http://B:8080") });
  // A third node that is never promoted: it must find the new writer from the lease alone.
  const c = start("C", { ROLE: "follower", ...common("http://C:8080") });
  await wait_("the writer to have 25 acknowledged writes", () => idsAcked(events(a)).length >= 25, 90_000);
  const cutAt = Date.now();
  docker("network", "disconnect", net, a);
  console.log("  the writer is cut off the network (still running)");
  await wait_("the old writer to refuse its own writes", () => events(a).some((event) => event.event === "refused" || event.event === "fenced"), TTL * 6 + 30_000);
  const refusedAt = (events(a).find((event) => event.event === "refused" || event.event === "fenced")).at;
  await wait_("the follower to be promoted", () => events(b).some((event) => event.event === "promoted"), TTL * 6 + 30_000);
  const promoted = events(b).find((event) => event.event === "promoted");
  console.log(`  old writer refused ${refusedAt - cutAt} ms after the cut; follower promoted ${promoted.at - cutAt} ms after it`);
  // The log line of a refusal is printed after each (slow) write attempt; what matters is when writes actually committed.
  const commits = events(a).filter((event) => event.event === "acked" || event.event === "committed");
  const lastCommit = Math.max(...commits.map((event) => event.committedAt));
  console.log(`  the old writer's last commit was ${promoted.casAt - lastCommit} ms before the promotion landed`);
  check(lastCommit < promoted.casAt, "every write the old writer committed landed before the follower was promoted: no moment with two writers");
  check(refusedAt < promoted.at + TTL, "and the old writer was told it could not write");
  await wait_("the new writer to write", () => events(b).filter((event) => event.event === "committed" || event.event === "acked").length >= 10, 30_000);

  docker("network", "connect", "--alias", "A", net, a);
  console.log("  the network is back");
  await wait_("the old writer to follow the new one", () => events(a).some((event) => event.event === "following"), 60_000);
  // Let the old writer converge on the new writer's log, then compare what each holds.
  await quiesce(b);
  const bFinalProbe = await finalOf(b);
  const aFinal = await finalOf(a);
  const cFinal = await finalOf(c);
  check(JSON.stringify(cFinal.by) === JSON.stringify(bFinalProbe.by), "the third follower, never promoted, found the new writer from the lease and holds exactly what it holds");
  const acked = idsAcked(events(a));
  check(acked.every((id) => bFinalProbe.ids.includes(id)), `every write the old writer acknowledged (${acked.length}) is on the new writer`);
  const same = JSON.stringify(aFinal.ids) === JSON.stringify(bFinalProbe.ids);
  check(same, "the returned writer holds exactly what the new writer holds");
  if (!same) {
    const onlyA = aFinal.ids.filter((id) => !bFinalProbe.ids.includes(id)), onlyB = bFinalProbe.ids.filter((id) => !aFinal.ids.includes(id));
    console.log(`    only on the returned writer: ${onlyA.join(" ") || "-"}\n    only on the new writer: ${onlyB.length} (${onlyB.slice(0, 5).join(" ")}…)\n    heads: returned ${aFinal.head}, new ${bFinalProbe.head}`);
    console.log(events(a).filter((event) => ["following", "follow-failed", "fenced"].includes(event.event)).map((event) => `    ${JSON.stringify(event)}`).join("\n"));
  }
});

await drill("unacknowledged-tail", async ({ net, repl, start, until: wait_ }) => {
  // Lease traffic on one network, replication on another, so the follower can be cut off from the writer alone.
  start("authority", {});
  await wait(800);
  const a = start("A", { ROLE: "writer", ...common("http://A-r:8080") });
  docker("network", "connect", "--alias", "A-r", repl, a);
  await wait(800);
  const b = start("B", { ROLE: "standby", ...common("http://B-r:8080") });
  docker("network", "connect", "--alias", "B-r", repl, b);
  await wait_("the writer to have 15 acknowledged writes", () => idsAcked(events(a)).length >= 15, 90_000);
  docker("network", "disconnect", repl, b);
  console.log("  the follower is cut off from the writer (both still reach the lease authority)");
  await wait_("the writer to commit writes nobody acknowledged", () => events(a).filter((event) => event.event === "committed").length >= 4, 60_000);
  const unacked = events(a).filter((event) => event.event === "committed").map((event) => event.id);
  docker("network", "disconnect", net, a);
  docker("network", "disconnect", repl, a);
  console.log(`  the writer is cut off entirely, holding ${unacked.length} writes that were never acknowledged`);
  await wait_("the follower to be promoted", () => events(b).some((event) => event.event === "promoted"), TTL * 6 + 30_000);
  const promoted = events(b).find((event) => event.event === "promoted");
  check(promoted.lostPositions === 0, "promotion lost no acknowledged position");
  await wait_("the new writer to write past the old tail", () => events(b).filter((event) => event.event === "committed" || event.event === "acked").length >= unacked.length + 6, 60_000);
  docker("network", "connect", net, a);
  docker("network", "connect", "--alias", "A-r", repl, a);
  docker("network", "connect", "--alias", "B-r", repl, b);
  console.log("  the network is back");
  await wait_("the old writer to follow the new one", () => events(a).some((event) => event.event === "following"), 60_000);
  await quiesce(b, 6000);
  const bFinal = await finalOf(b);
  const aFinal = await finalOf(a);
  const acked = idsAcked(events(a));
  check(acked.every((id) => bFinal.ids.includes(id) && bFinal.by[id] === "A"), `every acknowledged write (${acked.length}) is on the new writer, as the old writer wrote it`);
  // A write logged as unacknowledged may still have reached the follower just before the cut; only what it never saw is lost.
  const neverSeen = unacked.filter((id) => !promoted.ids.includes(id));
  console.log(`  ${unacked.length} writes were not acknowledged; ${neverSeen.length} of them never reached the follower`);
  check(neverSeen.length > 0, "the drill produced writes the follower never saw");
  check(neverSeen.some((id) => bFinal.by[id] === "B"), "the new writer's own writes took the place of the old writer's unacknowledged tail");
  const converged = JSON.stringify(aFinal.by) === JSON.stringify(bFinal.by);
  check(converged, "the returned writer was copied over: it holds exactly what the new writer holds, authors included");
  if (!converged) {
    const differing = [...new Set([...Object.keys(aFinal.by), ...Object.keys(bFinal.by)])].filter((id) => aFinal.by[id] !== bFinal.by[id]);
    console.log(`    differing: ${differing.map((id) => `${id}(A:${aFinal.by[id] ?? "-"} B:${bFinal.by[id] ?? "-"})`).join(" ")}; heads A ${aFinal.head} B ${bFinal.head}`);
    console.log(events(a).filter((event) => ["following", "follow-failed", "fenced"].includes(event.event)).map((event) => `    ${JSON.stringify(event).slice(0, 300)}`).join("\n"));
  }
  check(neverSeen.every((id) => aFinal.by[id] !== "A"), "none of the writes the follower never saw survived on the returned writer");
});

console.log(failures.length === 0 ? "\nFailover qualified." : `\n${failures.length} check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
