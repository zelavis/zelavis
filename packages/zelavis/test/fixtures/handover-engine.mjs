import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { IntegrationFailure } from "../../dist/core/runtime/effect-boundary.js";

export const prepare = configuration => Effect.gen(function* () {
  const { directory, version } = configuration;
  appendFileSync(join(directory, "events"), `${version}:prepared\n`);
  if (configuration.prepareFailure) return yield* new IntegrationFailure(new Error("Preparation deliberately refused."));
  return {
    open: generation => Effect.gen(function* () {
      // A real kernel-backed SQLite reservation proves that two processes cannot
      // acquire the same state, including after an activation crash.
      const ownership = new DatabaseSync(join(directory, "ownership.sqlite"));
      ownership.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
      appendFileSync(join(directory, "events"), `${version}:owned:${generation}\n`);
      if (configuration.activationFailure) {
        ownership.close();
        return yield* new IntegrationFailure(new Error("Activation deliberately refused."));
      }
      const data = new DatabaseSync(join(directory, "data.sqlite"));
      data.exec("CREATE TABLE IF NOT EXISTS writes (id INTEGER PRIMARY KEY, value TEXT)");
      return {
        runtime: {
          fetch: request => Effect.runPromise(Effect.gen(function* () {
            const path = new URL(request.url).pathname;
            if (path === "/hold") while (!existsSync(join(directory, "finish"))) yield* Effect.sleep(5);
            if (path === "/write") {
              data.prepare("INSERT INTO writes(value) VALUES (?)").run(version);
              return new Response(String(data.prepare("SELECT COUNT(*) AS n FROM writes").get().n));
            }
            if (path === "/echo") return new Response(yield* Effect.tryPromise(() => request.text()));
            if (path === "/stream") {
              let timer;
              return new Response(new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("first\n"));
                  timer = setInterval(() => {
                    if (existsSync(join(directory, "finish"))) {
                      controller.enqueue(new TextEncoder().encode("last\n")); controller.close(); clearInterval(timer);
                    }
                  }, 5);
                },
                cancel() { clearInterval(timer); },
              }), { headers: { "content-type": "text/event-stream" } });
            }
            return new Response(version);
          })),
        },
        qualify: Effect.void,
        close: () => Effect.sync(() => {
          data.close(); ownership.close();
          appendFileSync(join(directory, "events"), `${version}:released\n`);
        }),
      };
    }),
  };
});
