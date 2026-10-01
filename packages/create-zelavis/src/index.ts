/**
 * `npm create zelavis`: makes a folder that runs a Zelavis Platform.
 *
 * It writes a handful of files, installs the `zelavis` package, and prints the
 * one thing a first run needs: the token that claims the first owner account. It
 * runs no Zelavis code itself and fetches no template at run time, so what it
 * writes is exactly what this package shipped with.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface CreateOptions {
  /** Where the project goes. Created if missing; must be empty if it exists. */
  readonly directory: string;
  readonly install: boolean;
  readonly git: boolean;
  readonly packageManager: PackageManager;
}

export interface CreatedProject {
  readonly directory: string;
  readonly name: string;
  readonly token: string;
  readonly packageManager: PackageManager;
  readonly installed: boolean;
}

export interface ParsedArguments {
  readonly directory?: string;
  readonly yes: boolean;
  readonly install: boolean;
  readonly git: boolean;
  readonly packageManager?: PackageManager;
  readonly help: boolean;
  readonly version: boolean;
}

const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

export const HELP = `Create a Zelavis Platform in a new folder.

Usage
  npm create zelavis@latest [directory] [options]
  pnpm create zelavis [directory] [options]

Options
  -y, --yes             Use the defaults and ask nothing
      --no-install      Do not install dependencies
      --no-git          Do not run \`git init\`
      --pm <manager>    npm, pnpm, yarn or bun (default: the one that ran this)
  -h, --help            Show this help
  -v, --version         Show the version
`;

export function parseArguments(argv: readonly string[]): ParsedArguments {
  let directory: string | undefined;
  let yes = false;
  let install = true;
  let git = true;
  let packageManager: PackageManager | undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case "-y":
      case "--yes": yes = true; break;
      case "--no-install": install = false; break;
      case "--no-git": git = false; break;
      case "-h":
      case "--help": help = true; break;
      case "-v":
      case "--version": version = true; break;
      case "--pm": {
        const value = argv[index + 1];
        if (!value || !PACKAGE_MANAGERS.includes(value as PackageManager)) {
          throw new Error(`--pm needs one of: ${PACKAGE_MANAGERS.join(", ")}.`);
        }
        packageManager = value as PackageManager;
        index += 1;
        break;
      }
      default:
        if (argument.startsWith("-")) throw new Error(`Unknown option "${argument}". Try --help.`);
        if (directory !== undefined) throw new Error(`Only one directory can be given, found "${directory}" and "${argument}".`);
        directory = argument;
    }
  }
  return { ...(directory === undefined ? {} : { directory }), yes, install, git, ...(packageManager ? { packageManager } : {}), help, version };
}

/** The package manager that ran this command, from the user agent it sets. */
export function packageManagerFromUserAgent(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split(" ")[0]?.split("/")[0];
  return PACKAGE_MANAGERS.find((candidate) => candidate === name) ?? "npm";
}

/** A folder name made into a valid npm package name. */
export function projectNameFor(directory: string): string {
  const cleaned = basename(resolve(directory))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|-+$/g, "");
  return cleaned || "zelavis-platform";
}

interface Versions {
  readonly zelavis: string;
  readonly node: string;
}

function readVersions(): Versions {
  return JSON.parse(readFileSync(new URL("./versions.json", import.meta.url), "utf8")) as Versions;
}

const START =
  "node --env-file=.env node_modules/zelavis/dist/cli.js serve --data-dir ./.zelavis --services-dir ./services";

const SERVICES_README = `# services

The Platform loads services from this folder and installs new ones into it, so
what is here is part of your project.

A service is a folder with a package.json that has a "zelavis" section (its kind,
namespace and menus) and an ES module entry. To add one by hand, drop its folder
in here and restart. To add one from the marketplace, press Install in the
dashboard: it is downloaded, checked against the signed allow-list, put in this
folder and started without a restart.

The dashboard, the Zelavis App recipe, Auth and the Marketplace are default
services. They come with the zelavis package, at the same version as the
Platform, so they are not copied here and an update brings them along. A service
in this folder with the same name takes their place.

A service must be self-contained: the Platform does not install a service's own
dependencies. zelavis and effect come from the Platform.
`;

