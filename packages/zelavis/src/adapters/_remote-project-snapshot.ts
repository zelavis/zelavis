import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { createArtifactDigest, type ZelavisArtifactDigest } from "../core/artifact/index.js";
import { digestArtifactDirectory } from "./_recipe-artifact.js";
import { ZELAVIS_VERSION } from "../version.js";

const MAX_FILES = 20_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MARKER = ".zelavis/remote-install.json";

interface ProjectSnapshot {
  readonly formatVersion: 1;
  readonly projectId: string;
  readonly engineVersion: string;
  readonly files: readonly { readonly path: string; readonly body: string }[];
}

function validProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((part) => part && part !== "." && part !== "..") &&
    !value.startsWith("/") && value !== MARKER;
}

async function collect(root: string, directory = root,
  budget = { files: 0, bytes: 0 }): Promise<{ path: string; body: string }[]> {
  const files: { path: string; body: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collect(root, path, budget));
      continue;
    }
    if (!entry.isFile()) throw new Error("Remote Project snapshot contains a non-regular entry.");
    const relative = path.slice(root.length + 1).split(sep).join("/");
    if (!validPath(relative)) throw new Error("Remote Project snapshot contains an invalid path.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
        throw new Error("Remote Project snapshot contains an unsafe file.");
      }
      budget.files += 1;
      budget.bytes += stat.size;
      if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) {
        throw new Error("Remote Project snapshot exceeds its resource budget.");
      }
      files.push({ path: relative, body: (await file.readFile()).toString("base64") });
    } finally { await file.close(); }
  }
  return files;
}

/** Freeze a prepared Project exactly once for authenticated Agent delivery. */
export async function packRemoteProjectSnapshot(
  projectsDirectory: string,
  projectId: string,
): Promise<{ readonly body: Uint8Array; readonly digest: ZelavisArtifactDigest }> {
  if (!validProjectId(projectId)) throw new TypeError("Invalid Project id.");
  const root = resolve(projectsDirectory, projectId);
  if (!(await lstat(root)).isDirectory()) throw new Error("Project snapshot root is not a directory.");
  const files = (await collect(root)).sort((left, right) => left.path.localeCompare(right.path));
  // Only the frozen recipe travels. Anything else under `.zelavis` is Project
  // data (database, uploads, runtime state) that a copy would fork.
  if (files.some((file) => file.path.startsWith(".zelavis/") &&
      !file.path.startsWith(".zelavis/recipe/"))) {
    throw new Error("Project already has local runtime data and cannot be snapshotted for another Node.");
  }
  if (files.length < 2 || files.length > MAX_FILES ||
      !files.some((file) => file.path === "project.json")) {
    throw new Error("Remote Project snapshot has no prepared descriptor or exceeds the file limit.");
  }
  const body = new TextEncoder().encode(JSON.stringify({
    formatVersion: 1, projectId, engineVersion: ZELAVIS_VERSION, files,
  } satisfies ProjectSnapshot));
  if (body.byteLength > MAX_BYTES) throw new Error("Remote Project snapshot exceeds 64 MiB.");
  return { body, digest: await createArtifactDigest(body) };
}

/** Install only a digest-verified first snapshot; never overwrite remote data. */
export async function installRemoteProjectSnapshot(input: {
  readonly projectsDirectory: string;
  readonly projectId: string;
  readonly body: Uint8Array;
  readonly digest: ZelavisArtifactDigest;
}): Promise<void> {
  if (!validProjectId(input.projectId) || input.body.byteLength > MAX_BYTES ||
      await createArtifactDigest(input.body) !== input.digest) {
    throw new Error("Remote Project snapshot identity or digest is invalid.");
  }
  const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body)) as ProjectSnapshot;
  if (snapshot.formatVersion !== 1 || snapshot.projectId !== input.projectId ||
      snapshot.engineVersion !== ZELAVIS_VERSION ||
      !Array.isArray(snapshot.files) || snapshot.files.length < 2 ||
      snapshot.files.length > MAX_FILES) {
    throw new Error("Remote Project snapshot format or engine version is unsupported.");
  }
  const root = resolve(input.projectsDirectory);
  const destination = join(root, input.projectId);
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("Remote Project destination is unsafe.");
  }
  const prepared = await readPreparedRemoteProjectDigest(root, input.projectId);
  if (prepared) {
    if (prepared !== input.digest) throw new Error("Remote Project already owns different data.");
    return;
  }
  if (existing) throw new Error("Remote Project destination contains unmanaged data.");
  await mkdir(root, { recursive: true });
  const lockPath = join(root, `.install-${input.projectId}.lock`);
  const lockFile = await open(lockPath, "wx", 0o600);
  let staging: string | undefined;
  let installed = false;
  try {
    staging = await mkdtemp(join(root, ".incoming-"));
    const seen = new Set<string>();
    let total = 0;
    for (const entry of snapshot.files) {
      if (!entry || !validPath(entry.path) || typeof entry.body !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.body) ||
          seen.has(entry.path)) {
        throw new Error("Remote Project snapshot contains an invalid or duplicate file.");
      }
      seen.add(entry.path);
      const bytes = Buffer.from(entry.body, "base64");
      total += bytes.byteLength;
      if (total > MAX_BYTES) throw new Error("Remote Project snapshot exceeds the unpacked limit.");
      const target = join(staging, ...entry.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      const file = await open(target, "wx", 0o600);
      try { await file.writeFile(bytes); }
      finally { await file.close(); }
    }
    if (!seen.has("project.json")) throw new Error("Remote Project snapshot is missing project.json.");
    const descriptor = JSON.parse(await readFile(join(staging, "project.json"), "utf8")) as {
      id?: unknown; recipe?: { name?: unknown; version?: unknown; artifact?: { digest?: unknown } };
    };
    const lock = descriptor.recipe;
    if (descriptor.id !== input.projectId || typeof lock?.name !== "string" ||
        typeof lock.version !== "string" || typeof lock.artifact?.digest !== "string") {
      throw new Error("Remote Project descriptor has no exact recipe lock.");
    }
    const packageDirectory = join(staging, ".zelavis", "recipe", "package");
    if (await digestArtifactDirectory(packageDirectory) !== lock.artifact.digest) {
      throw new Error("Remote Project recipe bytes differ from their lock.");
    }
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as {
      name?: unknown; version?: unknown;
    };
    if (manifest.name !== lock.name || manifest.version !== lock.version) {
      throw new Error("Remote Project recipe identity differs from its lock.");
    }
    await mkdir(join(staging, ".zelavis"), { recursive: true });
    await writeFile(join(staging, MARKER), JSON.stringify({ digest: input.digest }), { mode: 0o600 });
    await rename(staging, destination);
    installed = true;
  } finally {
    if (!installed && staging) await rm(staging, { recursive: true, force: true });
    await lockFile.close();
    await rm(lockPath, { force: true });
  }
}

export async function readPreparedRemoteProjectDigest(
  projectsDirectory: string,
  projectId: string,
): Promise<ZelavisArtifactDigest | undefined> {
  if (!validProjectId(projectId)) return undefined;
  const marker = join(resolve(projectsDirectory), projectId, MARKER);
  try {
    const file = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: { digest?: unknown };
    try { value = JSON.parse(await file.readFile("utf8")) as { digest?: unknown }; }
    finally { await file.close(); }
    if (typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) {
      throw new Error("Remote Project install marker is invalid.");
    }
    return value.digest as ZelavisArtifactDigest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
