import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(distributionDirectory, "..");
const defaultOutput = join(distributionDirectory, ".tmp", "stage");

function parseArgs(args) {
  const options = {
    output: defaultOutput,
    build: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      options.output = resolve(args[index + 1]);
      index += 1;
    } else if (arg === "--skip-build") {
      options.build = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function assertDistributionPath(path) {
  const location = relative(distributionDirectory, path);
  if (!location || location.startsWith(`..${sep}`) || location === "..") {
    throw new Error("The staging directory must live under distribution/.");
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: repositoryDirectory,
    stdio: "inherit",
    ...options,
  });
}

function target() {
  const platforms = { linux: "linux", darwin: "darwin" };
  const architectures = { x64: "x64", arm64: "arm64" };
  const platform = platforms[process.platform];
  const architecture = architectures[process.arch];
  if (!platform || !architecture) {
    throw new Error(`Unsupported release target: ${process.platform}-${process.arch}`);
  }
  return { platform, architecture };
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

async function installNodeRuntime(output, nodeVersion, releaseTarget) {
  const extension = releaseTarget.platform === "linux" ? "tar.xz" : "tar.gz";
  const directoryName = `node-v${nodeVersion}-${releaseTarget.platform}-${releaseTarget.architecture}`;
  const archiveName = `${directoryName}.${extension}`;
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const cacheDirectory = join(distributionDirectory, ".cache", "node", nodeVersion);
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
  const actual = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  if (actual !== expected) {
    throw new Error(`Node checksum mismatch for ${archiveName}.`);
  }

  const runtimeDirectory = join(output, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  run("tar", ["-xf", archivePath, "-C", runtimeDirectory]);
  await rename(join(runtimeDirectory, directoryName), join(runtimeDirectory, "node"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertDistributionPath(options.output);
  const packageManifest = JSON.parse(
    await readFile(join(repositoryDirectory, "packages", "zelavis", "package.json"), "utf8"),
  );
  const releaseConfig = JSON.parse(
    await readFile(join(distributionDirectory, "release.json"), "utf8"),
  );
  const releaseTarget = target();

  await rm(options.output, { recursive: true, force: true });
  await mkdir(options.output, { recursive: true });

  if (options.build) {
    run("pnpm", ["--filter", "zelavis", "build"]);
  }
  run("pnpm", [
    "--filter",
    "zelavis",
    "deploy",
    "--legacy",
    "--prod",
    join(options.output, "platform"),
  ]);

  await mkdir(join(options.output, "bin"), { recursive: true });
  await mkdir(join(options.output, "share"), { recursive: true });
  await copyFile(
    join(distributionDirectory, "runtime", "zelavis"),
    join(options.output, "bin", "zelavis"),
  );
  await copyFile(
    join(distributionDirectory, "runtime", "zelavis.service"),
    join(options.output, "share", "zelavis.service"),
  );
  await copyFile(
    join(distributionDirectory, "installers", "archive-install.sh"),
    join(options.output, "install.sh"),
  );

  await installNodeRuntime(options.output, releaseConfig.nodeVersion, releaseTarget);

  const manifest = {
    schemaVersion: releaseConfig.schemaVersion,
    name: "zelavis",
    version: packageManifest.version,
    nodeVersion: releaseConfig.nodeVersion,
    minimumNodeMajor: releaseConfig.minimumNodeMajor,
    platform: releaseTarget.platform,
    architecture: releaseTarget.architecture,
    builtAt: new Date().toISOString(),
  };
  await writeFile(
    join(options.output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await chmod(join(options.output, "bin", "zelavis"), 0o755);
  await chmod(join(options.output, "install.sh"), 0o755);

  const { createArtifactDigest, createRuntimeArtifactManifestDigest, defineRuntimeArtifact } =
    await import("../../packages/zelavis/dist/core/artifact/index.js");
  async function stagedFiles(directory, prefix = "") {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === "runtime-artifact.json") continue;
      if (entry.isDirectory()) {
        files.push(...await stagedFiles(join(directory, entry.name), path));
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
    return files.sort();
  }
  const files = await stagedFiles(options.output);
  const fileDigests = Object.fromEntries(
    await Promise.all(files.map(async (path) => [
      path,
      await createArtifactDigest(await readFile(join(options.output, path))),
    ])),
  );
  const runtimeArtifactInput = {
    formatVersion: "ZELAVIS_RUNTIME_ARTIFACT_V1",
    name: `zelavis-${releaseTarget.platform}-${releaseTarget.architecture}`,
    version: packageManifest.version,
    runtime: "node",
    entrypoint: "bin/zelavis",
    files,
    fileDigests,
    compatibilityDate: packageManifest.zelavis?.compatibilityDate,
    metadata: {
      platform: releaseTarget.platform,
      architecture: releaseTarget.architecture,
      nodeVersion: releaseConfig.nodeVersion,
    },
  };
  const runtimeArtifact = defineRuntimeArtifact({
    ...runtimeArtifactInput,
    digest: await createRuntimeArtifactManifestDigest(runtimeArtifactInput),
  });
  await writeFile(
    join(options.output, "runtime-artifact.json"),
    `${JSON.stringify(runtimeArtifact, null, 2)}\n`,
  );

  console.log(
    `Staged Zelavis ${packageManifest.version} for ${releaseTarget.platform}-${releaseTarget.architecture} with Node ${releaseConfig.nodeVersion}: ${options.output}`,
  );
}

await main();
