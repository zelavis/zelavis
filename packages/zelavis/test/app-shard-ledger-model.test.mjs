import assert from "node:assert/strict";
import test from "node:test";

import { createAppShardPlacementAuthority } from "../dist/platform/app-data-placement.js";
import { createMemorySystemStore } from "../dist/system-store.js";

// A seeded model of the shard ledger: sequential operations are checked against an exact model of the
// transition table, and interleaved ones (two authorities, one store) against the ledger's invariants.
// A failure names its seed and the last operations so it can be replayed.

const allocation = { projectId: "p", generation: 1, allowedNodeIds: ["n1", "n2"], cpuCores: 3, memoryBytes: 300, diskBytes: 300 };
const nodes = ["n1", "n2"].map((id) => ({ id, ready: true, cpuCores: 8, memoryBytes: 1000, diskBytes: 1000 }));
const SHARDS = ["s0", "s1", "s2", "s3"];
const REPLICA_KEYS = SHARDS.map((shard) => `${shard}.replica`);
const SHARD_KEYS = [...SHARDS, ...REPLICA_KEYS];
const caller = { nodeId: "n1" };

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const makeAuthority = (store) => createAppShardPlacementAuthority({
  store, allocation: () => allocation, nodes: () => nodes, randomId: () => "incarnation-1",
});

/** What the transition table says an operation does to an entry (undefined: it is refused). */
function expected(entry, op, placements) {
  if (!entry) return undefined;
  const sameOp = op.operationId === undefined || op.operationId === entry.operationId;
  switch (op.kind) {
    case "begin":
      if (!sameOp) return undefined;
      if (entry.state === "reserved") return { state: "preparing", epoch: entry.epoch + 1 };
      return entry.state === "preparing" || entry.state === "committed" ? { state: entry.state, epoch: entry.epoch } : undefined;
    case "commit":
      if (!sameOp || (entry.state !== "preparing" && entry.state !== "committed") || entry.epoch !== op.epoch) return undefined;
      return { state: "committed", epoch: entry.epoch };
    case "reissue":
      if (entry.state !== "committed" || op.projectEpoch < entry.projectEpoch) return undefined;
      return op.projectEpoch === entry.projectEpoch ? { state: "committed", epoch: entry.epoch } : { state: "committed", epoch: entry.epoch + 1 };
    case "release":
    case "unreplicate":
      if (!sameOp) return undefined;
      if (entry.state === "releasing" || entry.state === "released") return { state: entry.state, epoch: entry.epoch };
      if (entry.role === "primary" && placements.some((copy) => copy.of === entry.shardId && copy.state !== "released")) return undefined;
      if (entry.state === "reserved") return { state: "released", epoch: entry.epoch };
      return { state: "releasing", epoch: entry.epoch };
    case "complete":
      if ((entry.state !== "releasing" && entry.state !== "released") || entry.epoch !== op.epoch) return undefined;
      return { state: "released", epoch: entry.epoch };
    default:
      return undefined;
  }
}

function run(authority, op) {
  const base = { projectId: "p", shardId: op.shardId };
  switch (op.kind) {
    case "request":
    case "replicate": return authority.request("p", {
      protocolVersion: 1, operationId: op.operationId, projectId: "p", shardId: op.shardId, mapVersion: 1,
      expectedRevision: op.expectedRevision, durability: "crash",
      ...(op.kind === "replicate"
        ? { intent: "replica", of: op.shardId.slice(0, -".replica".length), virtualRanges: [], resources: { cpuCores: 0, memoryBytes: 0, diskBytes: 100 } }
        : { intent: "allocate", virtualRanges: op.ranges, resources: { cpuCores: 1, memoryBytes: 100, diskBytes: 100 } }),
    }, caller);
    case "begin": return authority.beginActivation({ ...base, operationId: op.operationId, projectEpoch: op.projectEpoch });
    case "commit": return authority.commitActivation({ ...base, operationId: op.operationId, epoch: op.epoch });
    case "reissue": return authority.reissue({ ...base, projectEpoch: op.projectEpoch });
    case "release":
    case "unreplicate": return authority.beginRelease({ ...base, operationId: op.operationId });
    default: return authority.completeRelease({ ...base, epoch: op.epoch });
  }
}

