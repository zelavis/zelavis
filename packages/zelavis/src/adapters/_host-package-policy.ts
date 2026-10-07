import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { createHash } from "node:crypto";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/** Restore only the root operation's recorded policy, retaining an operator-edited one. */
export function restoreHostPackagePolicy(stateDirectory: string, policy: string): Promise<string | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<string | undefined, IntegrationFailure> {
  const owner = `${policy}.zelavis-owner`;
  const backup = `${policy}.zelavis-original`;
  const stat = (path: string) => lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const ownerStats = (yield* integrationValue(stat(owner)));
  const trusted = (path: string) => present(Effect.gen(function* () {
    const stats = (yield* integrationValue(stat(path)));
    if (!stats?.isFile() || stats.isSymbolicLink() || stats.uid !== (process.getuid?.() ?? 0) || (stats.mode & 0o022)) {
      throw new Error(`Cannot prove host package policy ownership at ${path}.`);
    }
    return (yield* integrationValue(readFile(path, "utf8")));
  }));
  if (!ownerStats) {
    // Interrupted before the ownership record's atomic rename: no policy mutation
    // was permitted yet, but the pending record is still part of our inventory.
    if ((yield* integrationValue(stat(`${owner}.new`))) && ((yield* integrationValue(trusted(`${owner}.new`)))).trim() === stateDirectory) (yield* integrationValue(rm(`${owner}.new`)));
    return;
  }
  if (((yield* integrationValue(trusted(owner)))).trim() !== stateDirectory) return;
  const digest = ((yield* integrationValue(trusted(join(stateDirectory, "policy.digest"))))).trim();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid host package policy ownership digest.");
  const hadOriginal = ((yield* integrationValue(trusted(join(stateDirectory, "policy.had-original"))))).trim();
  if (!["yes", "no"].includes(hadOriginal)) throw new Error("Invalid host package policy inventory.");
  const pending = (yield* integrationValue(stat(`${policy}.new`)));
  if (pending?.isFile() && !pending.isSymbolicLink() && pending.uid === ownerStats.uid &&
      createHash("sha256").update((yield* integrationValue(readFile(`${policy}.new`)))).digest("hex") === digest) (yield* integrationValue(rm(`${policy}.new`)));
  if ((yield* integrationValue(stat(`${owner}.new`))) && ((yield* integrationValue(trusted(`${owner}.new`)))).trim() === stateDirectory) (yield* integrationValue(rm(`${owner}.new`)));
  const current = (yield* integrationValue(stat(policy)));
  const original = (yield* integrationValue(stat(backup)));
  const owned = current?.isFile() && !current.isSymbolicLink() && current.uid === ownerStats.uid &&
    createHash("sha256").update((yield* integrationValue(readFile(policy)))).digest("hex") === digest;
  if (hadOriginal === "yes" && original && (owned || !current)) {
    (yield* integrationValue(rename(backup, policy)));
  } else if (hadOriginal === "no" && owned) {
    (yield* integrationValue(rm(policy)));
  } else if (hadOriginal === "yes" && !original && current) {
    // The operation recorded intent but was interrupted before moving the original.
    const expected = ((yield* integrationValue(trusted(join(stateDirectory, "policy.original-digest"))))).trim();
    if (createHash("sha256").update((yield* integrationValue(readFile(policy)))).digest("hex") !== expected) {
      (yield* integrationValue(rm(owner)));
      return `Retaining operator-modified host policy at ${policy}.`;
    }
  } else if (current || original) {
    (yield* integrationValue(rm(owner)));
    return `Retaining operator-modified ${policy}${original ? ` and its original policy backup at ${backup}` : ""}.`;
  }
  (yield* integrationValue(rm(owner)));
}));
  }
