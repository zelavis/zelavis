import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tag = process.argv[2] ?? "latest";

if (!["alpha", "latest"].includes(tag)) {
  console.error(`Unsupported release tag: ${tag}`);
  process.exit(1);
}

const env = { ...process.env };
let tempDir;
const preStatePath = join(process.cwd(), ".changeset", "pre.json");
const isPreMode = existsSync(preStatePath);
const preState = isPreMode
  ? JSON.parse(readFileSync(preStatePath, "utf8"))
  : null;

if (env.NPM_TOKEN) {
  tempDir = mkdtempSync(join(tmpdir(), "zelavis-npm-"));
  const npmrcPath = join(tempDir, ".npmrc");

  writeFileSync(
    npmrcPath,
    [
      "registry=https://registry.npmjs.org/",
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
    "NPM_TOKEN is not set. Falling back to normal manual npm authentication.",
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env,
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

try {
  run("pnpm", ["release:check"]);

  const publishArgs = ["changeset", "publish"];

  if (preState) {
    if (tag === "latest") {
      throw new Error(`Changesets prerelease mode is active with tag "${preState.tag}". Exit prerelease mode before publishing to latest.`);
    }

    if (preState.tag !== tag) {
      throw new Error(`Changesets prerelease mode is active with tag "${preState.tag}", which does not match the requested publish tag "${tag}".`);
    }
  } else if (tag !== "latest") {
    publishArgs.push("--tag", tag);
  }

  // Tags must represent the files being published, including version changes.
  run("git", ["diff", "--quiet"]);
  run("git", ["diff", "--cached", "--quiet"]);
  // Changesets captures its child publisher's output, so pnpm's browser 2FA
  // flow has no interactive terminal. Keep versioning in Changesets, but let
  // pnpm publish directly with inherited stdio for the owner's manual login.
  // Recursive publishing skips versions already present in the registry.
  if (env.NPM_TOKEN) run("pnpm", publishArgs);
  else run("pnpm", ["-r", "publish", "--tag", tag, "--access", "public", "--no-git-checks"]);

  // The release is the npm package: install.sh and `npm create zelavis` fetch
  // exactly that version. Nothing else is built, signed or uploaded.
  const platform = JSON.parse(readFileSync(join(process.cwd(), "packages/zelavis/package.json"), "utf8"));
  const capture = (command, args) => execFileSync(command, args, { encoding: "utf8", env }).trim();
  // npm lists a new version 10-15 minutes after publish, so wait rather than fail.
  const view = () => {
    try {
      return JSON.parse(capture("npm", ["view", `zelavis@${platform.version}`, "name", "version", "dist.integrity", "--json", "--registry=https://registry.npmjs.org"]));
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
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
} finally {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
