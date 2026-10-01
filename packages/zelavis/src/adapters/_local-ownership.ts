import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeInstallation } from "../cli/installation.js";

export interface LocalOwnershipLease { release(): Promise<void> }
export interface LocalDataOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly session: string;
  readonly installationRoot?: string;
  readonly purpose: "platform" | "maintenance";
}

/** Kernel-released reservation; no PID-only stale-lock takeover. */
async function sqliteReservation(path: string): Promise<LocalOwnershipLease> {
  // Node and Bun use the same on-disk lock and SQLite's process-death semantics.
  const moduleName = "Bun" in globalThis ? "bun:sqlite" : "node:sqlite";
  const sqlite = await import(moduleName) as { DatabaseSync?: new (path: string) => { exec(sql: string): void; close(): void }; Database?: new (path: string, options: { create: boolean }) => { exec(sql: string): void; close(): void } };
  const db = sqlite.DatabaseSync ? new sqlite.DatabaseSync(path) : new sqlite.Database!(path, { create: true });
  try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
  catch (error) { db.close(); throw new Error(`Local ownership is already reserved at ${path}. Stop the owning Platform or wait for installation maintenance to finish.`, { cause: error }); }
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
export async function acquireLocalDataOwnership(directory: string, purpose: LocalDataOwner["purpose"] = "platform"): Promise<LocalOwnershipLease> {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  const path = join(root, ".platform.lock");
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Refusing a symlinked Platform ownership lock."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lease = await sqliteReservation(path);
  const ownerFile = join(root, ".platform-owner.json");
  const temporary = `${ownerFile}.${randomUUID()}`;
  let installationRoot: string | undefined;
  try { if (process.argv[1]) installationRoot = describeInstallation(await realpath(process.argv[1])).root; } catch {}
  const owner: LocalDataOwner = { pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), session: randomUUID(), purpose, ...(installationRoot ? { installationRoot } : {}) };
  try {
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, ownerFile);
  } catch (error) { await rm(temporary, { force: true }); await lease.release(); throw error; }
  return { async release() {
    try {
      const current = await readLocalDataOwner(root);
      if (current?.session === owner.session) await rm(ownerFile, { force: true });
    } finally { await lease.release(); }
  } };
}

export async function readLocalDataOwner(directory: string): Promise<LocalDataOwner | undefined> {
  let content: string;
  try { content = await readFile(join(directory, ".platform-owner.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value = JSON.parse(content) as LocalDataOwner;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.session !== "string" || !["platform", "maintenance"].includes(value.purpose)) throw new Error("Malformed Platform ownership record.");
  return value;
}
