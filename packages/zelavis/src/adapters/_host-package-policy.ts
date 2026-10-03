import { createHash } from "node:crypto";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/** Restore only the root operation's recorded policy, retaining an operator-edited one. */
export async function restoreHostPackagePolicy(stateDirectory: string, policy: string): Promise<string | undefined> {
  const owner = `${policy}.zelavis-owner`;
  const backup = `${policy}.zelavis-original`;
  const stat = (path: string) => lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const ownerStats = await stat(owner);
  const trusted = async (path: string) => {
    const stats = await stat(path);
    if (!stats?.isFile() || stats.isSymbolicLink() || stats.uid !== (process.getuid?.() ?? 0) || (stats.mode & 0o022)) {
      throw new Error(`Cannot prove host package policy ownership at ${path}.`);
    }
    return readFile(path, "utf8");
  };
  if (!ownerStats) {
    // Interrupted before the ownership record's atomic rename: no policy mutation
    // was permitted yet, but the pending record is still part of our inventory.
    if (await stat(`${owner}.new`) && (await trusted(`${owner}.new`)).trim() === stateDirectory) await rm(`${owner}.new`);
    return;
  }
  if ((await trusted(owner)).trim() !== stateDirectory) return;
  const digest = (await trusted(join(stateDirectory, "policy.digest"))).trim();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid host package policy ownership digest.");
  const hadOriginal = (await trusted(join(stateDirectory, "policy.had-original"))).trim();
  if (!["yes", "no"].includes(hadOriginal)) throw new Error("Invalid host package policy inventory.");
  const pending = await stat(`${policy}.new`);
  if (pending?.isFile() && !pending.isSymbolicLink() && pending.uid === ownerStats.uid &&
      createHash("sha256").update(await readFile(`${policy}.new`)).digest("hex") === digest) await rm(`${policy}.new`);
  if (await stat(`${owner}.new`) && (await trusted(`${owner}.new`)).trim() === stateDirectory) await rm(`${owner}.new`);
  const current = await stat(policy);
  const original = await stat(backup);
  const owned = current?.isFile() && !current.isSymbolicLink() && current.uid === ownerStats.uid &&
    createHash("sha256").update(await readFile(policy)).digest("hex") === digest;
  if (hadOriginal === "yes" && original && (owned || !current)) {
    await rename(backup, policy);
  } else if (hadOriginal === "no" && owned) {
    await rm(policy);
  } else if (hadOriginal === "yes" && !original && current) {
    // The operation recorded intent but was interrupted before moving the original.
    const expected = (await trusted(join(stateDirectory, "policy.original-digest"))).trim();
    if (createHash("sha256").update(await readFile(policy)).digest("hex") !== expected) {
      await rm(owner);
      return `Retaining operator-modified host policy at ${policy}.`;
    }
  } else if (current || original) {
    await rm(owner);
    return `Retaining operator-modified ${policy}${original ? ` and its original policy backup at ${backup}` : ""}.`;
  }
  await rm(owner);
}
