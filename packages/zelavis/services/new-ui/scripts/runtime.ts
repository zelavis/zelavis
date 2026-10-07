import { Effect } from "effect";
import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";
import { closeNodeServer, createNodeServer, shutdownOnSignals } from "zelavis/runtimes/node";
import { newUiFrontend } from "../src/frontend.ts";
import { zelavisUiFrontend } from "../../zelavis-ui/dist/frontend.js";

const frontend = process.env.ZELAVIS_TEST_FRONTEND === "react" ? zelavisUiFrontend : newUiFrontend;
const platform = new Zelavis({
  frontend: { factory: frontend, devServerUrl: process.env.ZELAVIS_UI_DEV_SERVER },
  adapter: nodeAdapter({ dataDirectory: process.env.ZELAVIS_DATA_DIR, database: {} }),
});
await Effect.runPromise(Effect.gen(function*() {
  const server = yield* Effect.tryPromise({ try: () => createNodeServer(platform), catch: cause => new Error("Could not start the test Platform", { cause }) });
  server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`Test Platform: http://127.0.0.1:${process.env.PORT}/zelavis/`));
  shutdownOnSignals(() => Effect.runPromise(Effect.all([
    Effect.tryPromise({ try: () => closeNodeServer(server), catch: cause => new Error("Could not close test listener", { cause }) }),
    Effect.tryPromise({ try: () => platform.close(), catch: cause => new Error("Could not close test Platform", { cause }) }),
  ], { concurrency: 2 }).pipe(Effect.asVoid)));
}));
