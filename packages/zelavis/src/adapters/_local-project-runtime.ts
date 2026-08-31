import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ZelavisProjectDescriptor, ZelavisProjectRuntimeDriver } from "../project.js";
import { ZelavisProjectRuntimeError } from "../project.js";
import {
  createNativeWordPressProjectRuntime,
  type NativeWordPressProjectRuntimeOptions,
} from "./_native-wordpress-project-runtime.js";
import {
  createNodeProcessProjectRuntime,
  type NodeProcessProjectRuntimeOptions,
} from "./_node-project-runtime.js";
import {
  createServerFrontendProjectRuntime,
  type ServerFrontendProjectRuntimeOptions,
} from "./_server-frontend-project-runtime.js";

export interface LocalProjectRuntimeOptions extends NodeProcessProjectRuntimeOptions {
  wordpress?: Omit<NativeWordPressProjectRuntimeOptions, "directory">;
  /**
   * Runs `server` frontends. Omit it and a frontend Project cannot start,
   * rather than silently falling through to the Zelavis runner and failing in
   * a way that looks like a broken frontend.
   */
  serverFrontend?: Omit<ServerFrontendProjectRuntimeOptions, "directory">;
}

const WORDPRESS_APP_NAME = "zelavis/wordpress";
/** Project kind used for a Project-owned server frontend. */
const SERVER_FRONTEND_KIND = "frontend";

/** Routes Project recipes to native drivers while preserving one Platform lifecycle boundary. */
export function createLocalProjectRuntime(options: LocalProjectRuntimeOptions): ZelavisProjectRuntimeDriver {
  const directory = resolve(options.directory);
  const node = createNodeProcessProjectRuntime(options);
  const wordpress = createNativeWordPressProjectRuntime({ directory, ...options.wordpress });
  const serverFrontend = options.serverFrontend
    ? createServerFrontendProjectRuntime({ directory, ...options.serverFrontend })
    : undefined;

  const selectFrontend = (): ZelavisProjectRuntimeDriver => {
    if (!serverFrontend) {
      throw new ZelavisProjectRuntimeError(
        "This host is not configured to run server frontends.",
      );
    }
    return serverFrontend;
  };

  const assertNative = (runtimeKind: unknown) => {
    if (runtimeKind !== undefined && runtimeKind !== "native") {
      throw new ZelavisProjectRuntimeError(
        `The local Project runtime cannot execute the "${String(runtimeKind)}" runtime kind.`,
      );
    }
  };

  const forDescriptor = (project: Readonly<ZelavisProjectDescriptor>) => {
    assertNative(project.runtimeKind);
    if (project.kind === SERVER_FRONTEND_KIND) return selectFrontend();
    return project.app.name === WORDPRESS_APP_NAME ? wordpress : node;
  };
  const forProjectId = async (projectId: string) => {
    const record = JSON.parse(await readFile(join(directory, projectId, "project.json"), "utf8")) as {
      app?: { name?: unknown };
      kind?: unknown;
      runtimeKind?: unknown;
    };
    assertNative(record.runtimeKind);
    if (record.kind === SERVER_FRONTEND_KIND) return selectFrontend();
    return record.app?.name === WORDPRESS_APP_NAME ? wordpress : node;
  };

  return {
    name: "local-project",
    runtimeKinds: Object.freeze(["native"]),
    defaultRuntimeKind: "native",
    startupConcurrency: 1,
    capabilities: (project) => forDescriptor(project).capabilities(project),
    prepare: (project, app) => forDescriptor(project).prepare(project, app),
    start: (project) => forDescriptor(project).start(project),
    stop: async (id) => (await forProjectId(id)).stop(id),
    status: async (id) => {
      try { return await (await forProjectId(id)).status(id); }
      catch { return { status: "stopped" }; }
    },
    logs: async (id) => (await forProjectId(id)).logs(id),
    destroy: async (id) => {
      try { await (await forProjectId(id)).destroy(id); }
      catch { await node.destroy(id); }
    },
    close: async () => {
      await Promise.all([
        node.close(),
        wordpress.close(),
        serverFrontend?.close() ?? Promise.resolve(),
      ]);
    },
    signGatewayAuthority: async (id, claims) => {
      const selected = await forProjectId(id).catch(() => node);
      return selected.signGatewayAuthority?.(id, claims);
    },
  };
}
