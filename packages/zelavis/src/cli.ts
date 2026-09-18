#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveCliDataDirectory } from "./cli/data-directory.js";
import { runCli, type ZelavisCliServeOptions } from "./cli/index.js";
import { nodeAdapter } from "./adapters/node.js";
import { Zelavis, type ZelavisPlatformFrontendFactory } from "./index.js";
import { closeNodeServer, createNodeServer } from "./runtimes/node.js";

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
  const zv = new Zelavis({
    ...(frontend ? { frontend } : {}),
    adapter: nodeAdapter({
      dataDirectory,
      // Projects run through a separately supervised Agent when the host
      // names its endpoint (the packaged zelavis-agent unit); otherwise they
      // run in this process.
      ...(process.env.ZELAVIS_AGENT_ENDPOINT
        ? { projects: { agentEndpoint: process.env.ZELAVIS_AGENT_ENDPOINT } }
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

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= Promise.all([
      closeNodeServer(server),
      zv.close(),
    ]).then(
      () => undefined,
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await runCli(process.argv.slice(2), {
  version: await readVersion(),
  // Resolved, not the raw argv path: /usr/local/bin/zelavis is a symlink, and
  // what it points at is exactly the thing worth reporting.
  installationPath: await resolveInstallationPath(),
  runtime: { serve },
});
