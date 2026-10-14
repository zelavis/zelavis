import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two phases, in this order when an official service changed:
//   release-publish.mjs <tag> --services   publish the changed zelavis-services packages
//   (pnpm allowlist update, commit)         record their npm digests in the shipped allow-list
//   release-publish.mjs <tag>               publish the Platform, which ships that list
const tag = process.argv[2] ?? "latest";
const servicesPhase = process.argv.slice(3).includes("--services");

if (!["alpha", "latest"].includes(tag)) {
  console.error(`Unsupported release tag: ${tag}`);
  process.exit(1);
}

const REGISTRY = "https://registry.npmjs.org";
const env = { ...process.env };
const tempDir = mkdtempSync(join(tmpdir(), "zelavis-release-"));
const preStatePath = join(process.cwd(), ".changeset", "pre.json");
const preState = existsSync(preStatePath)
  ? JSON.parse(readFileSync(preStatePath, "utf8"))
  : null;

if (env.NPM_TOKEN) {
  const npmrcPath = join(tempDir, ".npmrc");

  writeFileSync(
    npmrcPath,
    [
      `registry=${REGISTRY}/`,
      `//registry.npmjs.org/:_authToken=${env.NPM_TOKEN}`,
      "always-auth=true",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  env.NPM_CONFIG_USERCONFIG = npmrcPath;
  env.NODE_AUTH_TOKEN = env.NPM_TOKEN;

  console.log("Using NPM_TOKEN for non-interactive npm publishing.");
} else {
  console.log(
    "NPM_TOKEN is not set. npm will ask for the owner's login and 2FA in the browser.",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const error = new Error(`${command} exited with status ${result.status ?? 1}.`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

const capture = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], ...options }).trim();

/** Whether npm already lists this exact version; a release never republishes one. */
function listedOnNpm(name, version) {
  try {
    return capture("npm", ["view", `${name}@${version}`, "version", `--registry=${REGISTRY}`]) === version;
  } catch {
    return false;
  }
}

// Compared as real paths: a workspace listed through a symlink (macOS /var, for one) is still the same tree.
const SERVICES_ROOT = join(realpathSync(process.cwd()), "zelavis-services");
const isService = (entry) => {
  const path = realpathSync(entry.path);
  return path === SERVICES_ROOT || path.startsWith(`${SERVICES_ROOT}/`);
};

/** The workspace's public packages, read from pnpm so a new package is covered without being named here. */
function publicPackages() {
  const listed = JSON.parse(capture("pnpm", ["ls", "-r", "--json", "--depth", "-1"]));
  return listed
    .filter((entry) => !entry.private && entry.name && entry.version)
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      path: entry.path,
      manifest: JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8")),
    }));
}

/** Packages before the packages that depend on them, so `zelavis` is on npm before `@zelavis/*` names it. */
function inDependencyOrder(packages) {
  const names = new Set(packages.map((entry) => entry.name));
  const dependsOn = (entry) => Object.keys({
    ...entry.manifest.dependencies,
    ...entry.manifest.peerDependencies,
    ...entry.manifest.optionalDependencies,
  }).filter((name) => names.has(name) && name !== entry.name);
  const ordered = [];
  const placed = new Set();
  while (ordered.length < packages.length) {
    const ready = packages
      .filter((entry) => !placed.has(entry.name) && dependsOn(entry).every((name) => placed.has(name)))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (ready.length === 0) throw new Error("The packages to publish depend on each other in a cycle.");
    for (const entry of ready) {
      ordered.push(entry);
      placed.add(entry.name);
    }
  }
  return ordered;
}

/**
 * pnpm packs, because it rewrites `workspace:` ranges to the exact versions being released; npm
 * publishes, because it runs npm's own browser login and 2FA, which pnpm no longer starts.
 */
function pack(entry, index) {
  const destination = join(tempDir, String(index));
  mkdirSync(destination);
  capture("pnpm", ["pack", "--pack-destination", destination], { cwd: entry.path });
  const tarballs = readdirSync(destination).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`pnpm pack produced ${tarballs.length} tarballs for ${entry.name}.`);
  const tarball = join(destination, tarballs[0]);
  const packed = JSON.parse(capture("tar", ["-xOzf", tarball, "package/package.json"]));
  if (packed.name !== entry.name || packed.version !== entry.version) {
    throw new Error(`The packed ${entry.name}@${entry.version} names itself ${packed.name}@${packed.version}.`);
  }
  const unresolved = Object.entries({ ...packed.dependencies, ...packed.peerDependencies, ...packed.optionalDependencies })
    .filter(([, range]) => String(range).startsWith("workspace:"));
  if (unresolved.length > 0) {
    throw new Error(`The packed ${entry.name} still names workspace ranges: ${unresolved.map(([name]) => name).join(", ")}.`);
  }
  return tarball;
}

