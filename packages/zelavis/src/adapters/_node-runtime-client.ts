import { randomUUID } from "node:crypto";
import { Cause, Deferred, Effect, Fiber } from "effect";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import type { ZelavisAgentProcess } from "../core/agent/process-command.js";
import { integration, IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";

/** Control replies stay on the already authorized Agent process channel. */
export function createNodeRuntimeClient(process: ZelavisAgentProcess, timeoutMs: number) {
  const replies = new Map<string, { reply: Deferred.Deferred<Readonly<Record<string, unknown>>, TaggedFailure>;
    commit?: (selected: RuntimeRelease, generation: number) => Effect.Effect<void, TaggedFailure>; acknowledgements: Set<string> }>();
  const acknowledgements = new Set<Fiber.Fiber<void, never>>();
  let exited = false;
  return {
    accept: (line: string) => {
      let value: Record<string, unknown>;
      try { value = JSON.parse(line); } catch { return false; }
      if (value?.protocol !== NODE_RUNTIME_PROTOCOL || typeof value.id !== "string") return false;
      const reply = replies.get(value.id);
      if (reply && value.type === "commit") {
        if (typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.nonce) || reply.acknowledgements.has(value.nonce)) return true;
        if (reply.acknowledgements.size >= 2) {
          Deferred.doneUnsafe(reply.reply, Effect.fail(new IntegrationFailure(new Error("Runtime host exceeded this update's commit bound."))));
          return true;
        }
        reply.acknowledgements.add(value.nonce);
        const fiber = Effect.runFork(Effect.uninterruptible(Effect.gen(function* () {
          const outcome = yield* Effect.exit(reply.commit
            ? reply.commit(value.release as RuntimeRelease, Number(value.generation))
            : Effect.fail(new IntegrationFailure(new Error("No Project lock commit was authorized for this request."))));
          yield* integration(() => process.write?.(`${JSON.stringify({ id: value.id, action: "commit-ack", nonce: value.nonce,
            ok: outcome._tag === "Success", ...(outcome._tag === "Failure" ? { error: String(Cause.squash(outcome.cause)) } : {}) })}\n`));
        })).pipe(Effect.ignore));
        acknowledgements.add(fiber); fiber.addObserver(() => { acknowledgements.delete(fiber); });
        return true;
      }
      if (reply) Deferred.doneUnsafe(reply.reply, value.type === "failed"
        ? Effect.fail(new IntegrationFailure(new Error(String(value.error))))
        : Effect.succeed(value));
      return true;
    },
    exited: () => {
      exited = true;
      for (const reply of replies.values()) Deferred.doneUnsafe(reply.reply, Effect.fail(new IntegrationFailure(new Error("Runtime host exited before acknowledging its command."))));
    },
    request: Effect.fn("RuntimeClient.request")(function* (input: Readonly<Record<string, unknown>>, options?: {
      readonly timeoutMs?: number;
      readonly commit?: (selected: RuntimeRelease, generation: number) => Effect.Effect<void, TaggedFailure>;
    }) {
      if (exited || !process.running) return yield* new IntegrationFailure(new Error("Runtime host is not running."));
      if (replies.size >= 32) return yield* new IntegrationFailure(new Error("Runtime host command queue is full."));
      const id = randomUUID(), reply = Deferred.makeUnsafe<Readonly<Record<string, unknown>>, TaggedFailure>();
      replies.set(id, { reply, commit: options?.commit, acknowledgements: new Set() });
      return yield* Effect.gen(function* () {
        const written = yield* integration(() => process.write?.(`${JSON.stringify({ ...input, id })}\n`));
        if (!written) return yield* new IntegrationFailure(new Error("Runtime host has no Agent command pipe."));
        return yield* Deferred.await(reply).pipe(Effect.timeoutOrElse({ duration: options?.timeoutMs ?? timeoutMs,
          orElse: () => Effect.fail(new IntegrationFailure(new Error("Runtime host command was not acknowledged before its deadline."))),
        }));
      }).pipe(Effect.ensuring(Effect.sync(() => { replies.delete(id); })));
    }),
  };
}
