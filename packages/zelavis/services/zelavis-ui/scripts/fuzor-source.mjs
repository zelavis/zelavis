// Which Fuzor this dashboard builds against.
//
// On the owner's machine that is their own checkout (FUZOR_DIR, default `../fuzor` beside this repository), so
// Zelavis always builds against the Fuzor on disk: a stale compiled copy is rebuilt first, and `fuzor`, `vite` and
// `typescript` in node_modules are pointed at it. Anywhere else (another contributor, CI) there is no checkout and
// the pinned `fuzor` from npm that `pnpm install` put in node_modules is used. Either way the build records which
// Fuzor it used in `.fuzor/fuzor-build.json`. The Platform package ships only the built dashboard, so an
// installation never needs Fuzor; only a machine that builds does.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const workspaceRoot = resolve(packageRoot, "../../../..");
export const fuzorRoot = resolve(process.env.FUZOR_DIR ?? resolve(workspaceRoot, "../fuzor"));
const fuzorPackage = resolve(fuzorRoot, "packages/fuzor");
/** `ZELAVIS_FUZOR=npm` forces the pinned npm Fuzor even where a checkout exists. */
export const fuzorSource = existsSync(join(fuzorPackage, "package.json")) && process.env.ZELAVIS_FUZOR !== "npm" ? "local" : "npm";

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

function point(name, target) {
  if (!existsSync(target)) throw new Error(`Missing ${target}. Install the Fuzor repository's dependencies first.`);
  const link = resolve(packageRoot, "node_modules", name);
  mkdirSync(dirname(link), { recursive: true });
  let current;
  try { current = lstatSync(link); } catch { current = undefined; }
  if (current?.isSymbolicLink()) {
    if (resolve(dirname(link), readlinkSync(link)) === target) return;
    rmSync(link);
  } else if (current) throw new Error(`${link} is a real directory, not a link; refusing to replace it.`);
  symlinkSync(target, link, "dir");
}

function selectFuzor() {
  if (fuzorSource !== "local") {
    // A checkout build points node_modules at the checkout; `pnpm install` puts the pinned npm Fuzor back.
    const installed = realpathSync(resolve(packageRoot, "node_modules/fuzor"));
    if (!installed.includes(`${sep}node_modules${sep}.pnpm${sep}`)) throw new Error("node_modules/fuzor still points at a Fuzor checkout. Run `pnpm install` to restore the pinned npm Fuzor.");
    return;
  }
  ensureFuzorBuilt();
  point("fuzor", fuzorPackage);
  point("vite", resolve(fuzorPackage, "node_modules/vite"));
  point("typescript", resolve(fuzorPackage, "node_modules/typescript"));
}
selectFuzor();

function git(...args) {
  const result = spawnSync("git", args, { cwd: fuzorRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Which Fuzor this build used: its version and, for a checkout, its commit and a digest of any uncommitted
 * changes, so a dashboard that shipped can be traced to the exact Fuzor even when that was a working tree.
 */
export function fuzorProvenance() {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "node_modules/fuzor/package.json"), "utf8"));
  const builtAt = new Date().toISOString();
  if (fuzorSource === "npm") return { source: "npm", fuzor: manifest.version, builtAt };
  const dirty = git("status", "--porcelain", "--", "packages/fuzor");
  const diff = git("diff", "HEAD", "--", "packages/fuzor");
  return {
    source: "checkout",
    fuzor: manifest.version,
    commit: git("rev-parse", "HEAD") ?? "unknown",
    uncommittedFiles: dirty ? dirty.split("\n").length : 0,
    uncommittedDigest: diff ? createHash("sha256").update(diff).digest("hex") : null,
    builtAt,
  };
}

export function writeFuzorProvenance() {
  const target = join(packageRoot, ".fuzor/fuzor-build.json");
  mkdirSync(join(packageRoot, ".fuzor"), { recursive: true });
  writeFileSync(target, `${JSON.stringify(fuzorProvenance(), null, 2)}\n`);
  return target;
}