try {
  // A commit `pnpm release:check` already qualified is not checked again: it is the same commit, and
  // the clean-tree check below holds it to that. Anything else is checked here first.
  const head = capture("git", ["rev-parse", "HEAD"]);
  if (!servicesPhase && env.ZELAVIS_RELEASE_QUALIFIED === head) {
    console.log(`Using the qualification of ${head} by \`pnpm release:check\`.`);
  } else {
    if (!servicesPhase && env.ZELAVIS_RELEASE_QUALIFIED) {
      console.log(`ZELAVIS_RELEASE_QUALIFIED names ${env.ZELAVIS_RELEASE_QUALIFIED}, not ${head}; qualifying ${head} now.`);
    }
    // Services are qualified by the workspace checks; the update gate and the allow-list check are about
    // the Platform, and the allow-list cannot list a service before npm has it.
    run("pnpm", servicesPhase ? ["run", "verify"] : ["release:check"]);
  }

  if (preState) {
    if (tag === "latest") {
      throw new Error(`Changesets prerelease mode is active with tag "${preState.tag}". Exit prerelease mode before publishing to latest.`);
    }

    if (preState.tag !== tag) {
      throw new Error(`Changesets prerelease mode is active with tag "${preState.tag}", which does not match the requested publish tag "${tag}".`);
    }
  }

  // What is published must be what is committed, version changes included.
  run("git", ["diff", "--quiet"]);
  run("git", ["diff", "--cached", "--quiet"]);

  const unpublished = publicPackages().filter((entry) => !listedOnNpm(entry.name, entry.version));
  const waitingServices = unpublished.filter(isService);
  if (!servicesPhase && waitingServices.length > 0) {
    throw new Error(`Publish the changed services first, then run \`pnpm allowlist update\` and commit, so the Platform ships their digests: ${waitingServices.map((entry) => `${entry.name}@${entry.version}`).join(", ")}. Run \`pnpm release:publish:services:${tag}\`.`);
  }
  const pending = inDependencyOrder(unpublished.filter((entry) => isService(entry) === servicesPhase));
  if (pending.length === 0) {
    console.log("Every public package is already on npm at its current version; nothing to publish.");
  } else {
    console.log(`Publishing ${pending.map((entry) => `${entry.name}@${entry.version}`).join(", ")} with tag "${tag}".`);
    // Packed first, so a package that cannot be packed stops the release before anything is published.
    const tarballs = pending.map((entry, index) => ({ entry, tarball: pack(entry, index) }));
    for (const { entry, tarball } of tarballs) {
      run("npm", ["publish", tarball, "--tag", tag, "--access", "public", `--registry=${REGISTRY}`]);
      console.log(`Published ${entry.name}@${entry.version}.`);
    }
  }

  if (servicesPhase) {
    if (pending.length > 0) {
      console.log("Next: `pnpm allowlist update`, commit the snapshot, then `pnpm release:publish:" + tag + "` for the Platform.");
    }
  } else {
    // The release is the npm package: install.sh and `npm create zelavis` fetch
    // exactly that version. Nothing else is built, signed or uploaded.
    const platform = JSON.parse(readFileSync(join(process.cwd(), "packages/zelavis/package.json"), "utf8"));
    // npm lists a new version 10-15 minutes after publish, so wait rather than fail.
    const view = () => {
      try {
        return JSON.parse(capture("npm", ["view", `zelavis@${platform.version}`, "name", "version", "dist.integrity", "--json", `--registry=${REGISTRY}`]));
      } catch { return undefined; }
    };
    let published = view();
    for (let attempt = 0; !published && attempt < 60; attempt += 1) {
      if (attempt === 0) console.log(`Published. Waiting for npm to list zelavis@${platform.version} (usually 10-15 minutes)...`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      published = view();
    }
    if (published?.name !== "zelavis" || published.version !== platform.version || !/^sha512-/.test(published["dist.integrity"] ?? "")) {
      throw new Error("The exact Platform package is not listed on npm yet; check again with `npm view zelavis@" + platform.version + "`.");
    }
    console.log(`zelavis@${platform.version} is published; install.sh and npm create zelavis can install it now.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
