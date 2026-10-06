import { integrationValue, unwrapIntegrationResult, presentProtocol } from "../core/runtime/effect-boundary.js";
import { parseJson, objectFields, isString, isPositiveInteger, isTimestamp, optional, literal } from "../core/json-validation.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describeInstallation } from "../cli/installation.js";
import { evaluate, integration, IntegrationFailure, present, unwrapFailure } from "../core/runtime/effect-boundary.js";

export interface LocalOwnershipLease { release(): Promise<void> }
export interface LocalDataOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly session: string;
  readonly installationRoot?: string;
  readonly purpose: "platform" | "maintenance";
}

async function openSqlite(path: string): Promise<{ exec(sql: string): void; close(): void }> {
  // Node and Bun use the same on-disk lock and SQLite's process-death semantics.
  const moduleName = "Bun" in globalThis ? "bun:sqlite" : "node:sqlite";
  const sqlite = await import(moduleName) as { DatabaseSync?: new (path: string) => { exec(sql: string): void; close(): void }; Database?: new (path: string, options: { create: boolean }) => { exec(sql: string): void; close(): void } };
  return sqlite.DatabaseSync ? new sqlite.DatabaseSync(path) : new sqlite.Database!(path, { create: true });
}

/**
 * Gives a reservation file its database header once, by whoever may write beside it.
 *
 * Taking a lock on an empty SQLite file writes that header, which needs a journal
 * file in the file's directory. The Edge reservation lives in the root-owned
 * installation prefix, which the service user cannot write, so the installer
 * (root) initializes it and the service then only ever takes the lock.
 */
async function initializeReservationFile(path: string): Promise<void> {
  const db = await openSqlite(path);
  try { db.exec("CREATE TABLE IF NOT EXISTS zelavis_reservation (id INTEGER)"); }
  finally { db.close(); }
}

/** Kernel-released reservation; no PID-only stale-lock takeover. */
async function sqliteReservation(path: string): Promise<LocalOwnershipLease> {
  const db = await openSqlite(path);
  try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
  catch (error) {
    db.close();
    // SQLite refuses for more than one reason (held by another process, an
    // unreadable or read-only file), so say which rather than always "reserved".
    const failure = error as { errcode?: number; errstr?: string; message?: string };
    const reason = failure.errstr ?? failure.message ?? "unknown";
    if (failure.errcode === 5 || /locked|busy/i.test(reason)) {
      throw new Error(`Local ownership is already reserved at ${path}. Stop the owning Platform or wait for installation maintenance to finish.`, { cause: error });
    }
    throw new Error(`Local ownership could not be reserved at ${path} (${reason}). Check that this user can read and write the file.`, { cause: error });
  }
  let released = false;
  return { async release() { if (!released) { released = true; db.close(); } } };
}

export async function acquireNodeInstallerLock(prefix: string): Promise<LocalOwnershipLease> {
  await mkdir(prefix, { recursive: true });
  const path = join(prefix, ".install.lock");
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Refusing a symlinked installer lock."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (process.platform !== "linux") {
    const lease = await sqliteReservation(path);
    try { await chmod(path, 0o600); } catch (error) { await lease.release(); throw error; }
    return lease;
  }
  // flock inherits its lock into the shell; EOF on the parent's pipe releases
  // it even if the installing Node is killed outright. Never unlink this inode.
  const child = spawn("flock", ["--exclusive", "--nonblock", "--no-fork", path, "/bin/sh", "-c", "printf 'locked\\n'; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  await new Promise<void>((resolveLock, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Installer lock ${path} is busy or flock is unavailable (exit ${code}). On Linux install util-linux; otherwise wait for the current installer.`)));
    child.stdout.once("data", () => resolveLock());
  });
  try { await chmod(path, 0o600); } catch (error) { child.stdin.end(); await exited; throw error; }
  let released = false;
  return { async release() { if (!released) { released = true; child.stdin.end(); await exited; } } };
}

