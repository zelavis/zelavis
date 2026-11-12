// Canonical distribution runtime downloads and checksum verification.
// Published as generated installation assets; never maintain another copy.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });

export async function verifyFileChecksum(path, expected) {
  if (!/^[a-fA-F0-9]{64}$/.test(expected ?? "")) throw new Error("Invalid SHA-256 checksum.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected.toLowerCase()) throw new Error(`Checksum mismatch for ${path}.`);
}

const DOWNLOAD_ATTEMPTS = 5;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

// A release host that drops a connection or answers 5xx/429 for a moment is asked again, 2, 4, 8 and 16 seconds
// later; any other answer is final. Every attempt has its own time limit, so a stalled connection cannot hang an install.
async function downloadOnce(url, destination) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (response.ok) {
      await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
      return undefined;
    }
  } catch (cause) {
    return { transient: true, error: new Error(`Download failed (${cause?.cause?.code ?? cause?.name ?? "network error"}): ${url}`, { cause }) };
  }
  return { transient: response.status >= 500 || response.status === 429, error: new Error(`Download failed (${response.status}): ${url}`) };
}

async function download(url, destination) {
  for (let attempt = 1; ; attempt += 1) {
    const failed = await downloadOnce(url, destination);
    if (failed === undefined) return;
    if (!failed.transient) throw failed.error;
    if (attempt === DOWNLOAD_ATTEMPTS) throw new Error(`${failed.error.message} (after ${DOWNLOAD_ATTEMPTS} attempts)`, { cause: failed.error });
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

export async function installNodeRuntime(output, nodeVersion, releaseTarget, cacheRoot) {
  const extension = releaseTarget.platform === "linux" ? "tar.xz" : "tar.gz";
  const directoryName = `node-v${nodeVersion}-${releaseTarget.platform}-${releaseTarget.architecture}`;
  const archiveName = `${directoryName}.${extension}`;
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const cacheDirectory = join(cacheRoot, "node", nodeVersion);
  const archivePath = join(cacheDirectory, archiveName);
  const checksumsPath = join(cacheDirectory, "SHASUMS256.txt");
  await mkdir(cacheDirectory, { recursive: true });

  try {
    await readFile(archivePath);
  } catch {
    await download(`${baseUrl}/${archiveName}`, archivePath);
  }
  try {
    await readFile(checksumsPath);
  } catch {
    await download(`${baseUrl}/SHASUMS256.txt`, checksumsPath);
  }

  const checksums = await readFile(checksumsPath, "utf8");
  const expected = checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archiveName)?.[0];
  if (!expected) {
    throw new Error(`Node checksum is missing for ${archiveName}.`);
  }
  await verifyFileChecksum(archivePath, expected);

  const runtimeDirectory = join(output, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  run("tar", ["--no-same-owner", "-xf", archivePath, "-C", runtimeDirectory]);
  await rename(join(runtimeDirectory, directoryName), join(runtimeDirectory, "node"));
}

export async function installTraefikRuntime(output, traefikVersion, releaseTarget, cacheRoot) {
  if (releaseTarget.platform !== "linux") return false;
  const architecture = { x64: "amd64", arm64: "arm64" }[releaseTarget.architecture];
  if (!architecture) {
    throw new Error(`Unsupported Traefik architecture: ${releaseTarget.architecture}`);
  }
  const archiveName = `traefik_v${traefikVersion}_linux_${architecture}.tar.gz`;
  const checksumsName = `traefik_v${traefikVersion}_checksums.txt`;
  const baseUrl = `https://github.com/traefik/traefik/releases/download/v${traefikVersion}`;
  const cacheDirectory = join(cacheRoot, "traefik", traefikVersion);
  const archivePath = join(cacheDirectory, archiveName);
  const checksumsPath = join(cacheDirectory, checksumsName);
  await mkdir(cacheDirectory, { recursive: true });
  try { await readFile(archivePath); } catch { await download(`${baseUrl}/${archiveName}`, archivePath); }
  try { await readFile(checksumsPath); } catch { await download(`${baseUrl}/${checksumsName}`, checksumsPath); }

  const expected = (await readFile(checksumsPath, "utf8"))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archiveName)?.[0];
  if (!expected) throw new Error(`Traefik checksum is missing for ${archiveName}.`);
  await verifyFileChecksum(archivePath, expected);

  const targetDirectory = join(output, "edge", "traefik");
  await mkdir(targetDirectory, { recursive: true });
  run("tar", ["--no-same-owner", "-xzf", archivePath, "-C", targetDirectory]);
  await chmod(join(targetDirectory, "traefik"), 0o755);
  return true;
}

