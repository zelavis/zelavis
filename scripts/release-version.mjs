import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "stable";
const preStatePath = join(process.cwd(), ".changeset", "pre.json");

function getPublishablePackageVersions() {
  const packagesDir = join(process.cwd(), "packages");
  const packageJsonPaths = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directPackageJsonPath = join(packagesDir, entry.name, "package.json");

    if (existsSync(directPackageJsonPath)) {
      packageJsonPaths.push(directPackageJsonPath);
    }

    for (const nestedFolderName of ["adapters", "plugins"]) {
      const nestedRoot = join(packagesDir, entry.name, nestedFolderName);

      if (!existsSync(nestedRoot)) {
        continue;
      }

      for (const nestedEntry of readdirSync(nestedRoot, {
        withFileTypes: true,
      })) {
        if (!nestedEntry.isDirectory()) {
          continue;
        }

        const nestedPackageJsonPath = join(
          nestedRoot,
          nestedEntry.name,
          "package.json",
        );

        if (existsSync(nestedPackageJsonPath)) {
          packageJsonPaths.push(nestedPackageJsonPath);
        }
      }
    }
  }

  return packageJsonPaths
    .map((packageJsonPath) => {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));

      return {
        name: pkg.name,
        version: pkg.version,
        private: pkg.private === true,
      };
    })
    .filter((pkg) => !pkg.private);
}

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
} else {
  const preState = existsSync(preStatePath)
    ? JSON.parse(readFileSync(preStatePath, "utf8"))
    : null;

  if (preState?.mode === "pre") {
    console.error(
      "Changesets prerelease mode is still active. Use `pnpm release:version:alpha` to continue the alpha line, or run `pnpm release:pre:exit` before `pnpm release:version` when you intentionally want a stable release.",
    );
    process.exit(1);
  }

  if (preState) {
    run("pnpm", ["changeset", "version"]);
    run("pnpm", ["install", "--no-frozen-lockfile"]);
    process.exit(0);
  }

  const prereleasePackages = getPublishablePackageVersions().filter((pkg) =>
    /-[0-9A-Za-z-.]+$/.test(pkg.version),
  );

  if (prereleasePackages.length > 0) {
    console.error(
      [
        "Detected publishable packages that are already on prerelease versions while Changesets prerelease mode is not active.",
        "Running the stable version command here would drop the prerelease suffixes.",
        "Use `pnpm release:version:alpha` to continue the alpha line, or run `pnpm release:pre:exit` before `pnpm release:version` when you intentionally want a stable release.",
        `Affected packages: ${prereleasePackages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
      ].join("\n"),
    );
    process.exit(1);
  }
}

run("pnpm", ["changeset", "version"]);
run("pnpm", ["install", "--no-frozen-lockfile"]);