/** One guard for runtime startup and installer maintenance of the same data. */
const acquireDataOwnership = Effect.fn("LocalOwnership.acquireData")(function* (directory: string, purpose: LocalDataOwner["purpose"]) {
  yield* integration(() => mkdir(directory, { recursive: true }));
  const root = yield* integration(() => realpath(directory));
  const path = join(root, ".platform.lock");
  const stat = yield* integration(() => lstat(path)).pipe(Effect.catchIf(error => (unwrapFailure(error) as NodeJS.ErrnoException).code === "ENOENT", () => Effect.void));
  if (stat?.isSymbolicLink()) return yield* new IntegrationFailure(new Error("Refusing a symlinked Platform ownership lock."));
  const lease = yield* integration(() => sqliteReservation(path));
  const ownerFile = join(root, ".platform-owner.json");
  const temporary = `${ownerFile}.${randomUUID()}`;
  // The binding belongs to the selected engine; argv may name its private worker.
  const installationRoot = yield* integration(() => realpath(fileURLToPath(new URL("../cli.js", import.meta.url)))).pipe(
    Effect.flatMap((cli) => evaluate(() => describeInstallation(cli).root)),
    Effect.catch(() => Effect.void),
  );
  const owner: LocalDataOwner = { pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), session: randomUUID(), purpose, ...(installationRoot ? { installationRoot } : {}) };
  yield* integration(() => writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" })).pipe(
    Effect.andThen(integration(() => rename(temporary, ownerFile))),
    Effect.onError(() => integration(() => rm(temporary, { force: true })).pipe(Effect.ensuring(integration(() => lease.release()).pipe(Effect.orDie)), Effect.orDie)),
  );
  const release = Effect.gen(function* () {
    const current = yield* integration(() => readLocalDataOwner(root));
    if (current?.session === owner.session) yield* integration(() => rm(ownerFile, { force: true }));
  }).pipe(Effect.ensuring(integration(() => lease.release()).pipe(Effect.orDie)), Effect.uninterruptible);
  return { release: () => present(release) };
});
export function acquireLocalDataOwnership(directory: string, purpose: LocalDataOwner["purpose"] = "platform"): Promise<LocalOwnershipLease> {
  return present(acquireDataOwnership(directory, purpose).pipe(Effect.uninterruptible));
}

export function readLocalDataOwner(directory: string): Promise<LocalDataOwner | undefined> { return presentProtocol(Effect.gen(function* () {
  let content: string;
  try { content = unwrapIntegrationResult(yield* Effect.result(integrationValue(readFile(join(directory, ".platform-owner.json"), "utf8")))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value = parseJson(content, ownerRecord);
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.session !== "string" || !["platform", "maintenance"].includes(value.purpose)) throw new Error("Malformed Platform ownership record.");
  return (yield* integrationValue(value));
}).pipe(Effect.withSpan("readLocalDataOwner"))); }


export interface LocalEdgeSelection { readonly prefix: string; readonly instance: string; readonly dataDirectory: string }
/** The prefix installer lock serializes persistent host Edge claims. */
export async function claimLocalEdgeOwner(selection: LocalEdgeSelection): Promise<void> {
  if (selection.instance !== "default") throw new Error("Only the default instance may own host Edge.");
  const file = join(selection.prefix, "edge-owner.json");
  const current = await readEdgeOwner(selection.prefix);
  if (current && (current.instance !== selection.instance || current.dataDirectory !== selection.dataDirectory)) throw new Error(`Host Edge belongs to instance ${current.instance} at ${current.dataDirectory}.`);
  const lock = join(selection.prefix, ".edge-owner.lock");
  await refuseEdgeSymlink(lock);
  await initializeReservationFile(lock);
  const lease = await sqliteReservation(lock);
  try {
    // The default service can reserve the existing inode, but cannot alter its
    // root-owned parent or the persistent ownership record.
    await chmod(lock, 0o660);
    const temporary = `${file}.${randomUUID()}`;
    try { await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...selection })}\n`, { mode: 0o644, flag: "wx" }); await chmod(temporary, 0o644); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  } finally { await lease.release(); }
}
async function refuseEdgeSymlink(path: string) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Refusing a symlinked Edge ownership path."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export async function readEdgeOwner(prefix: string): Promise<LocalEdgeSelection | undefined> {
  const file = join(prefix, "edge-owner.json");
  await refuseEdgeSymlink(file);
  let content: string;
  try { content = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const value = JSON.parse(content);
  if (value.schemaVersion !== 1 || value.prefix !== prefix || typeof value.instance !== "string" || typeof value.dataDirectory !== "string") throw new Error("Malformed host Edge ownership record.");
  return value;
}
/** Held until Platform.close; process death releases the kernel reservation. */
export async function acquireLocalEdgeOwnership(selection: LocalEdgeSelection): Promise<LocalOwnershipLease> {
  const current = await readEdgeOwner(selection.prefix);
  if (selection.instance !== "default" || !current || current.instance !== selection.instance || current.dataDirectory !== selection.dataDirectory) throw new Error("This instance has no host Edge ownership; secondary instances must run with Edge off.");
  const lock = join(selection.prefix, ".edge-owner.lock");
  await refuseEdgeSymlink(lock);
  // Runtime never creates a missing root-owned reservation.
  await lstat(lock);
  return sqliteReservation(lock);
}
export async function releaseLocalEdgeOwner(selection: LocalEdgeSelection): Promise<void> {
  const current = await readEdgeOwner(selection.prefix);
  if (!current) return;
  if (current.instance !== selection.instance || current.dataDirectory !== selection.dataDirectory) throw new Error(`Refusing to release Edge owned by ${current.instance}.`);
  const lock = join(selection.prefix, ".edge-owner.lock");
  await refuseEdgeSymlink(lock);
  const lease = await sqliteReservation(lock);
  try { await rm(join(selection.prefix, "edge-owner.json"), { force: true }); await rm(lock, { force: true }); }
  finally { await lease.release(); }
}

const ownerRecord = objectFields<LocalDataOwner>({ pid: isPositiveInteger, startedAt: isTimestamp, session: isString, installationRoot: optional(isString), purpose: literal("platform", "maintenance") });
