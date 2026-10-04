import { Effect, Semaphore } from "effect";
import { effectOperations, evaluate, integration, lifecycleGate, presentOperations } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";
import type { ZelavisProjectRecord } from "../project.js";

/** Public HTTP ingress state. The Project's runtime URL remains private. */
export interface ZelavisProjectPreview {
  readonly status: "ready" | "stopped" | "unavailable";
  readonly port?: number;
  readonly error?: string;
}

export interface ZelavisEdgePreviewHost {
  open(input: { projectId: string; port: number; fetch: (request: Request) => Promise<Response> }): Promise<{
    readonly port: number;
    close(): Promise<void>;
  }>;
}

export interface ZelavisEdgePreviews {
  configure(fetch: (projectId: string, request: Request) => Promise<Response>): void;
  synchronize(project: Readonly<ZelavisProjectRecord>): Promise<ZelavisProjectPreview | undefined>;
  restore(): Promise<void>;
  remove(projectId: string): Promise<void>;
  close(): Promise<void>;
}

const NAMESPACE = "edge.previews";

/** Platform-owned listener intent; OS sockets are implemented by the host. */
export function createZelavisEdgePreviews(options: {
  store: ZelavisSystemStore;
  host: ZelavisEdgePreviewHost;
}): ZelavisEdgePreviews {
  const listeners = new Map<string, Awaited<ReturnType<ZelavisEdgePreviewHost["open"]>>>();
  const serial = lifecycleGate();
  const operations = Semaphore.makeUnsafe(1024);
  const store = effectOperations(options.store), host = effectOperations(options.host);
  let forward: ((projectId: string, request: Request) => Promise<Response>) | undefined;
  let closed = false;
  const stop = Effect.fn("EdgePreviews.stop")(function* (id: string) {
    const listener = listeners.get(id);
    if (listener) { yield* integration(() => listener.close()); listeners.delete(id); }
  });
  const synchronize = (project: Readonly<ZelavisProjectRecord>) => operations.withPermit(serial(project.id, () => Effect.gen(function* () {
    if (closed || project.ownerProjectId || project.deletion || project.runtime.status !== "running") {
      yield* stop(project.id); return undefined;
    }
    if (project.placement) {
      yield* stop(project.id);
      return { status: "unavailable" as const, error: "Preview ingress is not available for a Project placed on another Node." };
    }
    const current = listeners.get(project.id);
    if (current) return { status: "ready" as const, port: current.port };
    let listener: Awaited<ReturnType<ZelavisEdgePreviewHost["open"]>> | undefined;
    return yield* Effect.gen(function* () {
      const intent = yield* store.get(NAMESPACE, project.id);
      const value = intent?.value as { projectId?: unknown; port?: unknown } | undefined;
      yield* evaluate(() => {
        if (intent && (value?.projectId !== project.id || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535)) throw new Error("Invalid stored preview listener intent.");
      });
      listener = yield* host.open({ projectId: project.id, port: value ? Number(value.port) : 0,
        fetch: request => forward ? forward(project.id, request) : Promise.resolve(new Response("Preview is starting.", { status: 503 })),
      });
      yield* evaluate(() => {
        if (!Number.isInteger(listener!.port) || listener!.port < 1024 || listener!.port > 65535 || value && listener!.port !== value.port) throw new Error("The host returned a different or invalid preview port.");
      });
      if (!intent) {
        const saved = yield* store.setIfAbsent(NAMESPACE, project.id, {
          projectId: project.id, port: listener.port, protocol: "http",
        } satisfies ZelavisSystemStoreValue);
        yield* evaluate(() => { if (!saved.created) throw new Error("Preview listener intent changed concurrently."); });
      }
      listeners.set(project.id, listener);
      return { status: "ready" as const, port: listener.port };
    }).pipe(Effect.catch(() => Effect.gen(function* () {
      if (listener) yield* integration(() => listener!.close()).pipe(Effect.ignore);
      return { status: "unavailable" as const, error: "The preview port could not be opened. The saved port may be in use by another application." };
    })));
  })));
  return Object.assign(presentOperations({
    synchronize,
    restore: Effect.fn("EdgePreviews.restore")(function* () {
      const intents = yield* store.list(NAMESPACE);
      // Restore saved listener metadata boundedly, without waiting for fleet startup.
      yield* Effect.forEach(intents, intent => Effect.gen(function* () {
        const record = yield* store.get("projects", intent.key);
        if (!record) return;
        const project = yield* evaluate(() => {
          const candidate = record.value as unknown as ZelavisProjectRecord;
          if (candidate.id !== intent.key || !candidate.runtime) throw new Error("Invalid Project preview owner.");
          return candidate;
        });
        const result = yield* synchronize(project);
        yield* evaluate(() => { if (result?.status === "unavailable") throw new Error(`Project ${project.id}: ${result.error}`); });
      }), { concurrency: 4, discard: true });
    }),
    remove: (id: string) => operations.withPermit(serial(id, () => Effect.gen(function* () {
      yield* stop(id); yield* store.delete(NAMESPACE, id);
    }))),
    close: Effect.fn("EdgePreviews.close")(function* () {
      closed = true;
      yield* operations.withPermits(1024)(Effect.forEach([...listeners.keys()], stop, { concurrency: 4, discard: true }));
    }),
  }), { configure(fetch: (projectId: string, request: Request) => Promise<Response>) { forward = fetch; } });
}
