#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCli, type ZelavisCliServeOptions } from "./cli/index.js";
import { nodeAdapter } from "./adapters/node.js";
import { Zelavis, type ZelavisPlatformFrontendFactory } from "./index.js";
import { closeNodeServer, createNodeServer } from "./runtimes/node.js";

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
  const dataDirectory = resolve(options.dataDirectory ?? ".zelavis");
  const frontend = await resolveBundledFrontend();
  const zv = new Zelavis({
    ...(frontend ? { frontend } : {}),
    adapter: nodeAdapter({
      dataDirectory,
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
  runtime: { serve },
});
