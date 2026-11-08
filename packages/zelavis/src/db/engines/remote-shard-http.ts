import { Effect } from "effect";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isRecord, parseJson } from "../../core/json-validation.js";
import { StoreError } from "../errors.js";
import type { RemoteShardDestination } from "./remote-kv.js";

const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
const MAX_SOCKETS = 16;

export interface ShardHttpAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** Bounded pinned-CA HTTPS transport shared by the shard protocols. */
export const makeShardHttp = (destination: RemoteShardDestination, path: string, timeout: number) => {
  const url = new URL(path, destination.url);
  const sockets = new HttpsAgent({ keepAlive: true, maxSockets: MAX_SOCKETS, ca: destination.caPem });
  const post = (op: string, bodyText: string): Effect.Effect<ShardHttpAnswer, StoreError> =>
    Effect.callback<ShardHttpAnswer, StoreError>((resume) => {
      const failWith = (error: Error) => {
        const description = error.message !== "" ? error.message : (error as NodeJS.ErrnoException).code ?? error.name;
        resume(Effect.fail(new StoreError({ op: `remote-kv.${op}`, cause: description })));
      };
      const request = httpsRequest({
        hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", agent: sockets, ca: destination.caPem,
        rejectUnauthorized: true, timeout,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(bodyText) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) request.destroy(new Error("Agent answer exceeded the limit."));
          else chunks.push(chunk);
        });
        response.once("error", failWith);
        response.once("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resume(Effect.succeed({ status: response.statusCode ?? 0, body: text === "" ? {} : parseJson(text, isRecord, "remote shard answer") }));
          } catch (error) {
            failWith(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      request.once("timeout", () => request.destroy(new Error("Agent request timed out.")));
      request.once("error", failWith);
      request.end(bodyText);
      return Effect.sync(() => { request.destroy(); });
    });
  return { post, close: Effect.sync(() => { sockets.destroy(); }) };
};
