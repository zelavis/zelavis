#!/usr/bin/env node
import { readNodeInstallationRuntime } from "./adapters/_installation-runtime.js";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { provideHostPackagesTo } from "./adapters/_service-resolution.js";
import { resolveBundledServiceDirectory } from "./adapters/_local-runtime.js";
import { resolveBundledFrontend } from "./cli/bundled-frontend.js";
import { resolveCliDataDirectory } from "./cli/data-directory.js";
import { describeInstallation } from "./cli/installation.js";
import { runCli, type ZelavisCliServeOptions } from "./cli/index.js";
import { runInstallationDoctor } from "./cli/install/doctor.js";
import { runReleaseInstall } from "./cli/install/index.js";
import {
  createNodeInstallationUninstaller,
  nodeAdapter,
  type NodeAdapterProjectOptions,
} from "./adapters/node.js";
import { Zelavis } from "./index.js";
import { closeNodeServer, createNodeServer, shutdownOnSignals } from "./runtimes/node.js";

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

async function serve(options: ZelavisCliServeOptions): Promise<void> {
  const identity = installationPath ? describeInstallation(installationPath) : undefined;
  const installed = await readNodeInstallationRuntime(identity?.kind === "packaged" ? identity.root : undefined, options.instance);
  if (options.instance && !installed) throw new Error("--instance requires an installed runtime descriptor.");
  if (installed && (await realpath(process.execPath) !== await realpath(installed.node) || installationPath !== await realpath(installed.cli))) {
    // The shared management CLI may belong to another instance's release.
    // Re-execute only the selected instance's private Node and immutable CLI.
    await new Promise<void>((resolveChild, reject) => {
      const child = spawn(installed.node, [installed.cli, ...process.argv.slice(2)], { stdio: "inherit" });
      const forward = (signal: NodeJS.Signals) => child.kill(signal);
      const term = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
      process.on("SIGTERM", term); process.on("SIGINT", interrupt);
      child.once("error", reject);
      child.once("exit", (code, signal) => { process.off("SIGTERM", term); process.off("SIGINT", interrupt); if (code === 0) resolveChild(); else reject(new Error(`Selected instance exited ${signal ?? code}.`)); });
    });
    return;
  }
  if (installed) {
    if (options.dataExplicit && options.dataDirectory && resolveCliDataDirectory(options.dataDirectory) !== installed.dataDirectory) throw new Error("--data-dir disagrees with the selected instance inventory.");
    if (options.portExplicit && options.port !== installed.port) throw new Error("--port disagrees with the selected instance inventory; change it with zelavis install.");
    options = { ...options, dataDirectory: installed.dataDirectory, port: installed.port, host: options.hostExplicit ? options.host : installed.host };
  }
  const dataDirectory = resolveCliDataDirectory(options.dataDirectory);
  const frontend = await resolveBundledFrontend({ bundledDirectory: (name) => {
    const directory = resolveBundledServiceDirectory(name);
    if (directory) provideHostPackagesTo(directory);
    return directory;
  } });
  let remoteDispatch: NodeAdapterProjectOptions["remoteDispatch"];
  const dispatchFile = process.env.ZELAVIS_PROJECT_DISPATCH_CONFIG;
  if (dispatchFile) {
    const file = resolve(dispatchFile);
    const input = JSON.parse(await readFile(file, "utf8")) as {
      localNodeId?: unknown;
      nodes?: Record<string, { url?: unknown; agentId?: unknown; caFile?: unknown }>;
    };
    if (typeof input.localNodeId !== "string" || !input.nodes ||
        typeof input.nodes !== "object" || Array.isArray(input.nodes) ||
        Object.values(input.nodes).some((node) => !node ||
          typeof node.url !== "string" || typeof node.agentId !== "string" ||
          typeof node.caFile !== "string")) {
      throw new Error("Project dispatch config needs localNodeId and TLS-pinned Agent nodes.");
    }
    remoteDispatch = {
      localNodeId: input.localNodeId,
      nodes: Object.fromEntries(Object.entries(input.nodes).map(([nodeId, node]) => [
        nodeId, { url: node.url as string, agentId: node.agentId as string,
          caFile: resolve(dirname(file), node.caFile as string) },
      ])),
    };
  }
  const zv = new Zelavis({
    ...(frontend ? { frontend } : {}),
    adapter: nodeAdapter({
      dataDirectory,
      ...(installed ? { installation: { prefix: installed.prefix, instance: installed.instance, edge: installed.edge }, ...(!installed.edge ? { edge: false as const } : {}) } : {}),
      ...(options.servicesDirectory
        ? { services: { directory: resolve(options.servicesDirectory) } }
        : {}),
      // Projects run through a separately supervised Agent when the host
      // names its endpoint (the packaged zelavis-agent unit); otherwise they
      // run in this process.
      ...(process.env.ZELAVIS_AGENT_ENDPOINT || remoteDispatch
        ? { projects: {
            ...(process.env.ZELAVIS_AGENT_ENDPOINT
              ? { agentEndpoint: process.env.ZELAVIS_AGENT_ENDPOINT } : {}),
            ...(remoteDispatch ? { remoteDispatch } : {}),
          } }
        : {}),
    }),
    onError: ({ error }) => ({
      status: 400,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    }),
  });
  let server: Awaited<ReturnType<typeof createNodeServer>>;
  try { server = await createNodeServer(zv); }
  catch (error) { await zv.close(); throw error; }

  // HTTP readiness must never precede graceful signal handling.
  const shutdown = shutdownOnSignals(async () => {
    await Promise.all([closeNodeServer(server), zv.close()]);
  });
  try { await new Promise<void>((resolveListening, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, options.host, () => {
      server.off("error", onError);
      resolveListening();
    });
  }); } catch (error) { shutdown.dispose(); await zv.close(); throw error; }

  process.title = "zelavis";
  console.log(
    `Zelavis ${await readVersion()} listening on http://${options.host}:${options.port}/zelavis`,
  );
  console.log(`Platform data: ${dataDirectory}`);

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
