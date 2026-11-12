import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { defineAdapter, Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { closeNodeServer, createNodeServer, shutdownOnSignals } from "zelavis/runtimes/node";
import { zelavisUiFrontend as frontend } from "../src/frontend.ts";

const txtFile = process.env.ZELAVIS_TEST_PROJECT_DOMAIN_TXT;
const node = nodeAdapter({
  dataDirectory: process.env.ZELAVIS_DATA_DIR, database: {},
  ...(txtFile ? { externalProjectDomainTarget: `http://127.0.0.1:${process.env.PORT}` } : {}),
});
const adapter = !txtFile ? node : defineAdapter({
  name: node.name, close: node.close,
  resolve: options => Effect.runPromise(Effect.gen(function* () {
    const resolved = yield* Effect.promise(() => Promise.resolve(node.resolve!(options)));
    const ingress = resolved.resources?.projectDomainIngress;
    if (!ingress) throw new Error("The browser fixture needs the Node Project domain ingress.");
    return { ...resolved, resources: { ...resolved.resources, projectDomainIngress: {
      ...ingress,
      dns: { resolveTxt: (name: string) => Effect.runPromise(Effect.gen(function* () {
        const source = yield* Effect.tryPromise({
          try: () => readFile(txtFile, "utf8"),
          catch: cause => cause as NodeJS.ErrnoException,
        }).pipe(Effect.catch(error => error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error)));
        const [record, value] = source.trimEnd().split("\n");
        return record === name && value ? [[value]] : [];
      })) },
    } } };
  })),
});

const platform = new Zelavis({
  rootPath: process.env.ZELAVIS_TEST_ROOT_PATH,
  frontend: { factory: frontend, devServerUrl: process.env.ZELAVIS_UI_DEV_SERVER },
  adapter,
});
await Effect.runPromise(Effect.gen(function*() {
  const server = yield* Effect.tryPromise({ try: () => createNodeServer(platform), catch: cause => new Error("Could not start the test Platform", { cause }) });
  server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`Test Platform: http://127.0.0.1:${process.env.PORT}/zelavis/`));
  shutdownOnSignals(() => Effect.runPromise(Effect.all([
    Effect.tryPromise({ try: () => closeNodeServer(server), catch: cause => new Error("Could not close test listener", { cause }) }),
    Effect.tryPromise({ try: () => platform.close(), catch: cause => new Error("Could not close test Platform", { cause }) }),
  ], { concurrency: 2 }).pipe(Effect.asVoid)));
}));
