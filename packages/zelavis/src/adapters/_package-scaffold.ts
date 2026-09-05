/**
 * Scaffolding a frontend from a `create-*` package.
 *
 * Deliberately not `npx`. `npx` resolves and installs a whole dependency tree
 * from whatever registry npm happens to be configured with, which would route
 * around the installation's source policy entirely and leave that policy
 * decorative. The shape that holds the policy is the one here: acquire the
 * create package through the same verified npm path every other install uses,
 * then run its declared bin in an isolated working directory.
 *
 * What "isolated" means, precisely, because a vague claim here is worse than
 * none. The bin runs as a child `node` under the permission model with reads
 * confined to the create package and the run directory and writes confined to
 * the output directory, which denies it child processes, worker threads,
 * native addons, and `process.binding`. A preload module then removes the
 * outbound network primitives — `net.connect`, `Socket.prototype.connect`,
 * `tls.connect`, `http`/`https` requests, `dgram`, DNS resolution, and
 * `fetch` — from the module layer the child sees. With process spawning
 * already denied, those are the paths that remain, so a create package that
 * reaches for the network fails loudly instead of quietly fetching a template.
 *
 * That is a real boundary against a package doing something unexpected. It is
 * not an OS sandbox, and it is not claimed as one: an operator running
 * genuinely untrusted create packages wants container or VM isolation around
 * the whole Platform, not a flag on one child process.
 *
 * Because the create package runs with no network and no ability to install
 * anything, it has to be self-contained. That is the normal shape for the
 * category — a create package that downloads its own template at runtime is
 * exactly the case this refuses.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { PackageEntry } from "./_package-acquisition.js";
import type { ZelavisPackageManifest } from "../index.js";

/** A scaffold is a project skeleton, not a data set. */
const MAX_OUTPUT_FILES = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The preload that closes the child's network.
 *
 * Written to disk beside the run rather than shipped as a dist asset so it
 * cannot go missing depending on how the package was built, and so the path
 * handed to `--import` is one this code just created.
 *
 * It replaces the outbound entry points only. Replacing `net.Socket` or
 * `net.Server` themselves breaks the child's own stdout, which is a pipe built
 * on a `Socket` — the child would die before running a line of the create
 * package, and the failure would look like the package's fault.
 */
export const SCAFFOLD_NETWORK_PRELOAD = `import { createRequire } from "node:module";

// Loaded through \`createRequire\`, not \`import\`, and that is the whole trick.
// A built-in's ESM namespace snapshots its named exports the first time the
// module is imported as ESM, so patching the exports object afterwards leaves
// \`import { lookup } from "node:dns"\` pointing at the original function. Never
// importing these as ESM here means the child's first import builds its
// namespace from the object this file has already patched.
const require = createRequire(import.meta.url);

const deny = (what) => () => {
  throw new Error(
    \`Network access is disabled while scaffolding (\${what}). A create package must carry everything it writes.\`,
  );
};

const patch = (specifier, keys) => {
  let module;
  try {
    module = require(specifier);
  } catch {
    return undefined;
  }
  for (const key of keys) {
    try {
      module[key] = deny(\`\${specifier}.\${key}\`);
    } catch {
      // A frozen export is already not something the child can call through.
    }
  }
  return module;
};

const net = patch("node:net", ["connect", "createConnection"]);
// The class, not the export: \`http\`, \`https\`, \`tls\`, and undici's \`fetch\` all
// end up here, and replacing \`net.Socket\` itself would break the child's own
// stdout, which is a pipe built on a Socket.
try {
  net.Socket.prototype.connect = deny("net.Socket.connect");
} catch {}
patch("node:tls", ["connect"]);
patch("node:http", ["request", "get"]);
patch("node:https", ["request", "get"]);
patch("node:dgram", ["createSocket"]);
patch("node:dns", [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCname",
  "resolveMx",
  "resolveSrv",
  "resolveTxt",
]);
patch("node:dns/promises", ["lookup", "resolve", "resolve4", "resolve6"]);
globalThis.fetch = deny("fetch");
globalThis.WebSocket = deny("WebSocket");
`;

/**
 * Resolves the executable a create package declares.
 *
 * npm's `bin` is a string for a single command or a map of command names, and
 * both forms appear on real create packages. A package declaring several is
 * ambiguous unless the caller names one, and guessing which command scaffolds
 * a project is the kind of guess that silently produces the wrong thing.
 */
export function resolveCreatePackageBin(
  manifest: ZelavisPackageManifest & { bin?: unknown },
  requested?: string,
): string {
  const bin = manifest.bin;

  if (typeof bin === "string") {
    if (requested && requested !== manifest.name) {
      throw new Error(
        `"${manifest.name}" declares one command, not "${requested}".`,
      );
    }
    return normalizeBinPath(bin, manifest.name);
  }

  if (bin && typeof bin === "object") {
    const commands = Object.entries(bin as Record<string, unknown>).filter(
      ([, value]) => typeof value === "string",
    ) as [string, string][];

    if (commands.length === 0) {
      throw new Error(`"${manifest.name}" declares no runnable command.`);
    }

    if (requested) {
      const match = commands.find(([name]) => name === requested);
      if (!match) {
        throw new Error(
          `"${manifest.name}" declares no command named "${requested}". It declares: ${commands
            .map(([name]) => name)
            .join(", ")}.`,
        );
      }
      return normalizeBinPath(match[1], manifest.name);
    }

    if (commands.length > 1) {
      throw new Error(
        `"${manifest.name}" declares more than one command (${commands
          .map(([name]) => name)
          .join(", ")}); name the one to run.`,
      );
    }

    return normalizeBinPath(commands[0]![1], manifest.name);
  }

  throw new Error(
    `"${manifest.name}" declares no "bin", so there is nothing to run. A create package scaffolds through an executable.`,
  );
}

