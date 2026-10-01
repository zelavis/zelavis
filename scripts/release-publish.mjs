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

  run("pnpm", publishArgs);

  // Push only the Platform's exact Changesets tag. That starts target-native
  // distribution builds; scoped package tags and branch refs are never pushed.
  const platform = JSON.parse(readFileSync(join(process.cwd(), "packages/zelavis/package.json"), "utf8"));
  const releaseTag = `zelavis@${platform.version}`;
  const capture = (command, args) => execFileSync(command, args, { encoding: "utf8", env }).trim();
  if (capture("git", ["rev-parse", "HEAD"]) !== capture("git", ["rev-parse", "--verify", `refs/tags/${releaseTag}^{commit}`])) {
    throw new Error(`Refusing to push a stale ${releaseTag}; the Platform tag must name this release commit.`);
  }
  const published = JSON.parse(capture("npm", ["view", `zelavis@${platform.version}`, "name", "version", "dist.integrity", "--json", "--registry=https://registry.npmjs.org"]));
  if (published.name !== "zelavis" || published.version !== platform.version || !/^sha512-/.test(published["dist.integrity"] ?? "")) {
    throw new Error("The exact Platform package is not available from npm; distribution was not requested.");
  }
  run("git", ["push", "origin", `refs/tags/${releaseTag}`]);
  console.log(`Distribution requested for ${releaseTag}. Check its workflow before publishing the static delivery roots.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
} finally {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
