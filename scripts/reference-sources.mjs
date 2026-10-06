import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const effectOrigin = "https://github.com/Effect-TS/effect.git";
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const commitId = /^[0-9a-f]{40}$/;
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const runGit = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function effectVersion(root) {
  const paths = runGit(["ls-files", "-z", "--", "package.json", "**/package.json", ":!repos/**"], root).split("\0").filter(Boolean);
  const pins = [];
  for (const path of paths) {
    const manifest = readJSON(join(root, path));
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (manifest[field]?.effect !== undefined) pins.push([`${path}:${field}`, manifest[field].effect]);
    }
  }
  if (pins.length === 0) throw new Error("No workspace manifest pins Effect.");
  if (pins.some(([, version]) => !exactVersion.test(version))) throw new Error(`Effect requires exact versions: ${pins.map(([path, version]) => `${path}=${version}`).join(", ")}`);
  const versions = new Set(pins.map(([, version]) => version));
  if (versions.size !== 1) throw new Error(`Conflicting Effect pins: ${pins.map(([path, version]) => `${path}=${version}`).join(", ")}`);
  return [...versions][0];
}

export function sourceRecord(root) {
  const record = readJSON(join(root, "scripts/reference-sources.json"));
  if (record.effect?.url !== effectOrigin || !exactVersion.test(record.effect?.version ?? "") || !commitId.test(record.effect?.commit ?? "")) {
    throw new Error("Invalid Effect reference record: expected the official HTTPS origin, an exact version and a full commit ID.");
  }
  return record;
}

function assertDirectory(path) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error(`Expected a regular directory: ${path}`);
}

export function checkoutState(root, record) {
  const destination = join(root, "repos/effect");
  assertDirectory(join(root, "repos"));
  assertDirectory(destination);
  if (!existsSync(destination)) return "missing";
  if (!existsSync(join(destination, ".git"))) throw new Error("repos/effect is not a managed Git checkout. Move it aside before running pnpm refs:sync; it will not be overwritten.");
  assertDirectory(join(destination, ".git"));
  if (realpathSync(runGit(["rev-parse", "--show-toplevel"], destination)) !== realpathSync(destination)) throw new Error("repos/effect must be its own Git checkout.");
  // Include ignored files: local downloads and edits must not be silently lost.
  if (runGit(["status", "--porcelain", "--untracked-files=all", "--ignored"], destination)) throw new Error("repos/effect has local changes or extra files. Preserve or remove them before running pnpm refs:sync.");
  const version = readJSON(join(destination, "packages/effect/package.json")).version;
  const head = runGit(["rev-parse", "HEAD"], destination);
  const metadataPath = join(destination, ".git/zelavis-reference.json");
  if (existsSync(metadataPath)) {
    const metadata = readJSON(metadataPath);
    if (metadata.url !== effectOrigin || metadata.commit !== head || metadata.version !== version) throw new Error("repos/effect has local commits or changed reference metadata; preserve them before syncing.");
  } else if (head !== record.commit || version !== record.version) {
    throw new Error("repos/effect is an unrecognized checkout; move it aside before syncing.");
  }
  return head === record.commit && version === record.version ? "matching" : "stale";
}

export function checkReferences(root) {
  const version = effectVersion(root);
  const record = sourceRecord(root).effect;
  if (record.version !== version) throw new Error(`Reference record is ${record.version}, but workspace Effect is ${version}. Run pnpm refs:sync.`);
  const state = checkoutState(root, record);
  if (state === "stale") throw new Error(`Local Effect reference does not match ${version} at ${record.commit}. Run pnpm refs:sync.`);
  return state === "missing" ? `Effect pins and reference record match ${version}. Optional source is absent; run pnpm refs:sync before Effect development.` : `Local Effect reference matches ${version} at ${record.commit}.`;
}

export function syncReferences(root, git = runGit) {
  const version = effectVersion(root);
  const record = sourceRecord(root);
  const destination = join(root, "repos/effect");
  const repos = join(root, "repos");
  const state = checkoutState(root, record.effect);
  if (record.effect.version === version && state === "matching") {
    const metadataPath = join(destination, ".git/zelavis-reference.json");
    if (!existsSync(metadataPath)) writeFileSync(metadataPath, `${JSON.stringify(record.effect, null, 2)}\n`);
    return `Effect ${version} reference already matches; no download needed.`;
  }
  mkdirSync(repos, { recursive: true });
  const lock = join(repos, ".refs-sync.lock");
  // A concurrent sync must not race the directory swap. A stale lock is left
  // after forced termination; inspect it before removing it manually.
  mkdirSync(lock);
  let stage;
  let swapped = false;
  let hadPrevious = false;
  let committed = false;
  const manifestPath = join(root, "scripts/reference-sources.json");
  const manifestTemp = join(lock, "reference-sources.json");
  try {
    let commit = record.effect.commit;
    if (record.effect.version !== version) {
      const tag = `refs/tags/effect@${version}`;
      const rows = git(["ls-remote", "--exit-code", effectOrigin, tag, `${tag}^{}`], root).split("\n").map((line) => line.split(/\s+/));
      commit = (rows.find(([, ref]) => ref === `${tag}^{}`) ?? rows.find(([, ref]) => ref === tag))?.[0];
      if (!commitId.test(commit ?? "")) throw new Error(`No exact upstream release tag effect@${version}.`);
    }
    stage = mkdtempSync(join(repos, ".refs-stage-"));
    const source = join(stage, "source");
    mkdirSync(source);
    git(["init", "--quiet"], source);
    git(["remote", "add", "origin", effectOrigin], source);
    git(["-c", "core.hooksPath=/dev/null", "fetch", "--quiet", "--depth=1", "origin", commit], source);
    git(["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", "FETCH_HEAD"], source);
    if (git(["rev-parse", "HEAD"], source) !== commit || readJSON(join(source, "packages/effect/package.json")).version !== version) throw new Error("Fetched Effect source does not match the selected commit and workspace version.");
    if (effectVersion(root) !== version || JSON.stringify(sourceRecord(root)) !== JSON.stringify(record)) throw new Error("Workspace pins or reference record changed during sync; retry.");
    checkoutState(root, record.effect); // Recheck local changes before replacement.
    const next = { ...record, effect: { url: effectOrigin, version, commit } };
    writeFileSync(join(source, ".git/zelavis-reference.json"), `${JSON.stringify(next.effect, null, 2)}\n`);
    writeFileSync(manifestTemp, `${JSON.stringify(next, null, 2)}\n`);
    hadPrevious = existsSync(destination);
    if (hadPrevious) renameSync(destination, join(stage, "previous"));
    try {
      renameSync(source, destination);
      swapped = true;
      renameSync(manifestTemp, manifestPath);
      committed = true;
    } catch (error) {
      if (swapped) rmSync(destination, { recursive: true, force: true });
      if (hadPrevious) renameSync(join(stage, "previous"), destination);
      throw error;
    }
    return `Synced Effect ${version} at ${commit} into repos/effect. Review scripts/reference-sources.json when upgrading Effect.`;
  } finally {
    // Preserve a backup if rollback failed rather than deleting the last copy.
    if (stage && (committed || !existsSync(join(stage, "previous")))) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