export function templateFiles(name: string, token: string, versions: Versions): Readonly<Record<string, string>> {
  return {
    "package.json": `${JSON.stringify({
      name,
      private: true,
      type: "module",
      scripts: { dev: START, start: START },
      // The dashboard and the default services ship inside this package.
      dependencies: { zelavis: versions.zelavis },
      engines: { node: versions.node },
    }, null, 2)}\n`,
    // The first-owner token. Kept out of git, and in a file rather than the shell
    // history, so there is nothing to copy around or remember.
    ".env": `# Claims the first owner account in the dashboard. Keep this file private.\nZELAVIS_BOOTSTRAP_TOKEN=${token}\n`,
    ".gitignore": "node_modules\n.env\n# The Platform's data: accounts, Projects, databases.\n.zelavis\n",
    // Yours, and tracked: what you add here is part of the project.
    "services/README.md": SERVICES_README,
    "README.md": `# ${name}

A Zelavis Platform, started from \`npm create zelavis\`.

## Run it

\`\`\`bash
npm run dev
\`\`\`

Open http://127.0.0.1:3000/zelavis and follow the setup. It asks for the one-time
token in \`.env\` (\`ZELAVIS_BOOTSTRAP_TOKEN\`) to create the first owner account, then
the token stops working.

## Where things are

- \`services/\` is where services you add live (see the README in it).
- \`.zelavis/\` holds everything the Platform stores: accounts, Projects and their
  databases. It is in \`.gitignore\`. Back it up like any database.
- \`.env\` holds the first-owner token. Keep it out of git.
- The Platform runs with this folder as its home (\`--data-dir ./.zelavis\`), so
  running it from another folder is a different installation.

## Change the address

\`HOST\` and \`PORT\` are read from the environment:

\`\`\`bash
PORT=8080 npm run dev
\`\`\`

## Update

\`\`\`bash
npm install zelavis@latest
\`\`\`

Documentation: https://zelavis.com/docs
`,
  };
}

function isInsideGitRepository(directory: string): boolean {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: directory, stdio: "ignore" });
  return probe.status === 0;
}

function run(command: string, args: readonly string[], cwd: string): Promise<boolean> {
  return new Promise((resolveRun) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", () => resolveRun(false));
    child.on("exit", (code) => resolveRun(code === 0));
  });
}

export async function createProject(options: CreateOptions): Promise<CreatedProject> {
  const directory = resolve(options.directory);
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`${directory} is not empty. Choose a new folder, or empty this one first.`);
  }
  const name = projectNameFor(directory);
  const token = randomBytes(24).toString("hex");

  await mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries(templateFiles(name, token, readVersions()))) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), content, { mode: file === ".env" ? 0o600 : 0o644 });
  }

  if (options.git && !isInsideGitRepository(directory)) {
    spawnSync("git", ["init", "--quiet"], { cwd: directory, stdio: "ignore" });
  }
  const installed = options.install ? await run(options.packageManager, ["install"], directory) : false;
  return { directory, name, token, packageManager: options.packageManager, installed };
}

export function nextSteps(project: CreatedProject, relativeDirectory: string): string {
  const runner = project.packageManager === "npm" ? "npm run" : project.packageManager;
  return [
    "",
    `Created ${project.name} in ${project.directory}`,
    "",
    "Next:",
    ...(relativeDirectory === "." ? [] : [`  cd ${relativeDirectory}`]),
    ...(project.installed ? [] : [`  ${project.packageManager} install`]),
    `  ${runner} dev`,
    "",
    "Then open http://127.0.0.1:3000/zelavis to create the first owner account.",
    "The one-time token it asks for is in the .env file in that folder.",
    "",
  ].join("\n");
}
