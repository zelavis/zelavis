import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createHttpsProjectDispatcher,
  createProjectDispatchHttpsServer,
} from "../dist/adapters/_project-dispatch-https.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { createRemotePlacementLeaseStore } from "../dist/index.js";
import { digestArtifactDirectory } from "../dist/adapters/_recipe-artifact.js";
import {
  installRemoteProjectSnapshot,
  readPreparedRemoteProjectDigest,
} from "../dist/adapters/_remote-project-snapshot.js";

const run = promisify(execFile);

test("TLS Project dispatch reaches only the signed destination and refuses replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-remote-dispatch-"));
  const keyFile = join(directory, "tls.key");
  const certFile = join(directory, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile, "-out", certFile, "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const [keyPem, certPem] = await Promise.all([
    readFile(keyFile, "utf8"), readFile(certFile, "utf8"),
  ]);
  const nonceStore = createLocalSqliteSystemStore({ filename: join(directory, "nonces.sqlite") });
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const now = Date.now();
  const trust = { keys: [{
    keyId: "platform-a",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60_000).toISOString(),
  }] };
  let placement = {
    schemaVersion: 1, authority: "platform", revision: 1,
    projectId: "project-a", nodeId: "node-b", ownerSession: "session-a",
    epoch: 1, state: "active", leaseExpiresAt: now + 60_000,
  };
  const actions = [];
  const sourceProjects = join(directory, "source-projects");
  const destinationProjects = join(directory, "agent-projects");
  const sourceProject = join(sourceProjects, "project-a");
  const recipePackage = join(sourceProject, ".zelavis", "recipe", "package");
  await mkdir(join(recipePackage, "dist"), { recursive: true });
  await writeFile(join(recipePackage, "package.json"), JSON.stringify({
    name: "@zelavis/app", version: "1.0.0", type: "module",
  }));
  await writeFile(join(recipePackage, "dist", "index.js"), "export default {};\n");
  await writeFile(join(sourceProject, "project.json"), JSON.stringify({
    id: "project-a", kind: "zelavis", runtimeKind: "native",
    recipe: { name: "@zelavis/app", version: "1.0.0",
      artifact: { digest: await digestArtifactDirectory(recipePackage) } },
  }));
  const leases = createRemotePlacementLeaseStore({
    store: nonceStore, trust, agentId: "agent-b", nodeId: "node-b",
    fencePrevious: async () => true,
  });
  const server = await createProjectDispatchHttpsServer({
    host: "localhost", port: 0, keyPem, certPem,
    agentId: "agent-b", nodeId: "node-b", trust, nonceStore,
    readPlacement: leases.read,
    acceptLease: leases.accept,
    releaseLease: leases.release,
    prepareArtifact: (projectId, body, digest) => installRemoteProjectSnapshot({
      projectsDirectory: destinationProjects, projectId, body, digest,
    }),
    preparedDigest: (projectId) => readPreparedRemoteProjectDigest(destinationProjects, projectId),
    start: async (claims) => { actions.push(`start:${claims.epoch}`); },
    stop: async (claims) => { actions.push(`stop:${claims.epoch}`); },
  });
  const dispatcher = createHttpsProjectDispatcher({
    localNodeId: "node-a", keyId: "platform-a", privateKey,
    projectsDirectory: sourceProjects,
    destinations: { "node-b": { url: server.address, caPem: certPem, agentId: "agent-b" } },
  });
  const token = { projectId: placement.projectId, nodeId: placement.nodeId,
    ownerSession: placement.ownerSession, epoch: placement.epoch };
  try {
    await dispatcher.dispatchLeaseFenced(placement);
    const authority = await dispatcher.authorizeDispatch({ action: "start", placement: token });
    const request = { projectId: token.projectId, nodeId: token.nodeId,
      placement: token, authority };
    await dispatcher.dispatchStartFenced(request);
    await assert.rejects(dispatcher.dispatchStartFenced(request), /not frozen/);
    const stopAuthority = await dispatcher.authorizeDispatch({ action: "stop", placement: token });
    await dispatcher.dispatchStopFenced({ ...request, authority: stopAuthority });
    assert.deepEqual(actions, ["start:1", "stop:1"]);
    placement = { ...placement, epoch: 2, revision: 2, ownerSession: "session-b" };
    await dispatcher.dispatchLeaseFenced(placement);
    const staleAuthority = await dispatcher.authorizeDispatch({ action: "start", placement: token });
    await assert.rejects(dispatcher.dispatchStartFenced({ ...request,
      authority: staleAuthority }), /refused/);
    assert.deepEqual(actions, ["start:1", "stop:1"]);
  } finally {
    await server.close();
    await nonceStore.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
