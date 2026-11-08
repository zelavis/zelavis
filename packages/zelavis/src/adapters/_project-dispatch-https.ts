import { IntegrationFailure, evaluate, integration, presentProtocol } from "../core/runtime/effect-boundary.js";
import { Effect, Result } from "effect";
import { isUnknown, optional, objectFields, parseJson } from "../core/json-validation.js";
import { createServer, request as httpsRequest, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createProjectDispatchNonceConsumer,
  receiveProjectDispatch,
  receiveStandbyDispatch,
  signProjectDispatchAuthority,
  type ProjectDispatchClaims,
  type ProjectDispatchPlacement,
} from "../core/agent/project-dispatch.js";
import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";
import type { ZelavisProjectDispatcher } from "../project.js";
import type { ZelavisSystemStore } from "../system-store.js";
import { createArtifactDigest, type ZelavisArtifactDigest } from "../core/artifact/index.js";
import { packRemoteProjectSnapshot } from "./_remote-project-snapshot.js";
import { signAppShardAccess, signAppShardGrant, APP_SHARD_ACCESS_MAX_MS, APP_SHARD_GRANT_MAX_MS } from "../core/agent/app-shard-grant.js";
import type { RemoteShardHost } from "./_remote-shard-host.js";
import {
  signRemotePlacementGrant,
  type RemotePlacementRecord,
} from "../core/agent/remote-placement.js";

/** Control requests carry only a signed token. */
const MAX_CONTROL_BYTES = 16 * 1024;
/** A prepare body is raw snapshot bytes, read only after its authority verifies. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024;
/** A routed request or response: the Gateway's 32 MiB body bound, base64 in JSON, with its headers. */
const MAX_ROUTE_BYTES = 48 * 1024 * 1024;
const ROUTE_TIMEOUT_MS = 35_000;

const limitExceeded = () => new IntegrationFailure(new Error("Request exceeds the dispatch limit."));

