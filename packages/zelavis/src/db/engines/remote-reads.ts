import { Effect, type Scope } from "effect";
import { StoreError } from "../errors.js";
import { decodeReadExit, isPlainJson, type RemoteTenantReads } from "../tenant-reads.js";
import type { RemoteShardAccessProvider, RemoteShardDestination } from "./remote-kv.js";
import { makeShardHttp } from "./remote-shard-http.js";

/** A named Tenant read sent to the Agent holding its shard. */
export const makeRemoteTenantReads = (options: {
  readonly destination: RemoteShardDestination;
  readonly access: RemoteShardAccessProvider;
  readonly shardId: string;
  readonly timeoutMillis?: number;
}): Effect.Effect<RemoteTenantReads, never, Scope.Scope> => Effect.acquireRelease(
  Effect.sync(() => {
    const http = makeShardHttp(options.destination, "/v1/shards/reads", options.timeoutMillis ?? 15_000);
    const run: RemoteTenantReads["run"] = (request) => Effect.gen(function* () {
      const check = isPlainJson(request.input);
      if (!check.ok) return yield* Effect.die(new TypeError(`a Tenant read on another Node takes JSON data; ${check.path} is not`));
      const fail = (cause: string, unavailable = true) => new StoreError({ op: `remote-read.${request.op}`, cause: `${cause} (shard ${options.shardId})`, ...(unavailable ? { shard: options.shardId } : {}) });
      const send = (access: string) => {
        const body = JSON.stringify({ protocol: 1, access, ...request });
        if (Buffer.byteLength(body) > 1024 * 1024) return Effect.fail(fail("the read exceeds 1 MiB", false));
        return http.post(request.op, body).pipe(Effect.mapError((error) => fail(String(error.cause))));
      };
      const current = yield* options.access.current.pipe(Effect.mapError((error) => fail(String(error.cause))), Effect.orDie);
      let answer = yield* send(current).pipe(Effect.orDie);
      if (answer.status === 401 || (answer.status === 409 && answer.body.code === "stale-epoch")) {
        const renewed = yield* options.access.renew.pipe(Effect.mapError((error) => fail(String(error.cause))), Effect.orDie);
        answer = yield* send(renewed).pipe(Effect.orDie);
      }
      if (answer.status !== 200) return yield* Effect.die(fail(typeof answer.body.code === "string" ? answer.body.code : `status ${answer.status}`, answer.status !== 400 && answer.status !== 413));
      return yield* decodeReadExit(request.op, answer.body);
    });
    return { run, close: http.close };
  }),
  (client) => client.close,
);