function normalizeBinPath(value: string, packageName: string): string {
  const normalized = value.replace(/^\.\//, "").replace(/\\/g, "/");

  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(
      `"${packageName}" declares a command outside its own package.`,
    );
  }

  return normalized;
}

export interface RunCreatePackageOptions {
  /** Directory the acquired create package was materialized into. */
  readonly packageDirectory: string;
  /** The bin path, relative to `packageDirectory`. */
  readonly binPath: string;
  /** Directory the scaffold is written into. Must already exist. */
  readonly outputDirectory: string;
  /** Directory holding run-local files, including the network preload. */
  readonly runDirectory: string;
  /** Arguments passed through to the create package. */
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  /** Injected for tests. */
  readonly nodePath?: string;
}

export interface CreatePackageRunResult {
  readonly output: string;
}

/**
 * Runs a create package's bin with the network closed and the filesystem
 * confined.
 *
 * The child is `node` invoked directly rather than through the bin's shebang:
 * a shebang would resolve `node` through `PATH`, and the flags that make this
 * isolated have to be on the process that runs the package, not wished for.
 */
export async function runCreatePackage(
  options: RunCreatePackageOptions,
): Promise<CreatePackageRunResult> {
  // Real paths, because the permission model matches on the resolved path: a
  // service directory under a symlinked root — `/var` on macOS, or an operator
  // who symlinked their data directory — would otherwise deny the child read
  // access to the very package it was told to run.
  const packageDirectory = realpathSync(options.packageDirectory);
  const runDirectory = realpathSync(options.runDirectory);
  const outputDirectory = realpathSync(options.outputDirectory);

  const preloadPath = join(runDirectory, "no-network.mjs");
  await writeFile(preloadPath, SCAFFOLD_NETWORK_PRELOAD, "utf8");

  const binPath = join(packageDirectory, options.binPath);

  const child = spawn(
    options.nodePath ?? process.execPath,
    [
      "--permission",
      `--allow-fs-read=${packageDirectory}`,
      `--allow-fs-read=${runDirectory}`,
      `--allow-fs-write=${outputDirectory}`,
      "--import",
      pathToImportSpecifier(preloadPath),
      binPath,
      ...(options.args ?? []),
    ],
    {
      cwd: outputDirectory,
      // Nothing inherited. npm's own configuration, proxy variables, and
      // registry credentials are exactly what this must not hand to a package
      // acquired from the network, and `HOME` points at the run directory so a
      // package writing a cache file writes it somewhere disposable.
      env: {
        HOME: runDirectory,
        NO_COLOR: "1",
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const chunks: string[] = [];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: string) => chunks.push(chunk));

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

  try {
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", resolveExit);
    });

    const output = chunks.join("").trim();

    if (code !== 0) {
      throw new Error(
        `The create package exited with code ${code ?? "null"}.${
          output ? `\n${output}` : ""
        }`,
      );
    }

    return { output };
  } finally {
    clearTimeout(timer);
  }
}

function pathToImportSpecifier(path: string): string {
  // `--import` takes a URL; a Windows path is not one, and a POSIX path with a
  // space is not one either.
  return new URL(`file://${resolve(path)}`).href;
}

/**
 * Reads what the create package wrote back as package entries.
 *
 * Bounded on both count and total bytes: the output is a project skeleton, and
 * a run that produced something far larger did not do what was asked.
 */
export async function readScaffoldOutput(
  outputDirectory: string,
): Promise<PackageEntry[]> {
  const root = resolve(outputDirectory);
  const entries: PackageEntry[] = [];
  let bytes = 0;

  async function walk(directory: string): Promise<void> {
    const listing = await readdir(directory, { withFileTypes: true });

    for (const item of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, item.name);

      if (item.isDirectory()) {
        await walk(path);
        continue;
      }

      // A symlink is not content, and following one would read outside the
      // directory the child was confined to.
      if (!item.isFile()) continue;

      if (entries.length >= MAX_OUTPUT_FILES) {
        throw new Error(
          `The scaffold produced more than ${MAX_OUTPUT_FILES} files.`,
        );
      }

      const body = await readFile(path);
      bytes += body.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        throw new Error(
          `The scaffold produced more than ${MAX_OUTPUT_BYTES} bytes.`,
        );
      }

      entries.push({
        path: relative(root, path).split(sep).join("/"),
        body: new Uint8Array(body),
      });
    }
  }

  await walk(root);

  if (entries.length === 0) {
    throw new Error("The create package wrote nothing.");
  }

  return entries;
}
