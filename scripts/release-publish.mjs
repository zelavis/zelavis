import { spawnSync } from "node:child_process";
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
    "utf8",
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
    process.exit(result.status ?? 1);
  }
}

try {
  run("pnpm", ["release:check"]);

  const publishArgs = ["changeset", "publish"];

  if (preState) {
    if (tag === "latest") {
      console.error(
        `Changesets prerelease mode is active with tag "${preState.tag}". Exit prerelease mode before publishing to latest.`,
      );
      process.exit(1);
    }

    if (preState.tag !== tag) {
      console.error(
        `Changesets prerelease mode is active with tag "${preState.tag}", which does not match the requested publish tag "${tag}".`,
      );
      process.exit(1);
    }
  } else if (tag !== "latest") {
    publishArgs.push("--tag", tag);
  }

  run("pnpm", publishArgs);
} finally {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
