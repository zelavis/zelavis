#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Seeds the distribution's own services into the product-services folder.
 *
 * Credential providers are no longer handed to composition in code: a provider
 * reaches auth by being installed, and the folder is where an installation's
 * services live. So the binary materializes what it ships into that folder on
 * first boot, the way a CMS lays down its bundled plugins, and from then on the
 * operator owns them — they can be listed, replaced, or deleted, and a deleted
 * one stays deleted rather than reappearing on the next restart.
 *
 * Copied rather than symlinked so an installation keeps working when the
 * `zelavis` package is upgraded or removed underneath it.
 */
const BUNDLED_PRODUCT_SERVICES = ["@zelavis/app-auth-email-password"];

/**
 * Finds the directory a package was installed into.
 *
 * Resolving `<name>/package.json` directly fails for any package whose
 * `exports` does not list it, which is most of them, so the entry point is
 * resolved instead and its directories walked up until the manifest that
 * names this package turns up.
 */
async function resolvePackageRoot(specifier: string): Promise<string> {
  const { readFile: read } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)));

  for (let depth = 0; depth < 10; depth += 1) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await read(manifestPath, "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === specifier) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`could not locate the installed package directory.`);
}

async function seedBundledProductServices(
  dataDirectory: string,
): Promise<void> {
  const { cp, mkdir, readdir, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const folder = join(dataDirectory, "product-services");
  // One marker for the whole folder, not one per package. Re-seeding a service
  // the operator deleted would make deletion impossible.
  const marker = join(folder, ".seeded");
  if (existsSync(marker)) return;

  await mkdir(folder, { recursive: true });
  let seeded = 0;
  for (const specifier of BUNDLED_PRODUCT_SERVICES) {
    try {
      const source = await resolvePackageRoot(specifier);
      const target = join(folder, specifier.replace(/^@/u, "").replace("/", "-"));
      if (existsSync(target)) {
        seeded += 1;
        continue;
      }
      await cp(source, target, {
        recursive: true,
        // Only a node_modules *inside* the package is skipped, which would
        // otherwise drag the whole dependency tree in. Matching the absolute
        // path instead rejected every file of a package that is itself
        // installed under node_modules — which is where packages normally
        // live, so nothing was copied at all.
        filter: (path) =>
          !relative(source, path).split(sep).includes("node_modules"),
      });
      if ((await readdir(target)).length === 0) {
        throw new Error("nothing was copied");
      }
      seeded += 1;
    } catch (error) {
      console.warn(
        `Zelavis could not install bundled service ${specifier}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  // Only claim the folder is seeded once everything actually landed. Writing
  // the marker after a failure would make the failure permanent: the next boot
  // would skip seeding and the service would never appear.
  if (seeded === BUNDLED_PRODUCT_SERVICES.length) {
    await writeFile(marker, new Date().toISOString(), "utf8");
  }
}

async function serve(options: ZelavisCliServeOptions): Promise<void> {
  const dataDirectory = resolve(options.dataDirectory ?? ".zelavis");
  await seedBundledProductServices(dataDirectory);
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
