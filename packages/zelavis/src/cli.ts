#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCli, type ZelavisCliServeOptions } from "@zelavis/cli";
import { nodeAdapter } from "./adapters/node.js";
import { Zelavis } from "./index.js";
import { closeNodeServer, createNodeServer } from "./runtimes/node.js";

async function readVersion(): Promise<string> {
  const source = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const manifest = JSON.parse(source) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}

async function serve(options: ZelavisCliServeOptions): Promise<void> {
  const dataDirectory = resolve(options.dataDirectory ?? ".zelavis");
  const zv = new Zelavis({
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
