#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCliDataDirectory } from "./cli/data-directory.js";
import { describeInstallation } from "./cli/installation.js";
import { runCli, type ZelavisCliServeOptions } from "./cli/index.js";
import {
  createNodeInstallationUninstaller,
  nodeAdapter,
  type NodeAdapterProjectOptions,
} from "./adapters/node.js";
import { Zelavis, type ZelavisPlatformFrontendFactory } from "./index.js";
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
const BUNDLED_DASHBOARD = "@zelavis/ui/frontend";

async function resolveBundledFrontend(): Promise<
  ZelavisPlatformFrontendFactory | undefined
> {
  try {
    // The specifier is held in a variable so TypeScript does not resolve it.
    // The dashboard is an optional dependency, and a static specifier would
    // make the Platform fail to compile without the very package it was
    // decoupled from — the build-time version of the problem this fixes.
    const loaded = (await import(BUNDLED_DASHBOARD)) as {
      zelavisUiFrontend?: unknown;
    };
    return typeof loaded.zelavisUiFrontend === "function"
      ? (loaded.zelavisUiFrontend as ZelavisPlatformFrontendFactory)
      : undefined;
  } catch {
    return undefined;
  }
}


async function serve(options: ZelavisCliServeOptions): Promise<void> {
  const dataDirectory = resolveCliDataDirectory(options.dataDirectory);
  const frontend = await resolveBundledFrontend();
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
  const server = await createNodeServer(zv);

  await new Promise<void>((resolveListening, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, options.host, () => {
      server.off("error", onError);
      resolveListening();
    });
  });

  process.title = "zelavis";
  console.log(
    `Zelavis ${await readVersion()} listening on http://${options.host}:${options.port}/zelavis`,
  );
  console.log(`Platform data: ${dataDirectory}`);

  shutdownOnSignals(async () => {
    await Promise.all([closeNodeServer(server), zv.close()]);
  });
}

const installationPath = await resolveInstallationPath();

await runCli(process.argv.slice(2), {
  version: await readVersion(),
  // Resolved, not the raw argv path: /usr/local/bin/zelavis is a symlink, and
  // what it points at is exactly the thing worth reporting.
  installationPath,
  runtime: {
    serve,
    createInstallationUninstaller({ dataDirectory }) {
      if (!installationPath) {
        throw new Error("The running Zelavis installation path could not be resolved.");
      }
      const installation = describeInstallation(installationPath);
      return createNodeInstallationUninstaller({
        installation,
        dataDirectory:
          dataDirectory ??
          (installation.kind === "packaged"
            ? undefined
            : resolveCliDataDirectory()),
      });
    },
  },
});
