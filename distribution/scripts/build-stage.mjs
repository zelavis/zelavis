import { installNodeRuntime, installTraefikRuntime } from "./runtime-assets.mjs";
import { stageOperations } from "./stage-operations.mjs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const distributionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(distributionDirectory, "..");
const defaultOutput = join(distributionDirectory, ".tmp", "stage");

function parseArgs(args) {
  const options = {
    output: defaultOutput,
    build: true,
    platform: undefined,
    architecture: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      options.output = resolve(args[index + 1]);
      index += 1;
    } else if (arg === "--skip-build") {
      options.build = false;
    } else if (arg === "--platform") {
      options.platform = args[index + 1];
      index += 1;
    } else if (arg === "--arch" || arg === "--architecture") {
      options.architecture = args[index + 1];
      index += 1;
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

function target(options = {}) {
  const platforms = { linux: "linux", darwin: "darwin" };
  const architectures = { x64: "x64", arm64: "arm64", amd64: "x64" };
  const platform = platforms[options.platform ?? process.platform];
  const architecture = architectures[options.architecture ?? process.arch];
  if (!platform || !architecture) {
    throw new Error(
      `Unsupported release target: ${options.platform ?? process.platform}-${options.architecture ?? process.arch}`,
    );
  }
  return { platform, architecture };
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
  const releaseTarget = target(options);

  await rm(options.output, { recursive: true, force: true });
  await mkdir(options.output, { recursive: true });

  await installNodeRuntime(options.output, releaseConfig.nodeVersion, releaseTarget, join(distributionDirectory, ".cache"));
  if (options.build) {
    run("pnpm", ["--filter", "zelavis", "build"]);
  }
  // Exercise the same package transport as install.sh. pnpm deploy from a
  // checkout can bring optional native development peers into the tree and
  // run their install scripts; those are not part of a server installation.
  const acquisition = join(options.output, ".acquisition");
  const archives = join(acquisition, "archives");
  await mkdir(archives, { recursive: true });
  try {
    run("pnpm", ["--filter", "zelavis", "pack", "--pack-destination", archives]);
    const archive = (await readdir(archives)).filter(name => name.endsWith(".tgz"));
    if (archive.length !== 1) throw new Error("Staging requires exactly one local zelavis npm package.");
    run("npm", ["install", "--prefix", acquisition, "--ignore-scripts", "--omit=dev", "--omit=optional",
      "--no-audit", "--no-fund", "--package-lock=false", "--registry", "https://registry.npmjs.org", join(archives, archive[0])]);
    const packageDirectory = join(acquisition, "node_modules", "zelavis");
    await cp(packageDirectory, join(options.output, "platform"), { recursive: true, verbatimSymlinks: true });
    await rm(packageDirectory, { recursive: true, force: true });
    await cp(join(acquisition, "node_modules"), join(options.output, "platform", "node_modules"), { recursive: true, verbatimSymlinks: true });
    await symlink("..", join(options.output, "platform", "node_modules", "zelavis"));
  } finally {
    await rm(acquisition, { recursive: true, force: true });
  }

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
    join(distributionDirectory, "runtime", "zelavis-agent.service"),
    join(options.output, "share", "zelavis-agent.service"),
  );
  if (releaseTarget.platform === "linux") {
    await copyFile(
      join(distributionDirectory, "runtime", "zelavis-traefik.service"),
      join(options.output, "share", "zelavis-traefik.service"),
    );
    await copyFile(
      join(distributionDirectory, "runtime", "traefik.yml"),
      join(options.output, "share", "traefik.yml"),
    );
  }
  for (const unit of ["zelavis@.service", "zelavis-agent@.service", "zelavis-host-agent.service", "zelavis-host-agent@.service", "zelavis-update.service", "zelavis-update.path", "zelavis.socket"]) {
    await copyFile(join(distributionDirectory, "runtime", unit), join(options.output, "share", unit));
  }
  const { validateHostOperationManifest } = await import(
    pathToFileURL(join(options.output, "platform", "dist", "core", "deployment", "index.js")).href
  );
  const operations = await stageOperations({
    source: join(distributionDirectory, "operations"),
    output: join(options.output, "operations"),
    validate: validateHostOperationManifest,
  });
  if (operations.length > 0) console.log(`Staged host operations: ${operations.join(", ")}`);
  await copyFile(
    join(distributionDirectory, "installers", "uninstall.sh"),
    join(options.output, "share", "uninstall.sh"),
  );

  const traefikBundled = await installTraefikRuntime(
    options.output,
    releaseConfig.traefikVersion,
    releaseTarget,
    join(distributionDirectory, ".cache"),
  );

  const manifest = {
    schemaVersion: releaseConfig.schemaVersion,
    name: "zelavis",
    version: packageManifest.version,
    nodeVersion: releaseConfig.nodeVersion,
    minimumNodeMajor: releaseConfig.minimumNodeMajor,
    edge: {
      defaultAdapter: "traefik",
      traefikVersion: releaseConfig.traefikVersion,
      bundled: traefikBundled,
    },
    platform: releaseTarget.platform,
    architecture: releaseTarget.architecture,
    builtAt: new Date().toISOString(),
  };
  await writeFile(
    join(options.output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await chmod(join(options.output, "bin", "zelavis"), 0o755);
  await chmod(join(options.output, "share", "uninstall.sh"), 0o755);

  const { sealNodeRuntimeArtifact } = await import(pathToFileURL(join(options.output, "platform", "dist", "adapters", "_node-runtime-artifact.js")));
  const { Effect } = await import(pathToFileURL(createRequire(join(options.output, "platform", "package.json")).resolve("effect")).href);
  await Effect.runPromise(sealNodeRuntimeArtifact(options.output));

  console.log(
    `Staged Zelavis ${packageManifest.version} for ${releaseTarget.platform}-${releaseTarget.architecture} with Node ${releaseConfig.nodeVersion}: ${options.output}`,
  );
}

await main();