/** Reads a request body up to `limit`, destroying the stream the moment it is exceeded. */
const readBounded = (request: IncomingMessage, limit = MAX_CONTROL_BYTES) =>
  Effect.callback<Buffer, IntegrationFailure>((resume) => {
    const declared = Number(request.headers["content-length"]);
    if (!Number.isFinite(declared) || declared > limit) {
      resume(Effect.fail(limitExceeded()));
      return Effect.void;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        settle(Effect.fail(limitExceeded()));
        request.destroy();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => settle(Effect.succeed(Buffer.concat(chunks)));
    const onError = (error: Error) => settle(Effect.fail(new IntegrationFailure(error)));
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    function settle(outcome: Effect.Effect<Buffer, IntegrationFailure>): void {
      if (settled) return;
      settled = true;
      cleanup();
      resume(outcome);
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    return Effect.sync(cleanup);
  });

function reply(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

/** The headers and body of a routed request, and of the answer; the method and path are in the signed claims. */
export interface ProjectRouteRequest {
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body?: Uint8Array;
}
export interface ProjectRouteResponse {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
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
  /** Read for every verification, so a refreshed set of Platform keys applies without a restart. */
  readonly trust: () => ZelavisHostOperationTrustStore;
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
  /** Runs the Project here as its writer's standby, placement-free (see `receiveStandbyDispatch`). */
  readonly startStandby?: (claims: ProjectDispatchClaims) => Promise<void>;
  /**
   * Forwards one request, signed by the Platform, to the Project running here and answers what it answered. Absent: a
   * Project here is not reachable from the Platform (the Agent does not listen for it).
   */
  readonly route?: (claims: ProjectDispatchClaims, request: ProjectRouteRequest) => Promise<ProjectRouteResponse>;
  readonly stopStandby?: (claims: ProjectDispatchClaims) => Promise<void>;
  /** Hosts App shard storage here. Absent: the shard routes answer 404. */
  readonly shards?: RemoteShardHost;
  /** What this Node offers for shards, reported in the health answer. */
  readonly capacity?: () => Promise<{ readonly cpuCores: number; readonly memoryBytes: number; readonly diskBytes: number }>;
}): Promise<ProjectDispatchHttpsServer> { return presentProtocol(Effect.gen(function* () {
  if (!options.host || !Number.isInteger(options.port) ||
      options.port < 0 || options.port > 65_535 ||
      !options.keyPem || !options.certPem) {
    throw new TypeError("A TLS certificate, private key, host and port are required.");
  }
  const nonces = createProjectDispatchNonceConsumer(options.nonceStore, options.agentId);
  const badRequest = (response: ServerResponse) => reply(response, 400, '{"error":"invalid request"}');
  const jsonBody = <T>(request: IncomingMessage, fields: Parameters<typeof objectFields<T>>[0], limit?: number) =>
    readBounded(request, limit).pipe(Effect.flatMap((raw) => evaluate(() => parseJson(raw.toString("utf8"), objectFields<T>(fields)))));

  /** One request. Any failure, typed or a defect, is a refusal; nothing about why is sent. */
  const handle = (request: IncomingMessage, response: ServerResponse) => Effect.gen(function* () {
    if (request.method === "GET" && request.url === "/v1/health") {
      const measured = options.capacity ? yield* Effect.result(integration(() => options.capacity!())) : undefined;
      reply(response, 200, JSON.stringify({ agentId: options.agentId, nodeId: options.nodeId, ready: options.isReady?.() ?? true,
        ...(measured && Result.isSuccess(measured) ? { capacity: measured.success } : {}) }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/shards/grants" && options.shards) {
      const shards = options.shards;
      const body = yield* jsonBody<{ grant?: unknown }>(request, { grant: optional(isUnknown) });
      if (!body || typeof body.grant !== "string") return badRequest(response);
      const grant = body.grant;
      const applied = yield* integration(() => shards.applyGrant(grant));
      reply(response, 200, JSON.stringify({ ok: true, state: applied.state, epoch: applied.epoch }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/shards/kv" && options.shards) {
      const shards = options.shards;
      const raw = yield* readBounded(request, 16 * 1024 * 1024);
      const body = yield* evaluate(() => parseJson(raw.toString("utf8"), isUnknown));
      const answer = yield* integration(() => shards.kv(body));
      reply(response, answer.status, JSON.stringify(answer.body));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/shards/reads" && options.shards) {
      const shards = options.shards;
      const raw = yield* readBounded(request, 1024 * 1024);
      const body = yield* evaluate(() => parseJson(raw.toString("utf8"), isUnknown));
      const answer = yield* integration(() => shards.reads(body));
      reply(response, answer.status, JSON.stringify(answer.body));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/placements") {
      const body = yield* jsonBody<{ grant?: unknown }>(request, { grant: optional(isUnknown) });
      if (!body || typeof body.grant !== "string") return badRequest(response);
      const grant = body.grant;
      yield* integration(() => options.acceptLease(grant));
      reply(response, 200, '{"ok":true}');
      return;
    }
    const prepare = /^\/v1\/projects\/([^/]+)\/prepare$/.exec(request.url ?? "");
    if (request.method === "POST" && prepare) {
      const projectId = decodeURIComponent(prepare[1]!);
      const authority = request.headers["x-zelavis-authority"];
      if (typeof authority !== "string") return badRequest(response);
      yield* integration(() => receiveProjectDispatch({
        trust: options.trust(), token: authority,
        agentId: options.agentId, action: "prepare", projectId,
        nodeId: options.nodeId, readPlacement: options.readPlacement,
        consumeNonce: nonces.consume,
        execute: (claims) => presentProtocol(Effect.gen(function* () {
          // Only a verified, single-use authority may make this Agent buffer a body.
          const snapshot = new Uint8Array(yield* readBounded(request, MAX_SNAPSHOT_BYTES));
          const digest = yield* integration(() => createArtifactDigest(snapshot));
          if (claims.artifactDigest !== digest) {
            return yield* new IntegrationFailure(new Error("Signed Project artifact digest differs from delivered bytes."));
          }
          yield* integration(() => options.prepareArtifact(projectId, snapshot, digest));
        })),
      }));
      reply(response, 200, '{"ok":true}');
      return;
    }
    const routed = /^\/v1\/projects\/([^/]+)\/route$/.exec(request.url ?? "");
    if (request.method === "POST" && routed && options.route !== undefined) {
      const projectId = decodeURIComponent(routed[1]!);
      const body = yield* jsonBody<{ authority?: unknown; headers?: unknown; body?: unknown }>(request,
        { authority: optional(isUnknown), headers: optional(isUnknown), body: optional(isUnknown) }, MAX_ROUTE_BYTES);
      if (!body || typeof body.authority !== "string") return badRequest(response);
      const pairs = Array.isArray(body.headers) && body.headers.length <= 200 &&
        body.headers.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string")
        ? body.headers as [string, string][] : undefined;
      if (pairs === undefined || (body.body !== undefined && typeof body.body !== "string")) return badRequest(response);
      const forwarded = body.body === undefined || body.body === "" ? undefined : new Uint8Array(Buffer.from(body.body as string, "base64"));
      const answer = yield* integration(() => receiveProjectDispatch({
        trust: options.trust(), token: body.authority as string, agentId: options.agentId, action: "route", projectId,
        nodeId: options.nodeId, readPlacement: options.readPlacement, consumeNonce: nonces.consume,
        execute: (claims) => options.route!(claims, { headers: pairs, ...(forwarded === undefined ? {} : { body: forwarded }) }),
      }));
      reply(response, 200, JSON.stringify({ status: answer.status, headers: answer.headers, body: Buffer.from(answer.body).toString("base64") }));
      return;
    }
    // A standby holds no placement: its operations verify the signed authority and the Agent's own identity only.
    const standby = /^\/v1\/standbys\/([^/]+)\/(prepare|start|stop)$/.exec(request.url ?? "");
    if (request.method === "POST" && standby) {
      const projectId = decodeURIComponent(standby[1]!);
      const step = standby[2] as "prepare" | "start" | "stop";
      if (step === "prepare") {
        const authority = request.headers["x-zelavis-authority"];
        if (typeof authority !== "string") return badRequest(response);
        yield* integration(() => receiveStandbyDispatch({
          trust: options.trust(), token: authority, agentId: options.agentId, action: "prepare", projectId,
          nodeId: options.nodeId, consumeNonce: nonces.consume,
          execute: (claims) => presentProtocol(Effect.gen(function* () {
            const snapshot = new Uint8Array(yield* readBounded(request, MAX_SNAPSHOT_BYTES));
            const digest = yield* integration(() => createArtifactDigest(snapshot));
            if (claims.artifactDigest !== digest) {
              return yield* new IntegrationFailure(new Error("Signed Project artifact digest differs from delivered bytes."));
            }
            yield* integration(() => options.prepareArtifact(projectId, snapshot, digest));
          })),
        }));
        reply(response, 200, '{"ok":true}');
        return;
      }
      const body = yield* jsonBody<{ authority?: unknown }>(request, { authority: optional(isUnknown) });
      const handler = step === "start" ? options.startStandby : options.stopStandby;
      if (!body || typeof body.authority !== "string" || handler === undefined) return badRequest(response);
      yield* integration(() => receiveStandbyDispatch({
        trust: options.trust(), token: body.authority as string, agentId: options.agentId,
        action: step === "start" ? "standby" : "stop", projectId, nodeId: options.nodeId, consumeNonce: nonces.consume,
        execute: (claims) => presentProtocol(Effect.gen(function* () {
          if (step === "start" &&
              (!claims.artifactDigest || (yield* integration(() => options.preparedDigest(projectId))) !== claims.artifactDigest)) {
            return yield* new IntegrationFailure(new Error("Project runtime artifact has not been prepared."));
          }
          yield* integration(() => handler(claims));
        })),
      }));
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
    const body = yield* jsonBody<{ authority?: unknown }>(request, { authority: optional(isUnknown) });
    if (!body || typeof body.authority !== "string") return badRequest(response);
    const token = body.authority;
    const claims = yield* integration(() => receiveProjectDispatch({
      trust: options.trust(),
      token,
      agentId: options.agentId,
      action,
      projectId,
      nodeId: options.nodeId,
      readPlacement: options.readPlacement,
      consumeNonce: nonces.consume,
      execute: (value) => presentProtocol(Effect.gen(function* () {
        if (action === "start" &&
            (!value.artifactDigest ||
              (yield* integration(() => options.preparedDigest(projectId))) !== value.artifactDigest)) {
          return yield* new IntegrationFailure(new Error("Project runtime artifact has not been prepared."));
        }
        yield* integration(() => (action === "start" ? options.start : options.stop)(value));
        return value;
      })),
    }));
    if (action === "stop" && !(yield* integration(() => options.releaseLease(claims)))) {
      return yield* new IntegrationFailure(new Error("Project placement changed during stop."));
    }
    reply(response, 200, '{"ok":true}');
  }).pipe(
    Effect.withSpan("createProjectDispatchHttpsServer/server/callback"),
    Effect.catchCause(() => Effect.sync(() => {
      if (!response.headersSent) reply(response, 403, '{"error":"dispatch refused"}');
      else response.destroy();
    })),
  );

  const server: Server = createServer({ key: options.keyPem, cert: options.certPem },
    (request, response) => { Effect.runFork(handle(request, response)); });
  yield* Effect.callback<void, IntegrationFailure>((resume) => {
    const failed = (error: Error) => resume(Effect.fail(new IntegrationFailure(error)));
    server.once("error", failed);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", failed);
      resume(Effect.void);
    });
    return Effect.sync(() => { server.removeListener("error", failed); });
  });
  const address = server.address();
  if (!address || typeof address === "string") return yield* new IntegrationFailure(new Error("Agent TLS listener has no address."));
  const closeServer = Effect.callback<void, IntegrationFailure>((resume) => {
    server.close((error) => resume(error ? Effect.fail(new IntegrationFailure(error)) : Effect.void));
    server.closeAllConnections();
    return Effect.void;
  });
  return {
    address: `https://${options.host}:${address.port}`,
    close: () => presentProtocol(closeServer),
  };
}).pipe(Effect.withSpan("createProjectDispatchHttpsServer"))); }

export interface Destination {
  readonly url: string;
  readonly caPem: string;
  readonly agentId: string;
}

export interface ProjectAgentProbe {
  readonly ready: boolean;
  /** What the Agent measured of its host; absent when it did not say, or said something unusable. */
  readonly capacity?: { readonly cpuCores: number; readonly memoryBytes: number; readonly diskBytes: number };
}

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const capacityOf = (value: unknown): ProjectAgentProbe["capacity"] => {
  if (typeof value !== "object" || value === null) return undefined;
  const { cpuCores, memoryBytes, diskBytes } = value as Record<string, unknown>;
  return positiveInteger(cpuCores) && positiveInteger(memoryBytes) && positiveInteger(diskBytes) ? { cpuCores, memoryBytes, diskBytes } : undefined;
};

/** Verify the configured TLS peer is the Agent assigned to this Node, and read the capacity it reports. */
export function probeProjectAgent(destination: Destination,
  nodeId: string): Promise<ProjectAgentProbe> { return presentProtocol(Effect.gen(function* () {
  const url = endpoint(destination);
  return yield* Effect.callback<ProjectAgentProbe>((resume) => {
    const resolve = (value: ProjectAgentProbe) => resume(Effect.succeed(value));
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
            agentId?: unknown; nodeId?: unknown; ready?: unknown; capacity?: unknown;
          }>({agentId: optional(isUnknown), nodeId: optional(isUnknown), ready: optional(isUnknown), capacity: optional(isUnknown)}));
          const ready = response.statusCode === 200 && body.agentId === destination.agentId &&
            body.nodeId === nodeId && body.ready === true;
          const capacity = ready ? capacityOf(body.capacity) : undefined;
          resolve(capacity ? { ready, capacity } : { ready });
        } catch { resolve({ ready: false }); }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve({ ready: false }));
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

const post = (destination: Destination, path: string,
  bodyValue: Readonly<Record<string, string>> | { readonly authority: string; readonly raw: Uint8Array }) =>
  evaluate(() => endpoint(destination)).pipe(Effect.flatMap((url) => Effect.callback<void, IntegrationFailure>((resume) => {
    const raw = "raw" in bodyValue;
    const body = raw ? Buffer.from(bodyValue.raw) : JSON.stringify(bodyValue);
    const fail = (error: Error) => resume(Effect.fail(new IntegrationFailure(error)));
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
        ? resume(Effect.void) : fail(new Error(`Project Agent refused dispatch (${response.statusCode ?? 0}).`)));
    });
    request.once("timeout", () => request.destroy(new Error("Project Agent dispatch timed out.")));
    request.once("error", fail);
    request.end(body);
    return Effect.sync(() => { request.destroy(); });
  })));

/** A JSON POST whose 200 answer is parsed (bounded like any control answer). */
const postJson = (destination: Destination, path: string, bodyValue: Readonly<Record<string, string>>) =>
  evaluate(() => endpoint(destination)).pipe(Effect.flatMap((url) => Effect.callback<Record<string, unknown>, IntegrationFailure>((resume) => {
    const fail = (error: Error) => resume(Effect.fail(new IntegrationFailure(error)));
    const body = JSON.stringify(bodyValue);
    const request = httpsRequest({
      hostname: url.hostname, port: url.port, path, method: "POST", ca: destination.caPem, rejectUnauthorized: true, timeout: 30_000,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new Error("Agent response exceeded the limit."));
        else chunks.push(chunk);
      });
      response.once("end", () => {
        if (response.statusCode !== 200) return fail(new Error(`Project Agent refused dispatch (${response.statusCode ?? 0}).`));
        try {
          resume(Effect.succeed(parseJson(Buffer.concat(chunks).toString("utf8"), objectFields<Record<string, unknown>>({
            ok: optional(isUnknown), state: optional(isUnknown), epoch: optional(isUnknown) }))));
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    request.once("timeout", () => request.destroy(new Error("Project Agent dispatch timed out.")));
    request.once("error", fail);
    request.end(body);
    return Effect.sync(() => { request.destroy(); });
  })));

/** One routed request: the whole answer is read, up to the route bound, and decoded. */
const exchange = (destination: Destination, path: string, bodyText: string) =>
  evaluate(() => endpoint(destination)).pipe(Effect.flatMap((url) => Effect.callback<ProjectRouteResponse, IntegrationFailure>((resume) => {
    const fail = (error: Error) => resume(Effect.fail(new IntegrationFailure(error)));
    const request = httpsRequest({
      hostname: url.hostname, port: url.port, path, method: "POST", ca: destination.caPem, rejectUnauthorized: true,
      timeout: ROUTE_TIMEOUT_MS,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(bodyText) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ROUTE_BYTES) request.destroy(new Error("Agent route answer exceeded the limit."));
        else chunks.push(chunk);
      });
      response.once("end", () => {
        if (response.statusCode !== 200) return fail(new Error(`Project Agent refused to route (${response.statusCode ?? 0}).`));
        const decoded = parseJson(Buffer.concat(chunks).toString("utf8"), objectFields<{ status?: unknown; headers?: unknown; body?: unknown }>({ status: optional(isUnknown), headers: optional(isUnknown), body: optional(isUnknown) }));
        if (typeof decoded.status !== "number" || !Number.isSafeInteger(decoded.status) || decoded.status < 100 || decoded.status > 599 ||
            !Array.isArray(decoded.headers) || typeof decoded.body !== "string" ||
            !decoded.headers.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string")) {
          return fail(new Error("Project Agent answered a route with something that is not a response."));
        }
        resume(Effect.succeed({ status: decoded.status, headers: decoded.headers as [string, string][], body: new Uint8Array(Buffer.from(decoded.body, "base64")) }));
      });
    });
    request.once("timeout", () => request.destroy(new Error("Project Agent route timed out.")));
    request.once("error", fail);
    request.end(bodyText);
    return Effect.sync(() => { request.destroy(); });
  })));

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
    authorizeDispatch: ({ action, placement, lease, appShards }) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(placement.nodeId);
      const now = Date.now();
      // A lease-guarded Project's directory here may hold the data it has been writing; the node its standby runs on has its own.
      const snapshot = action === "start"
        ? yield* integration(() => packRemoteProjectSnapshot(options.projectsDirectory, placement.projectId, { descriptorOnly: lease !== undefined }))
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
        ...(lease ? { lease } : {}),
        ...(appShards ? { appShards } : {}),
      }));
    })),
    dispatchStandbyFenced: ({ projectId, nodeId, ownerSession, epoch, lease }) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(nodeId);
      const snapshot = yield* integration(() => packRemoteProjectSnapshot(options.projectsDirectory, projectId, { descriptorOnly: true }));
      const sign = (action: "prepare" | "standby", extra: { readonly artifactDigest: ZelavisArtifactDigest; readonly lease?: Readonly<Record<string, string>> }) => {
        const now = Date.now();
        return integration(() => signProjectDispatchAuthority(options.privateKey, {
          keyId: options.keyId, agentId: target.agentId, action, projectId, nodeId, ownerSession, epoch,
          issuedAt: now, expiresAt: now + 30_000, nonce: crypto.randomUUID(), ...extra,
        }));
      };
      const prepareAuthority = yield* sign("prepare", { artifactDigest: snapshot.digest });
      yield* post(target, `/v1/standbys/${encodeURIComponent(projectId)}/prepare`, { authority: prepareAuthority, raw: snapshot.body });
      const authority = yield* sign("standby", { artifactDigest: snapshot.digest, lease });
      yield* post(target, `/v1/standbys/${encodeURIComponent(projectId)}/start`, { authority });
    })),
    dispatchRoute: ({ projectId, nodeId, placement, method, path, gateway, headers, body }) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(nodeId);
      const now = Date.now();
      const authority = yield* integration(() => signProjectDispatchAuthority(options.privateKey, {
        keyId: options.keyId, agentId: target.agentId, action: "route", projectId, nodeId,
        ownerSession: placement.ownerSession, epoch: placement.epoch, issuedAt: now, expiresAt: now + 30_000,
        nonce: crypto.randomUUID(), route: { method, path, gateway },
      }));
      return yield* exchange(target, `/v1/projects/${encodeURIComponent(projectId)}/route`, JSON.stringify({
        authority, headers, ...(body === undefined || body.byteLength === 0 ? {} : { body: Buffer.from(body).toString("base64") }),
      }));
    })),
    dispatchStandbyStopFenced: ({ projectId, nodeId, ownerSession, epoch }) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(nodeId);
      const now = Date.now();
      const authority = yield* integration(() => signProjectDispatchAuthority(options.privateKey, {
        keyId: options.keyId, agentId: target.agentId, action: "stop", projectId, nodeId, ownerSession, epoch,
        issuedAt: now, expiresAt: now + 30_000, nonce: crypto.randomUUID(),
      }));
      yield* post(target, `/v1/standbys/${encodeURIComponent(projectId)}/stop`, { authority });
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
        yield* post(target, `/v1/projects/${encodeURIComponent(projectId)}/prepare`, {
          authority: prepareAuthority, raw: snapshot.body,
        });
        yield* post(target, `/v1/projects/${encodeURIComponent(projectId)}/start`, { authority });
      }).pipe(Effect.ensuring(Effect.sync(() => { snapshots.delete(`${projectId}:${placement.epoch}`); })));
    })),
    dispatchStopFenced: ({ projectId, nodeId, authority }) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(nodeId);
      yield* post(target, `/v1/projects/${encodeURIComponent(projectId)}/stop`, { authority });
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
      yield* post(target, "/v1/placements", { grant });
    })),
    deliverAppShardGrant: (request) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(request.nodeId);
      const issuedAt = Date.now();
      const grant = yield* integration(() => signAppShardGrant(options.privateKey, {
        keyId: options.keyId, agentId: target.agentId, nodeId: request.nodeId, projectId: request.projectId,
        incarnation: request.incarnation, shardId: request.shardId, epoch: request.epoch, state: request.state,
        durability: request.durability, issuedAt, expiresAt: issuedAt + APP_SHARD_GRANT_MAX_MS,
      }));
      const answered = yield* postJson(target, "/v1/shards/grants", { grant });
      if (typeof answered.state !== "string" || typeof answered.epoch !== "number") {
        return yield* new IntegrationFailure(new Error("The Agent answered a shard grant with something that is not an acknowledgement."));
      }
      return { state: answered.state, epoch: answered.epoch };
    })),
    authorizeAppShardAccess: (request) => presentProtocol(Effect.gen(function* () {
      const target = yield* destination(request.nodeId);
      const issuedAt = Date.now(), expiresAt = issuedAt + APP_SHARD_ACCESS_MAX_MS;
      const token = yield* integration(() => signAppShardAccess(options.privateKey, {
        keyId: options.keyId, agentId: target.agentId, nodeId: request.nodeId, projectId: request.projectId,
        incarnation: request.incarnation, shardId: request.shardId, epoch: request.epoch, issuedAt, expiresAt,
      }));
      return { token, expiresAt, destination: { url: target.url, caPem: target.caPem, agentId: target.agentId } };
    })),
  };
}
