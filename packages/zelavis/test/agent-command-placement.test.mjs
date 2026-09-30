import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentCommand } from "../dist/cli/agent.js";
import { createAgentProcessClient } from "../dist/adapters/_agent-ipc.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createProjectPlacementAuthority } from "../dist/platform/project-placement-authority.js";

test("packaged Agent reads local committed placement and self-fences", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "zelavis-agent-placement-cli-"));
  const store = createLocalSqliteSystemStore({
    filename: join(dataDirectory, "system", "zelavis.sqlite"),
  });
  const authority = createProjectPlacementAuthority({ store, mayPlace: () => true });
  const granted = await authority.acquire({
    projectId: "project-a", nodeId: "local", ownerSession: "session-a",
    expectedEpoch: 0, leaseMs: 500,
  });
  assert.equal(granted.granted, true);
  const controller = new AbortController();
  let ready;
  const listening = new Promise((resolve) => { ready = resolve; });
  const running = runAgentCommand({
    dataDirectory, signal: controller.signal,
    onReady: () => ready(),
  });
  let client;
  try {
    await listening;
    client = await createAgentProcessClient({ directory: join(dataDirectory, "agent") });
    const file = join(dataDirectory, "child.mjs");
    await writeFile(file, "setInterval(() => {}, 1000);", "utf8");
    const command = {
      workloadId: "project-a", executable: process.execPath,
      args: [file], cwd: dataDirectory, env: {},
    };
    await assert.rejects(client.start(command), /placement authority is required/i);
    const child = await client.start({ ...command, placement: {
      projectId: "project-a", nodeId: "local", ownerSession: "session-a", epoch: 1,
    } });
    const exit = await Promise.race([
      child.exit,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Agent did not fence at expiry")), 1500)),
    ]);
    assert.equal(exit.requested, true);
  } finally {
    await client?.close();
    controller.abort();
    await running;
    await store.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
