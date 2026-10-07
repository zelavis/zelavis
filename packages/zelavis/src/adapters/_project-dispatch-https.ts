import { integration, integrationValue, presentProtocol, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
import { isUnknown, optional, objectFields, parseJson } from "../core/json-validation.js";
import { createServer, request as httpsRequest, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createProjectDispatchNonceConsumer,
  receiveProjectDispatch,
  signProjectDispatchAuthority,
  type ProjectDispatchClaims,
  type ProjectDispatchPlacement,
} from "../core/agent/project-dispatch.js";
import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";
import type { ZelavisProjectDispatcher } from "../project.js";
import type { ZelavisSystemStore } from "../system-store.js";
import { createArtifactDigest, type ZelavisArtifactDigest } from "../core/artifact/index.js";
import { packRemoteProjectSnapshot } from "./_remote-project-snapshot.js";
import {
  signRemotePlacementGrant,
  type RemotePlacementRecord,
} from "../core/agent/remote-placement.js";

/** Control requests carry only a signed token. */
const MAX_CONTROL_BYTES = 16 * 1024;
/** A prepare body is raw snapshot bytes, read only after its authority verifies. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024;

async function readBounded(request: IncomingMessage, limit = MAX_CONTROL_BYTES): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (!Number.isFinite(declared) || declared > limit) {
    throw new Error("Request exceeds the dispatch limit.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("Request exceeds the dispatch limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function reply(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

export interface ProjectDispatchHttpsServer {
  readonly address: string;
  close(): Promise<void>;
}

/** A destination Agent's TLS ingress for signed Project lifecycle commands. */
export function createProjectDispatchHttpsServer(options: {
  readonly host: string;
  readonly port: number;
  readonly keyPem: string;
  readonly certPem: string;
  readonly agentId: string;
  readonly nodeId: string;
  readonly trust: ZelavisHostOperationTrustStore;
  readonly nonceStore: ZelavisSystemStore;
  readonly readPlacement: (projectId: string) => Promise<ProjectDispatchPlacement | undefined>;
  readonly isReady?: () => boolean;
  readonly acceptLease: (grant: string) => Promise<RemotePlacementRecord>;
  readonly releaseLease: (placement: ProjectDispatchClaims) => Promise<boolean>;
  readonly prepareArtifact: (projectId: string, body: Uint8Array,
    digest: ZelavisArtifactDigest) => Promise<void>;
  readonly preparedDigest: (projectId: string) => Promise<ZelavisArtifactDigest | undefined>;
  readonly start: (claims: ProjectDispatchClaims) => Promise<void>;
  readonly stop: (claims: ProjectDispatchClaims) => Promise<void>;
}): Promise<ProjectDispatchHttpsServer> { return presentProtocol(Effect.gen(function* () {
  if (!options.host || !Number.isInteger(options.port) ||
      options.port < 0 || options.port > 65_535 ||
      !options.keyPem || !options.certPem) {
    throw new TypeError("A TLS certificate, private key, host and port are required.");
  }
  const nonces = createProjectDispatchNonceConsumer(options.nonceStore, options.agentId);
  const server: Server = createServer({ key: options.keyPem, cert: options.certPem },
    (request, response) => {
      void (() => { return presentProtocol(Effect.gen(function* () {
        if (request.method === "GET" && request.url === "/v1/health") {
          reply(response, 200, JSON.stringify({ agentId: options.agentId,
            nodeId: options.nodeId, ready: options.isReady?.() ?? true }));
          return;
        }
        if (request.method === "POST" && request.url === "/v1/placements") {
          const body = parseJson(((yield* integrationValue(readBounded(request)))).toString("utf8"), objectFields<{ grant?: unknown }>({grant: optional(isUnknown)}));
          if (!body || typeof body.grant !== "string") {
            reply(response, 400, '{"error":"invalid request"}');
            return;
          }
          (yield* integrationValue(options.acceptLease(body.grant)));
          reply(response, 200, '{"ok":true}');
          return;
        }
        const prepare = /^\/v1\/projects\/([^/]+)\/prepare$/.exec(request.url ?? "");
        if (request.method === "POST" && prepare) {
          const projectId = decodeURIComponent(prepare[1]!);
          const authority = request.headers["x-zelavis-authority"];
          if (typeof authority !== "string") {
            reply(response, 400, '{"error":"invalid request"}');
            return;
          }
          (yield* integrationValue(receiveProjectDispatch({
            trust: options.trust, token: authority,
            agentId: options.agentId, action: "prepare", projectId,
            nodeId: options.nodeId, readPlacement: options.readPlacement,
            consumeNonce: nonces.consume,
            execute: async (claims) => {
              // Only a verified, single-use authority may make this Agent buffer a body.
              const snapshot = new Uint8Array(await readBounded(request, MAX_SNAPSHOT_BYTES));
              const digest = await createArtifactDigest(snapshot);
              if (claims.artifactDigest !== digest) {
                throw new Error("Signed Project artifact digest differs from delivered bytes.");
              }
              await options.prepareArtifact(projectId, snapshot, digest);
            },
          })));
          reply(response, 200, '{"ok":true}');
          return;
        }
        const match = /^\/v1\/projects\/([^/]+)\/(start|stop)$/.exec(request.url ?? "");
        if (request.method !== "POST" || !match) {
          reply(response, 404, '{"error":"not found"}');
          return;
        }
        const projectId = decodeURIComponent(match[1]!);
        const action = match[2] as "start" | "stop";
        const body = parseJson(((yield* integrationValue(readBounded(request)))).toString("utf8"), objectFields<{ authority?: unknown }>({authority: optional(isUnknown)}));
        if (!body || typeof body.authority !== "string") {
          reply(response, 400, '{"error":"invalid request"}');
          return;
        }
        const claims = (yield* integrationValue(receiveProjectDispatch({
          trust: options.trust,
          token: body.authority,
          agentId: options.agentId,
          action,
          projectId,
          nodeId: options.nodeId,
          readPlacement: options.readPlacement,
          consumeNonce: nonces.consume,
          execute: async (value) => {
            if (action === "start" &&
                (!value.artifactDigest ||
                  await options.preparedDigest(projectId) !== value.artifactDigest)) {
              throw new Error("Project runtime artifact has not been prepared.");
            }
            await (action === "start" ? options.start : options.stop)(value);
            return value;
          },
        })));
        if (action === "stop" && !((yield* integrationValue(options.releaseLease(claims))))) {
          throw new Error("Project placement changed during stop.");
        }
        reply(response, 200, '{"ok":true}');
      }).pipe(Effect.withSpan("createProjectDispatchHttpsServer/server/callback/callback"))); })().catch(() => {
        if (!response.headersSent) reply(response, 403, '{"error":"dispatch refused"}');
        else response.destroy();
      });
    });
  (yield* integrationValue(new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  })));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Agent TLS listener has no address.");
  return {
    address: `https://${options.host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}).pipe(Effect.withSpan("createProjectDispatchHttpsServer"))); }

export interface Destination {
  readonly url: string;
  readonly caPem: string;
  readonly agentId: string;
}

/** Verify the configured TLS peer is the Agent assigned to this Node. */
export function probeProjectAgent(destination: Destination,
  nodeId: string): Promise<boolean> { return presentProtocol(Effect.gen(function* () {
  const url = endpoint(destination);
  return yield* Effect.callback<boolean>((resume) => {
    const resolve = (value: boolean) => resume(Effect.succeed(value));
    const request = httpsRequest({
      hostname: url.hostname, port: url.port, path: "/v1/health",
      method: "GET", ca: destination.caPem, rejectUnauthorized: true,
      timeout: 2_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy();
        else chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          const body = parseJson(Buffer.concat(chunks).toString("utf8"), objectFields<{
            agentId?: unknown; nodeId?: unknown; ready?: unknown;
          }>({agentId: optional(isUnknown), nodeId: optional(isUnknown), ready: optional(isUnknown)}));
          resolve(response.statusCode === 200 && body.agentId === destination.agentId &&
            body.nodeId === nodeId && body.ready === true);
        } catch { resolve(false); }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
    request.end();
    return Effect.sync(() => { request.destroy(); });
  });
}).pipe(Effect.withSpan("probeProjectAgent"))); }

function endpoint(destination: Destination): URL {
  const url = new URL(destination.url);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || !destination.caPem) {
    throw new TypeError("Project Agent endpoint must be an HTTPS origin with a pinned CA.");
  }
  return url;
}

async function post(destination: Destination, path: string,
  bodyValue: Readonly<Record<string, string>> | { readonly authority: string; readonly raw: Uint8Array }):
  Promise<void> {
  const url = endpoint(destination);
  const raw = "raw" in bodyValue;
  const body = raw ? Buffer.from(bodyValue.raw) : JSON.stringify(bodyValue);
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method: "POST",
      ca: destination.caPem,
      rejectUnauthorized: true,
      timeout: 30_000,
      headers: {
        "content-type": raw ? "application/octet-stream" : "application/json",
        "content-length": Buffer.byteLength(body),
        ...(raw ? { "x-zelavis-authority": bodyValue.authority } : {}),
      },
    }, (response) => {
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new Error("Agent response exceeded the limit."));
      });
      response.once("end", () => response.statusCode === 200
        ? resolve() : reject(new Error(`Project Agent refused dispatch (${response.statusCode ?? 0}).`)));
    });
    request.once("timeout", () => request.destroy(new Error("Project Agent dispatch timed out.")));
    request.once("error", reject);
    request.end(body);
  });
}

/** Platform side: node identity selects one pinned TLS Agent and signed audience. */
export function createHttpsProjectDispatcher(options: {
  readonly localNodeId: string;
  readonly projectsDirectory: string;
  /** Operator-configured nodes, pinned at startup. They win over `resolveDestination`. */
  readonly destinations: Readonly<Record<string, Destination>>;
  /** Nodes registered at runtime (enrollment). Consulted when a node is not in `destinations`. */
  readonly resolveDestination?: (nodeId: string) => Effect.Effect<Destination | undefined, IntegrationFailure>;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}): ZelavisProjectDispatcher {
  const snapshots = new Map<string, { body: Uint8Array; digest: ZelavisArtifactDigest }>();
  const destination = (nodeId: string) => Effect.gen(function* () {
    const configured = options.destinations[nodeId];
    const value = configured ?? (options.resolveDestination ? yield* options.resolveDestination(nodeId) : undefined);
    if (!value) throw new Error(`No Agent endpoint is configured for Node "${nodeId}".`);
    endpoint(value);
    return value;
  });
  return {
    localNodeId: options.localNodeId,
    authorizeDispatch: ({ action, placement }) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(placement.nodeId);
      const now = Date.now();
      const snapshot = action === "start"
        ? yield* integration(() => packRemoteProjectSnapshot(options.projectsDirectory, placement.projectId))
        : undefined;
      if (snapshot) snapshots.set(`${placement.projectId}:${placement.epoch}`, snapshot);
      return yield* integration(() => signProjectDispatchAuthority(options.privateKey, {
        keyId: options.keyId,
        agentId: target.agentId,
        action,
        projectId: placement.projectId,
        nodeId: placement.nodeId,
        ownerSession: placement.ownerSession,
        epoch: placement.epoch,
        issuedAt: now,
        expiresAt: now + 30_000,
        nonce: crypto.randomUUID(),
        ...(snapshot ? { artifactDigest: snapshot.digest } : {}),
      }));
    })),
    dispatchStartFenced: ({ projectId, nodeId, placement, authority }) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(nodeId);
      const snapshot = snapshots.get(`${projectId}:${placement.epoch}`);
      if (!snapshot) throw new Error("Project snapshot was not frozen for dispatch.");
      const now = Date.now();
      const prepareAuthority = yield* integration(() => signProjectDispatchAuthority(options.privateKey, {
        keyId: options.keyId, agentId: target.agentId, action: "prepare",
        projectId, nodeId, ownerSession: placement.ownerSession,
        epoch: placement.epoch, issuedAt: now, expiresAt: now + 30_000,
        nonce: crypto.randomUUID(), artifactDigest: snapshot.digest,
      }));
      yield* Effect.gen(function* () {
        yield* integration(() => post(target, `/v1/projects/${encodeURIComponent(projectId)}/prepare`, {
          authority: prepareAuthority, raw: snapshot.body,
        }));
        yield* integration(() => post(target, `/v1/projects/${encodeURIComponent(projectId)}/start`, { authority }));
      }).pipe(Effect.ensuring(Effect.sync(() => { snapshots.delete(`${projectId}:${placement.epoch}`); })));
    })),
    dispatchStopFenced: ({ projectId, nodeId, authority }) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(nodeId);
      yield* integration(() => post(target, `/v1/projects/${encodeURIComponent(projectId)}/stop`, { authority }));
    })),
    dispatchLeaseFenced: (placement) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(placement.nodeId);
      const now = Date.now();
      const grant = yield* integration(() => signRemotePlacementGrant(options.privateKey, {
        keyId: options.keyId,
        agentId: target.agentId,
        placement,
        issuedAt: now,
        expiresAt: now + 20_000,
      }));
      yield* integration(() => post(target, "/v1/placements", { grant }));
    })),
  };
}
