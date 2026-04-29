import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "stable";
const preStatePath = join(process.cwd(), ".changeset", "pre.json");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (mode === "alpha") {
  if (!existsSync(preStatePath)) {
    run("pnpm", ["changeset", "pre", "enter", "alpha"]);
  } else {
    const preState = JSON.parse(readFileSync(preStatePath, "utf8"));

    if (preState.tag !== "alpha") {
      console.error(
        `Changesets prerelease mode is already active with tag "${preState.tag}". Exit it before switching to alpha.`,
      );
      process.exit(1);
    }
  }
} else if (mode !== "stable") {
  console.error(`Unsupported release version mode: ${mode}`);
  process.exit(1);
}

run("pnpm", ["changeset", "version"]);
run("pnpm", ["install", "--no-frozen-lockfile"]);
