import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";
import type { ZelavisProjectRecord } from "../project.js";

/** Public HTTP ingress state. The Project's runtime URL remains private. */
export interface ZelavisProjectPreview {
  readonly status: "ready" | "stopped" | "unavailable";
  readonly port?: number;
  readonly error?: string;
}

export interface ZelavisEdgePreviewHost {
  open(input: { port: number; fetch: (request: Request) => Promise<Response> }): Promise<{
    readonly port: number;
    close(): Promise<void>;
  }>;
}

export interface ZelavisEdgePreviews {
  configure(fetch: (projectId: string, request: Request) => Promise<Response>): void;
  synchronize(project: Readonly<ZelavisProjectRecord>): Promise<ZelavisProjectPreview | undefined>;
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
  const queues = new Map<string, Promise<unknown>>();
  let forward: ((projectId: string, request: Request) => Promise<Response>) | undefined;
  let closed = false;

  function serial<A>(id: string, effect: () => Promise<A>): Promise<A> {
    const result = (queues.get(id) ?? Promise.resolve()).then(effect, effect);
    const tail = result.then(() => undefined, () => undefined);
    queues.set(id, tail);
    void tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return result;
  }

  async function stop(id: string): Promise<void> {
    const listener = listeners.get(id);
    if (listener) { await listener.close(); listeners.delete(id); }
  }

  return {
    configure(fetch) { forward = fetch; },
    synchronize(project) {
      return serial(project.id, async () => {
        // Owned frontend processes share their parent's ingress rather than
        // publishing another control-plane resource of their own.
        if (closed || project.ownerProjectId || project.deletion || project.runtime.status !== "running") {
          await stop(project.id);
          return undefined;
        }
        if (project.placement) {
          await stop(project.id);
          return { status: "unavailable", error: "Preview ingress is not available for a Project placed on another Node." };
        }
        const current = listeners.get(project.id);
        if (current) return { status: "ready", port: current.port };
        let listener: Awaited<ReturnType<ZelavisEdgePreviewHost["open"]>> | undefined;
        try {
          const intent = await options.store.get(NAMESPACE, project.id);
          const value = intent?.value as { projectId?: unknown; port?: unknown } | undefined;
          if (intent && (value?.projectId !== project.id || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535)) {
            throw new Error("Invalid stored preview listener intent.");
          }
          listener = await options.host.open({
            port: value ? Number(value.port) : 0,
            fetch: (request) => forward
              ? forward(project.id, request)
              : Promise.resolve(new Response("Preview is starting.", { status: 503 })),
          });
          if (!Number.isInteger(listener.port) || listener.port < 1024 || listener.port > 65535 || (value && listener.port !== value.port)) {
            throw new Error("The host returned a different or invalid preview port.");
          }
          if (!intent) {
            const saved = await options.store.setIfAbsent(NAMESPACE, project.id, {
              projectId: project.id, port: listener.port, protocol: "http",
            } satisfies ZelavisSystemStoreValue);
            if (!saved.created) throw new Error("Preview listener intent changed concurrently.");
          }
          listeners.set(project.id, listener);
          return { status: "ready", port: listener.port };
        } catch {
          await listener?.close().catch(() => undefined);
          return { status: "unavailable", error: "The preview port could not be opened. The saved port may be in use by another application." };
        }
      });
    },
    remove(id) {
      return serial(id, async () => { await stop(id); await options.store.delete(NAMESPACE, id); });
    },
    async close() {
      closed = true;
      await Promise.all([...queues.values()]);
      for (const id of [...listeners.keys()]) await stop(id);
    },
  };
}