function checkInvariants(view, highWater, context) {
  const fail = (message) => assert.fail(`${message}\n${context()}`);
  const seen = new Set();
  const ranges = new Set();
  const replicas = new Set();
  const live = view.placements.filter((entry) => entry.state !== "released");
  let cpu = 0;
  let disk = 0;
  for (const entry of view.placements) {
    if (seen.has(entry.shardId)) fail(`duplicate entry for ${entry.shardId}`);
    seen.add(entry.shardId);
    if (entry.epoch < (highWater.get(entry.shardId) ?? 0)) fail(`epoch of ${entry.shardId} fell to ${entry.epoch}`);
    highWater.set(entry.shardId, entry.epoch);
    if (entry.state === "reserved" && entry.projectEpoch !== 0) fail("reserved entry carries a project epoch");
    if (entry.state === "released") continue;
    cpu += entry.resources.cpuCores;
    disk += entry.resources.diskBytes;
    if (entry.role === "replica") {
      if (replicas.has(entry.of)) fail(`more than one live replica of ${entry.of}`);
      replicas.add(entry.of);
      const primary = live.find((candidate) => candidate.shardId === entry.of);
      if (primary?.state === "releasing") fail(`primary ${entry.of} is releasing while its replica is live`);
      if (entry.nodeId === (primary?.nodeId ?? caller.nodeId)) fail(`replica and primary ${entry.of} share a Node`);
      if (entry.virtualRanges.length !== 0) fail("replica owns virtual ranges");
    }
    for (const range of entry.virtualRanges) {
      if (ranges.has(range)) fail(`range ${range} held twice`);
      ranges.add(range);
    }
  }
  if (cpu > allocation.cpuCores) fail(`live cpu ${cpu} exceeds the allocation`);
  if (disk > allocation.diskBytes) fail(`live disk ${disk} exceeds the allocation`);
}

test("the shard ledger holds its invariants over 200 seeded operation sequences", async () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = prng(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const store = createMemorySystemStore();
    const authorities = [makeAuthority(store), makeAuthority(store)];
    const trace = [];
    const highWater = new Map();
    const context = () => `seed ${seed}; last operations:\n${trace.slice(-10).map((line) => JSON.stringify(line)).join("\n")}`;
    for (let step = 0; step < 60; step += 1) {
      const before = await authorities[0].list("p");
      const action = pick(["request", "request", "replicate", "begin", "commit", "reissue", "release", "complete"]);
      const candidates = action === "request" ? SHARDS : action === "replicate" ? REPLICA_KEYS : SHARD_KEYS;
      const shardId = pick(candidates);
      const kind = action === "release" && shardId.endsWith(".replica") ? "unreplicate" : action;
      const entry = before.placements.find((candidate) => candidate.shardId === shardId);
      const operationId = entry && random() < 0.8 ? entry.operationId : `op${Math.floor(random() * 12)}`;
      const op = {
        kind, shardId, operationId,
        epoch: entry && random() < 0.8 ? entry.epoch : Math.floor(random() * 4),
        projectEpoch: Math.max(1, entry && random() < 0.7 ? entry.projectEpoch + Math.floor(random() * 2) : 1 + Math.floor(random() * 5)),
        ranges: [SHARDS.indexOf(shardId) * 2, SHARDS.indexOf(shardId) * 2 + 1],
        expectedRevision: random() < 0.85 ? before.revision : before.revision + 1,
      };
      trace.push(op);
      if (random() < 0.25) {
        // Interleaved: two authorities each run an operation at once; only the invariants are checked.
        const other = { ...op, shardId: pick(candidates), operationId: `op${Math.floor(random() * 12)}` };
        other.ranges = [SHARDS.indexOf(other.shardId) * 2, SHARDS.indexOf(other.shardId) * 2 + 1];
        trace.push(other);
        await Promise.all([run(authorities[0], op), run(authorities[1], other)]);
      } else {
        const answer = await run(authorities[0], op);
        const after = await authorities[1].list("p");
        if (kind === "request" || kind === "replicate") {
          if (answer.granted) {
            assert.ok(!entry || entry.state === "released", `a live shard was replaced\n${context()}`);
            assert.equal(answer.placement.epoch, entry?.epoch ?? 0, `a re-request did not continue the epoch\n${context()}`);
          }
        } else {
          const predicted = expected(entry, op, before.placements);
          assert.equal(answer.granted, predicted !== undefined, `answer ${JSON.stringify(answer)} against ${JSON.stringify(predicted)}\n${context()}`);
          if (predicted) assert.deepEqual([answer.placement.state, answer.placement.epoch], [predicted.state, predicted.epoch], context());
          const now = after.placements.find((candidate) => candidate.shardId === shardId);
          const keep = predicted ?? (entry && { state: entry.state, epoch: entry.epoch });
          if (keep) assert.deepEqual([now.state, now.epoch], [keep.state, keep.epoch], context());
        }
      }
      const view = await authorities[0].list("p");
      checkInvariants(view, highWater, context);
      if (view.incarnation !== undefined) assert.equal(view.incarnation, "incarnation-1", context());
    }
  }
});
