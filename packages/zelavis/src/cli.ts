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
import { Effect, Exit, Option, Scope } from "effect";
import { evaluate, integration, IntegrationFailure, present } from "./core/runtime/effect-boundary.js";
import { createNodePlatformHost } from "./adapters/_node-platform-host.js";
import { createNodeRuntimeCatalog } from "./adapters/_node-runtime-catalog.js";
import { isUnknown, objectFields, optional, parseJson } from "./core/json-validation.js";
import { ZELAVIS_VERSION } from "./version.js";

/** Real path of this CLI, symlinks resolved; undefined if it cannot be read. */
const resolveInstallationPath: Effect.Effect<string | undefined> = integration(() => realpath(fileURLToPath(import.meta.url))).pipe(
  Effect.option,
  Effect.map(Option.getOrUndefined),
);

const readVersion = integration(() => readFile(new URL("../package.json", import.meta.url), "utf8")).pipe(
  Effect.flatMap((source) => evaluate(() => {
    const manifest = parseJson(source, objectFields<{ version?: unknown }>({ version: optional(isUnknown) }));
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  })),
);

/**
 * Loads the dashboard if this installation still has it.
 *
 * The Platform depends on no frontend, so the binary is where the product
 * decision lives: ship with a dashboard, and keep working without one. Removing
 * `@zelavis/ui` leaves an installation whose API is unchanged and whose root
 * path says no frontend is installed, which is the whole point of the split.
 */

const serveFor = (installationPath: string | undefined) => (options: ZelavisCliServeOptions): Promise<void> => {
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
        ...(options.enrollment ? { enrollment: options.enrollment } : {}),
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
    console.log(`Zelavis ${yield* readVersion} listening on http://${options.host}:${options.port}/zelavis`);
    console.log(`Platform data: ${dataDirectory}`);
    return yield* host.failure;
  }), scope));
};

const main = Effect.gen(function* () {
  const installationPath = yield* resolveInstallationPath;
  const version = yield* readVersion;
  // runCli reports its own failures and sets the exit code.
  yield* integration(() => runCli(process.argv.slice(2), {
    version,
    // Resolved, not the raw argv path: /usr/local/bin/zelavis is a symlink, and
    // what it points at is exactly the thing worth reporting.
    installationPath,
    runtime: {
      serve: serveFor(installationPath),
      install: runReleaseInstall,
      doctor: (args) => present(Effect.gen(function* () {
        if (!installationPath) return yield* new IntegrationFailure(new Error("The running CLI path could not be resolved."));
        yield* integration(() => runInstallationDoctor(args, installationPath));
      })),
      createInstallationUninstaller({ dataDirectory, instance }) {
        if (!installationPath) {
          throw new Error("The running Zelavis installation path could not be resolved.");
        }
        const installation = describeInstallation(installationPath);
        return createNodeInstallationUninstaller({
          installation,
          instance,
          dataDirectory: dataDirectory ?? (installation.kind === "packaged" ? undefined : resolveCliDataDirectory()),
        });
      },
    },
  }));
});

Effect.runFork(main.pipe(Effect.match({
  onSuccess: () => undefined,
  onFailure: (error) => { console.error(error.message); process.exitCode = 1; },
})));
