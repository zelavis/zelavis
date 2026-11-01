import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// One run publishes every public package npm lacks, services and Platform together. The Platform
// ships the marketplace allow-list, and `pnpm allowlist update` lists a service version npm does not
// have yet with the digest of its local pack (packing is deterministic, and npm's digest is the digest
// of the uploaded tarball). So each service tarball is checked against the listed digest before
// anything is published: what npm then serves is exactly what the shipped list vouches for.
const tag = process.argv[2] ?? "latest";
if (process.argv.length > 3) {
  console.error(`Unexpected argument "${process.argv[3]}". Usage: release-publish.mjs <alpha|latest>`);
  process.exit(1);
}

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

const SNAPSHOT = join(process.cwd(), "packages/zelavis/services/zelavis-marketplace/allowlist.snapshot.json");

/** The digest the shipped allow-list names for one service version, if it names one. */
function listedIntegrity(name, version) {
  if (!existsSync(SNAPSHOT)) return undefined;
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  return snapshot.services?.find((service) => service.name === name)?.versions?.find((entry) => entry.version === version)?.integrity;
}

const integrityOf = (tarball) => `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;

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
  if (env.ZELAVIS_RELEASE_QUALIFIED === head) {
    console.log(`Using the qualification of ${head} by \`pnpm release:check\`.`);
  } else {
    if (env.ZELAVIS_RELEASE_QUALIFIED) {
      console.log(`ZELAVIS_RELEASE_QUALIFIED names ${env.ZELAVIS_RELEASE_QUALIFIED}, not ${head}; qualifying ${head} now.`);
    }
    run("pnpm", ["release:check"]);
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

  const pending = inDependencyOrder(publicPackages().filter((entry) => !listedOnNpm(entry.name, entry.version)));
  if (pending.length === 0) {
    console.log("Every public package is already on npm at its current version; nothing to publish.");
  } else {
    const services = pending.filter(isService);
    if (services.length > 0 && !pending.some((entry) => entry.name === "zelavis")) {
      throw new Error(`The Platform ships the allow-list that vouches for ${services.map((entry) => `${entry.name}@${entry.version}`).join(", ")}, so it is released with them: version zelavis too.`);
    }
    console.log(`Publishing ${pending.map((entry) => `${entry.name}@${entry.version}`).join(", ")} with tag "${tag}".`);
    // Packed and checked first, so a package that cannot be packed, or a service whose tarball is not the
    // one the allow-list names, stops the release before anything is published.
    const tarballs = pending.map((entry, index) => ({ entry, tarball: pack(entry, index) }));
    for (const { entry, tarball } of tarballs.filter(({ entry }) => isService(entry))) {
      const listed = listedIntegrity(entry.name, entry.version);
      if (!listed) throw new Error(`The allow-list does not name ${entry.name}@${entry.version}. Run \`pnpm allowlist update\`, commit, and qualify again.`);
      const packed = integrityOf(tarball);
      if (packed !== listed) throw new Error(`${entry.name}@${entry.version} packs to ${packed}, but the allow-list names ${listed}. Run \`pnpm allowlist update\` on this commit, commit, and qualify again.`);
    }
    for (const { entry, tarball } of tarballs) {
      run("npm", ["publish", tarball, "--tag", tag, "--access", "public", `--registry=${REGISTRY}`]);
      console.log(`Published ${entry.name}@${entry.version} (${integrityOf(tarball)}).`);
    }
    // The release is the npm package: install.sh and `npm create zelavis` fetch exactly that version.
    // npm lists a new version within minutes; nothing waits for it here.
    console.log(`Done. npm lists new versions within minutes (\`npm view zelavis dist-tags\`); installed servers then offer it in Update now.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
