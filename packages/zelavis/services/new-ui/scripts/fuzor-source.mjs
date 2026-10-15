// Fuzor comes from the owner's own checkout (FUZOR_DIR, default ../fuzor next to this repository), never from npm,
// so Zelavis always builds against the Fuzor that is on disk now. Its compiled output can lag behind its sources,
// so a build first rebuilds Fuzor when any source file is newer than `dist`, and records which Fuzor it used.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fuzorRoot, packageRoot } from "./link-local.mjs";

const fuzorPackage = resolve(fuzorRoot, "packages/fuzor");

function newest(directory) {
  let latest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

/** Rebuilds Fuzor's compiled output when its sources (or package.json) are newer. A failing Fuzor build fails ours. */
export function ensureFuzorBuilt() {
  const entry = join(fuzorPackage, "dist/cli.js");
  const sourceTime = Math.max(newest(join(fuzorPackage, "src")), statSync(join(fuzorPackage, "package.json")).mtimeMs);
  if (existsSync(entry) && statSync(entry).mtimeMs >= sourceTime) return false;
  console.log(`Fuzor changed since its last build; rebuilding ${fuzorPackage} ...`);
  const result = spawnSync("pnpm", ["--filter", "fuzor", "build"], { cwd: fuzorRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error("The Fuzor build failed; fix it in the Fuzor repository, then build the dashboard again.");
  return true;
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: fuzorRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Which Fuzor this build used: its version, commit, and a digest of any uncommitted changes, so a dashboard that
 * shipped can be traced to the exact Fuzor even when that was a working tree.
 */
export function fuzorProvenance() {
  const manifest = JSON.parse(readFileSync(join(fuzorPackage, "package.json"), "utf8"));
  const dirty = git("status", "--porcelain", "--", "packages/fuzor");
  const diff = git("diff", "HEAD", "--", "packages/fuzor");
  return {
    fuzor: manifest.version,
    commit: git("rev-parse", "HEAD") ?? "unknown",
    uncommittedFiles: dirty ? dirty.split("\n").length : 0,
    uncommittedDigest: diff ? createHash("sha256").update(diff).digest("hex") : null,
    builtAt: new Date().toISOString(),
  };
}

export function writeFuzorProvenance() {
  const target = join(packageRoot, ".fuzor/fuzor-build.json");
  mkdirSync(join(packageRoot, ".fuzor"), { recursive: true });
  writeFileSync(target, `${JSON.stringify(fuzorProvenance(), null, 2)}\n`);
  return target;
}
