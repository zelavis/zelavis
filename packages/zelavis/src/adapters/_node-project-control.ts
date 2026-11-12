import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Deferred, Effect, Semaphore } from "effect";
import { objectFields, parseJson, isPositiveInteger, isString } from "../core/json-validation.js";
import { evaluate, integration, IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisAgentProcessCommand } from "../core/agent/process-command.js";
import { requestNodeRuntimeControl, serveNodeRuntimeControl } from "./_node-runtime-control.js";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";

const MAX_COMMANDS = 128;
const MAX_CREDENTIAL_BYTES = 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const credentialsRecord = objectFields<{ pid: number; token: string }>({ pid: isPositiveInteger, token: isString });

/** Paths carry no authority. The host creates a fresh private token after it
 * acquires its journal lock. Project and integration hosts have distinct keys.
 * Keep sockets at the installation root to fit macOS's short sockaddr_un. */
export function nodeProjectControlPaths(directory: string, integrationOnly = false) {
  const root = resolve(directory, ".zelavis", ...(integrationOnly ? ["integration"] : []));
  const identity = createHash("sha256").update(root).digest("base64url").slice(0, 15);
  return { socketPath: join(resolve(directory, "..", ".."), `p${identity}`),
    credentialsFile: join(root, "host-control.json") };
}

/** Called only by an authorized Agent handle; credentials never enter process
 * records, replay logs or replies. Re-read after every host/Agent generation. */
export const writeNodeProjectControl = Effect.fn("ProjectControl.write")(function* (
  control: NonNullable<ZelavisAgentProcessCommand["control"]>, pid: number, source: string,
) {
  if (Buffer.byteLength(source) > 64 * 1024) return yield* new IntegrationFailure(new Error("Project control command is too large."));
  const input = yield* evaluate(() => {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Project control command.");
    return value as Readonly<Record<string, unknown>>;
  });
  const credentials = yield* Effect.acquireUseRelease(
    integration(() => open(control.credentialsFile, constants.O_RDONLY | constants.O_NOFOLLOW)),
    file => Effect.gen(function* () {
      const stats = yield* integration(() => file.stat());
      yield* evaluate(() => {
        if (!stats.isFile() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0 || stats.size > MAX_CREDENTIAL_BYTES)
          throw new Error("Project control credentials must be an owned private bounded file.");
      });
      const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
      const { bytesRead } = yield* integration(() => file.read(bytes, 0, bytes.length, 0));
      return yield* evaluate(() => {
        if (bytesRead > MAX_CREDENTIAL_BYTES) throw new Error("Project control credentials exceed their bound.");
        const record = parseJson(bytes.subarray(0, bytesRead).toString("utf8"), credentialsRecord);
        if (record.pid !== pid || !tokenPattern.test(record.token)) throw new Error("Project control credentials belong to another host.");
        return record;
      });
    }), file => integration(() => file.close()).pipe(Effect.orDie),
  );
  const socket = yield* integration(() => lstat(control.socketPath));
  yield* evaluate(() => { if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error("Project control endpoint is not an owned socket."); });
  yield* requestNodeRuntimeControl(control.socketPath, input, credentials.token);
  return true;
});

/** Private reconnectable App-host control. Losing an Agent request does not
 * terminate the host or cancel its journaled handover. Command UUIDs deduplicate
 * retries; commit acknowledgements bypass the serialized operation they unblock.
 * Only bounded command hashes/outcomes are retained, never command secrets. */
export const serveNodeProjectControl = Effect.fn("ProjectControl.serve")(function* (options: {
  readonly directory: string;
  readonly integrationOnly?: boolean;
  readonly emit: (value: Record<string, unknown>) => void;
  readonly command: (input: Readonly<Record<string, unknown>>) => Effect.Effect<Readonly<Record<string, unknown>>, TaggedFailure>;
  readonly acknowledge: (input: Readonly<Record<string, unknown>>) => boolean;
}) {
  const paths = nodeProjectControlPaths(options.directory, options.integrationOnly);
  const root = resolve(paths.credentialsFile, "..");
  const token = randomBytes(32).toString("base64url");
  yield* integration(() => mkdir(root, { recursive: true, mode: 0o700 }));
  const temporary = `${paths.credentialsFile}.${process.pid}`;
  yield* Effect.gen(function* () {
    yield* Effect.acquireUseRelease(integration(() => open(temporary, "wx", 0o600)), file => Effect.gen(function* () {
      yield* integration(() => file.writeFile(JSON.stringify({ pid: process.pid, token })));
      yield* integration(() => file.sync());
    }), file => integration(() => file.close()).pipe(Effect.orDie));
    yield* integration(() => rename(temporary, paths.credentialsFile));
  }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
  yield* Effect.addFinalizer(() => integration(() => rm(paths.credentialsFile, { force: true })).pipe(Effect.orDie));
  const mutex = Semaphore.makeUnsafe(1);
  const commands = new Map<string, { digest: string; result: Deferred.Deferred<Readonly<Record<string, unknown>>>; completed: boolean; expiresAt: number }>();
  yield* serveNodeRuntimeControl(paths.socketPath, Effect.fn("ProjectControl.command")(function* (input, authorization) {
    yield* evaluate(() => {
      const received = Buffer.from(authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("Project host control authentication failed.");
      if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || typeof input.action !== "string")
        throw new Error("Invalid Project host command envelope.");
      if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || Number(input.expiresAt) <= Date.now() || Number(input.expiresAt) > Date.now() + 180_000))
        throw new Error("Project host command deadline is invalid or expired.");
    });
    // Acks are idempotent, carry the request nonce and never acquire the permit.
    if (options.acknowledge(input)) return { accepted: true };
    const id = String(input.id), digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let entry = commands.get(id);
    if (entry && entry.digest !== digest) return yield* new IntegrationFailure(new Error("Project host command ID was reused with different arguments."));
    if (!entry) {
      if (commands.size >= MAX_COMMANDS) {
        const oldest = [...commands].find(([, value]) => value.completed && value.expiresAt <= Date.now());
        if (!oldest) return yield* new IntegrationFailure(new Error("Project host command queue is full."));
        commands.delete(oldest[0]);
      }
      entry = { digest, result: Deferred.makeUnsafe(), completed: false, expiresAt: Number(input.expiresAt ?? Date.now() + 180_000) };
      commands.set(id, entry);
      const result = yield* mutex.withPermit(options.command(input)).pipe(Effect.match({
        onSuccess: value => ({ protocol: NODE_RUNTIME_PROTOCOL, id, ...value }),
        onFailure: error => ({ protocol: NODE_RUNTIME_PROTOCOL, id, type: "failed", error: error.message }),
      }));
      entry.completed = true;
      yield* Deferred.succeed(entry.result, result);
    }
    const result = yield* Deferred.await(entry.result);
    options.emit({ ...result });
    return { accepted: true };
  }));
});
