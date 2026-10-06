#!/usr/bin/env node
import { takeInheritedSocket } from "./adapters/_systemd-socket.js";
import { readNodeInstallationRuntime } from "./adapters/_installation-runtime.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveCliDataDirectory } from "./cli/data-directory.js";
import { describeInstallation } from "./cli/installation.js";
import { runCli, type ZelavisCliServeOptions } from "./cli/index.js";
import { runInstallationDoctor } from "./cli/install/doctor.js";
import { runReleaseInstall } from "./cli/install/index.js";
import { createNodeInstallationUninstaller } from "./adapters/node.js";
import { shutdownOnSignals } from "./runtimes/node.js";
import { Effect, Exit, Scope } from "effect";
import { evaluate, integration, IntegrationFailure, present } from "./core/runtime/effect-boundary.js";
import { createNodePlatformHost } from "./adapters/_node-platform-host.js";
import { createNodeRuntimeCatalog } from "./adapters/_node-runtime-catalog.js";
import { ZELAVIS_VERSION } from "./version.js";

/** Real path of this CLI, symlinks resolved; undefined if it cannot be read. */
async function resolveInstallationPath(): Promise<string | undefined> {
  try {
    return await realpath(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

async function readVersion(): Promise<string> {
  const source = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const manifest = JSON.parse(source) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}

/**
 * Loads the dashboard if this installation still has it.
 *
 * The Platform depends on no frontend, so the binary is where the product
 * decision lives: ship with a dashboard, and keep working without one. Removing
 * `@zelavis/ui` leaves an installation whose API is unchanged and whose root
 * path says no frontend is installed, which is the whole point of the split.
 */

function serve(options: ZelavisCliServeOptions): Promise<void> {
  const scope = Scope.makeUnsafe();
  return present(Scope.use(Effect.gen(function* () {
    const identity = installationPath ? describeInstallation(installationPath) : undefined;
    const installed = yield* integration(() => readNodeInstallationRuntime(identity?.kind === "packaged" ? identity.root : undefined, options.instance));
    if (options.instance && !installed) return yield* new IntegrationFailure(new Error("--instance requires an installed runtime descriptor."));
    if (installed) {
      const executable = yield* integration(() => realpath(process.execPath));
      const selectedNode = yield* integration(() => realpath(installed.node));
      const selectedCli = yield* integration(() => realpath(installed.cli));
      if (executable !== selectedNode || installationPath !== selectedCli) {
        // The shared command can belong to another instance. Its own private
        // Node and immutable engine remain the selected instance's authority.
        yield* Effect.callback<void, IntegrationFailure>(resume => {
          const child = spawn(installed.node, [installed.cli, ...process.argv.slice(2)], { stdio: "inherit" });
          const term = () => child.kill("SIGTERM"), interrupt = () => child.kill("SIGINT");
          process.on("SIGTERM", term); process.on("SIGINT", interrupt);
          child.once("error", cause => resume(Effect.fail(new IntegrationFailure(cause))));
          child.once("exit", (code, signal) => resume(code === 0 ? Effect.void : Effect.fail(new IntegrationFailure(new Error(`Selected instance exited ${signal ?? code}.`)))));
          return Effect.sync(() => { process.off("SIGTERM", term); process.off("SIGINT", interrupt); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
        });
        return;
      }
      yield* evaluate(() => { if (installed.version !== ZELAVIS_VERSION) throw new Error("Selected CLI and public runtime inventory disagree; repair the installation before starting an engine."); });
      // The unprivileged service reads the public runtime descriptor. The root
      // installer alone owns its private receipt and acknowledges release changes.
      yield* evaluate(() => {
        if (options.dataExplicit && options.dataDirectory && resolveCliDataDirectory(options.dataDirectory) !== installed.dataDirectory) throw new Error("--data-dir disagrees with the selected instance inventory.");
        if (options.portExplicit && options.port !== installed.port) throw new Error("--port disagrees with the selected instance inventory; change it with zelavis install.");
      });
      options = { ...options, dataDirectory: installed.dataDirectory, port: installed.port, host: options.hostExplicit ? options.host : installed.host };
    }
    const dataDirectory = resolveCliDataDirectory(options.dataDirectory);
    let shutdown: ReturnType<typeof shutdownOnSignals> | undefined;
    // Registered before resources, so signal handlers remain installed throughout
    // every close finalizer and repeated termination signals cannot cut it short.
    yield* Effect.addFinalizer(() => Effect.sync(() => shutdown?.dispose()));
    const catalog = installed ? createNodeRuntimeCatalog({ directory: join(installed.prefix, "releases"),
      rootOwned: (yield* integration(() => lstat(join(installed.prefix, "releases")))).uid === 0 }) : undefined;
    const initial = catalog ? yield* catalog.select(ZELAVIS_VERSION) : {
      version: ZELAVIS_VERSION,
      // Checkout execution is current-version-only. Published execution uses the
      // complete installer-owned artifact catalog, including its private Node.
      digest: `sha256:${createHash("sha256").update(yield* integration(() => readFile(new URL("./adapters/_node-platform-engine.js", import.meta.url)))).digest("hex")}`,
    };
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const host = yield* createNodePlatformHost({ dataDirectory, host: options.host, initial, environment,
      authorizedInitial: true,
      configuration: { servicesDirectory: options.servicesDirectory,
        ...(installed ? { installation: { prefix: installed.prefix, instance: installed.instance, edge: installed.edge } } : {}) },
      ...(catalog ? { select: catalog.select, versions: catalog.list() } : {}),
      resolve: (selected, configuration, selectedEnvironment) => catalog ? catalog.resolve(selected, "platform", configuration, selectedEnvironment) : evaluate(() => {
        if (selected.version !== initial.version || selected.digest !== initial.digest) throw new Error("Checkout execution cannot select another installed engine.");
        return { executable: process.execPath, worker: fileURLToPath(new URL("./adapters/_node-runtime-worker.js", import.meta.url)),
          module: fileURLToPath(new URL("./adapters/_node-platform-engine.js", import.meta.url)), cwd: dirname(fileURLToPath(import.meta.url)),
          configuration, environment: selectedEnvironment };
      }),
      output: (stream, line) => { (stream === "stderr" ? process.stderr : process.stdout).write(`${line}\n`); },
    });
    shutdown = shutdownOnSignals(() => present(Scope.close(scope, Exit.void)), { forceAfterMs: 90_000 });
    const inherited = takeInheritedSocket();
    yield* host.listen(inherited ? { fd: inherited.fd } : { port: options.port, host: options.host });
    process.title = "zelavis";
    console.log(`Zelavis ${yield* integration(() => readVersion())} listening on http://${options.host}:${options.port}/zelavis`);
    console.log(`Platform data: ${dataDirectory}`);
    return yield* host.failure;
  }), scope));
}

const installationPath = await resolveInstallationPath();

await runCli(process.argv.slice(2), {
  version: await readVersion(),
  // Resolved, not the raw argv path: /usr/local/bin/zelavis is a symlink, and
  // what it points at is exactly the thing worth reporting.
  installationPath,
  runtime: {
    serve,
    install: runReleaseInstall,
    async doctor(args) {
      if (!installationPath) throw new Error("The running CLI path could not be resolved.");
      await runInstallationDoctor(args, installationPath);
    },
    createInstallationUninstaller({ dataDirectory, instance }) {
      if (!installationPath) {
        throw new Error("The running Zelavis installation path could not be resolved.");
      }
      const installation = describeInstallation(installationPath);
      return createNodeInstallationUninstaller({
        installation,
        instance,
        dataDirectory:
          dataDirectory ??
          (installation.kind === "packaged"
            ? undefined
            : resolveCliDataDirectory()),
      });
    },
  },
});
