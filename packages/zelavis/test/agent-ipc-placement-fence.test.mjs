import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentProcessClient,
  createAgentProcessServer,
} from "../dist/adapters/_agent-ipc.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { createProjectPlacementAuthority } from "../dist/platform/project-placement-authority.js";

test("Agent refuses an unplaced Project and stops a process on foreign ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-fence-"));
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, "state"), graceMs: 100 });
  let ownerSession = "session-a";
  const server = await createAgentProcessServer({
    directory: join(directory, "endpoint"),
    runner,
    placement: {
      isProjectWorkload: (id) => id === "project-a",
      checkIntervalMs: 20,
      read: async (projectId) => ({
        projectId, nodeId: "node-a", ownerSession, epoch: 1,
        state: "active", authorityNow: Date.now(), leaseExpiresAt: Date.now() + 500,
      }),
    },
  });
  const client = await createAgentProcessClient({ directory: join(directory, "endpoint") });
  try {
    const file = join(directory, "child.mjs");
    await writeFile(file, "setInterval(() => {}, 1000);", "utf8");
    const command = {
      workloadId: "project-a", executable: process.execPath,
      args: [file], cwd: directory, env: {},
    };
    await assert.rejects(client.start(command), /placement authority is required/i);
    const child = await client.start({ ...command, placement: {
      projectId: "project-a", nodeId: "node-a", ownerSession: "session-a", epoch: 1,
    } });
    assert.equal(child.running, true);
    ownerSession = "session-b";
    const exit = await Promise.race([
      child.exit,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Agent did not self-fence")), 1000)),
    ]);
    assert.equal(exit.requested, true);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agent proves an expired placement stopped before takeover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-takeover-"));
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, "state"), graceMs: 100 });
  const placement = {
    projectId: "project-a", nodeId: "node-a", ownerSession: "session-a", epoch: 3,
  };
  const expiresAt = Date.now() + 200;
  const server = await createAgentProcessServer({
    directory: join(directory, "endpoint"), runner,
    placement: {
      isProjectWorkload: (id) => id === placement.projectId,
      checkIntervalMs: 20,
      read: async () => ({ ...placement, state: "active", authorityNow: Date.now(), leaseExpiresAt: expiresAt }),
    },
  });
  const client = await createAgentProcessClient({ directory: join(directory, "endpoint") });
  try {
    const file = join(directory, "child.mjs");
    await writeFile(file, "setInterval(() => {}, 1000);", "utf8");
    const child = await client.start({
      workloadId: placement.projectId, placement, executable: process.execPath,
      args: [file], cwd: directory, env: {},
    });
    assert.equal(await client.fencePlacement(placement).catch(() => false), false);
    await new Promise((resolve) => setTimeout(resolve, 230));
    assert.equal(await client.fencePlacement({ ...placement, epoch: 2 }).catch(() => false), false);
    assert.equal(await client.fencePlacement(placement), true);
    assert.equal((await child.exit).requested, true);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Platform CAS advances epoch only after the Agent fences the expired owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-cas-takeover-"));
  const store = createMemorySystemStore();
  let client;
  const authority = createProjectPlacementAuthority({
    store, mayPlace: () => true,
    fencePrevious: async (previous) => client?.fencePlacement({
      projectId: previous.projectId, nodeId: previous.nodeId,
      ownerSession: previous.ownerSession, epoch: previous.epoch,
    }) ?? false,
  });
  const server = await createAgentProcessServer({
    directory: join(directory, "endpoint"),
    runner: createLocalAgentProcessRunner({ stateDirectory: join(directory, "state"), graceMs: 100 }),
    placement: {
      isProjectWorkload: (id) => id === "project-a",
      checkIntervalMs: 20,
      read: async (projectId) => {
        const value = await authority.current(projectId);
        return value ? { ...value, authorityNow: Date.now() } : undefined;
      },
    },
  });
  client = await createAgentProcessClient({ directory: join(directory, "endpoint") });
  try {
    const first = await authority.acquire({
      projectId: "project-a", nodeId: "node-a", ownerSession: "session-a",
      expectedEpoch: 0, leaseMs: 250,
    });
    assert.equal(first.granted, true);
    const token = { projectId: "project-a", nodeId: "node-a", ownerSession: "session-a", epoch: 1 };
    const file = join(directory, "child.mjs");
    await writeFile(file, "setInterval(() => {}, 1000);", "utf8");
    const child = await client.start({
      workloadId: "project-a", placement: token, executable: process.execPath,
      args: [file], cwd: directory, env: {},
    });
    assert.equal((await authority.acquire({
      projectId: "project-a", nodeId: "node-a", ownerSession: "session-b",
      expectedEpoch: 1, leaseMs: 250,
    })).reason, "owned");
    await new Promise((resolve) => setTimeout(resolve, 280));
    const successor = await authority.acquire({
      projectId: "project-a", nodeId: "node-a", ownerSession: "session-b",
      expectedEpoch: 1, leaseMs: 500,
    });
    assert.equal(successor.granted, true);
    assert.equal(successor.placement.epoch, 2);
    assert.equal((await child.exit).requested, true);
    assert.equal(await authority.validate(token), false);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
