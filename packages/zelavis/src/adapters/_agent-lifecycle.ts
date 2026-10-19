import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { isBoolean, isPositiveInteger, isString, isTimestamp, literal, objectFields, parseJson } from "../core/json-validation.js";
import { evaluate, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { isExactVersion } from "../updates.js";
import { ZELAVIS_VERSION } from "../version.js";

export interface AgentDescriptor {
  readonly protocol: "zelavis-agent/1";
  readonly release: string;
  readonly pid: number;
  readonly generation: string;
  readonly bootId: string;
  readonly startedAt: string;
  readonly survivable: boolean;
}
const descriptorSchema = objectFields<AgentDescriptor>({ protocol: literal("zelavis-agent/1"), release: isString,
  pid: isPositiveInteger, generation: isString, bootId: isString, startedAt: isTimestamp, survivable: isBoolean });
const markerSchema = objectFields<{ nonce: string; generation: string; bootId: string; target: string; expiresAt: string }>({
  nonce: isString, generation: isString, bootId: isString, target: isString, expiresAt: isTimestamp,
});
const readPrivate = Effect.fn("AgentLifecycle.readPrivate")(function* (path: string) {
  return yield* Effect.acquireUseRelease(integration(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)), file => Effect.gen(function* () {
    const stats = yield* integration(() => file.stat());
    yield* evaluate(() => { if (!stats.isFile() || stats.size > 4096 || (stats.mode & 0o077) !== 0) throw new Error("Agent lifecycle state must be a bounded private regular file."); });
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = yield* integration(() => file.read(bytes, 0, bytes.length, 0));
    return yield* evaluate(() => { if (bytesRead > 4096) throw new Error("Agent lifecycle state exceeds its size bound."); return bytes.subarray(0, bytesRead).toString("utf8"); });
  }), file => integration(() => file.close()).pipe(Effect.orDie));
});
const writePrivate = Effect.fn("AgentLifecycle.writePrivate")(function* (directory: string, name: string, value: unknown) {
  const owner = yield* integration(() => lstat(directory));
  yield* evaluate(() => { if (!owner.isDirectory() || owner.isSymbolicLink()) throw new Error("Agent lifecycle directory is not a real directory."); });
  const temporary = join(directory, `.${name}.${randomUUID()}`);
  yield* Effect.gen(function* () {
    yield* Effect.acquireUseRelease(integration(() => open(temporary, "wx", 0o600)), file => Effect.gen(function* () {
      yield* integration(() => file.writeFile(`${JSON.stringify(value)}\n`));
      // Root updater writes a marker the unprivileged Project Agent can read.
      if (process.getuid?.() === 0) yield* integration(() => file.chown(owner.uid, owner.gid));
      yield* integration(() => file.sync());
    }), file => integration(() => file.close()).pipe(Effect.orDie));
    yield* integration(() => rename(temporary, join(directory, name)));
    yield* Effect.acquireUseRelease(integration(() => open(directory, "r")), file => integration(() => file.sync()), file => integration(() => file.close()).pipe(Effect.orDie));
  }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
});
export const readAgentDescriptor = Effect.fn("AgentLifecycle.readDescriptor")(function* (directory: string) {
  const source = yield* readPrivate(join(directory, "agent.json")).pipe(Effect.catchIf(error => (error.cause as NodeJS.ErrnoException)?.code === "ENOENT", () => Effect.succeed(undefined)));
  return source === undefined ? undefined : yield* evaluate(() => parseJson(source, descriptorSchema));
});
export const publishAgentDescriptor = Effect.fn("AgentLifecycle.publishDescriptor")(function* (directory: string, survivable: boolean) {
  const descriptor: AgentDescriptor = { protocol: "zelavis-agent/1", release: ZELAVIS_VERSION, pid: process.pid,
    generation: randomUUID(), startedAt: new Date().toISOString(), survivable,
    bootId: process.platform === "linux" ? (yield* integration(() => readFile("/proc/sys/kernel/random/boot_id", "utf8"))).trim() : "user-host",
  };
  yield* writePrivate(directory, "agent.json", descriptor);
  // Any unconsumed marker belongs to a prior generation and must not affect a
  // later explicit stop, even when the old Agent crashed before consuming it.
  yield* integration(() => rm(join(directory, "handover.json"), { force: true }));
  return descriptor;
});
export const prepareAgentHandover = Effect.fn("AgentLifecycle.prepareHandover")(function* (directory: string, target: string) {
  if (!isExactVersion(target)) return yield* new IntegrationFailure(new Error("Agent handover requires an exact release."));
  const descriptor = yield* readAgentDescriptor(directory);
  if (!descriptor?.survivable) return yield* new IntegrationFailure(new Error("Agent requires the explicit pre-handover conversion."));
  const nonce = randomUUID();
  yield* writePrivate(directory, "handover.json", { nonce, generation: descriptor.generation, bootId: descriptor.bootId,
    target, expiresAt: new Date(Date.now() + 120_000).toISOString() });
  return nonce;
});
export const consumeAgentHandover = Effect.fn("AgentLifecycle.consumeHandover")(function* (directory: string, descriptor: AgentDescriptor) {
  const path = join(directory, "handover.json");
  const source = yield* readPrivate(path).pipe(Effect.catch(error => {
    if ((error.cause as NodeJS.ErrnoException)?.code === "ENOENT") return Effect.succeed(undefined);
    return Effect.logWarning("Invalid Agent handover marker; performing ordinary shutdown.").pipe(Effect.as(undefined));
  }));
  yield* integration(() => rm(path, { force: true }));
  if (!source || !descriptor.survivable) return false;
  return yield* evaluate(() => {
    const marker = parseJson(source, markerSchema);
    return /^[a-f0-9-]{36}$/.test(marker.nonce) && marker.generation === descriptor.generation &&
      marker.bootId === descriptor.bootId && isExactVersion(marker.target) &&
      Date.parse(marker.expiresAt) > Date.now() && Date.parse(marker.expiresAt) <= Date.now() + 120_000;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
});
