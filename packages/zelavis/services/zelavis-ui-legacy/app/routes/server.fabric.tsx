import { Outlet, useLoaderData, useLocation } from "react-router";

import { FabricWorkspace } from "#/components/fabric/FabricWorkspace";
import type {
  CapacityActionResult,
  CloudData,
  Loaded,
  NodesData,
} from "#/components/fabric/CapacityPanels";
import {
  RuntimeApiError,
  connectCloud,
  createNodeEnrollment,
  disconnectCloud,
  getActiveRuntimeConfig,
  getCloudConnection,
  getCloudScaling,
  getFabricSnapshot,
  getNodePlatform,
  listCloudNodes,
  listNodes,
  releaseCloudNode,
  removeNode,
  requestCloudNode,
  setCloudScaling,
  type FabricSnapshot,
} from "#/lib/runtime-api";
import { newRequestId } from "#/lib/capacity";
import type { Route } from "./+types/server.fabric";

export const handle = {
  pageLabel: "Server",
  sidebarTrail: ["Server"],
} as const;

export interface FabricOutletContext {
  snapshot: FabricSnapshot;
  nodes?: Loaded<NodesData>;
  cloud?: Loaded<CloudData>;
}

function reasonFor(error: unknown): string {
  if (error instanceof RuntimeApiError) {
    if (error.status === 403) return "Your account does not have permission to see this.";
    if (error.status === 503) return "This installation was not started with this capability.";
  }
  return error instanceof Error ? error.message : String(error);
}

async function loaded<T>(read: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }
}

export async function clientLoader({ request, params }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const snapshot = await getFabricSnapshot(runtime);
  const section = params.fabricSection;
  const detail = params.fabricDetail;

  const nodes =
    section === "nodes"
      ? await loaded(async () => {
          const [list, platform] = await Promise.all([listNodes(runtime), getNodePlatform(runtime)]);
          return { nodes: list.nodes, enrollments: list.enrollments, platform };
        })
      : undefined;
  const cloud =
    section === "infrastructure" && detail === "providers"
      ? await loaded(async () => {
          const connection = await getCloudConnection(runtime);
          const machines = connection ? await listCloudNodes(runtime) : [];
          const scaling = connection ? await getCloudScaling(runtime) : null;
          return { connection, machines, scaling };
        })
      : undefined;
  return { snapshot, nodes, cloud };
}

/** Node and cloud changes. Each intent is one call to the same endpoint the CLI and SDK use. */
export async function clientAction({ request }: Route.ClientActionArgs): Promise<CapacityActionResult> {
  const form = await request.formData();
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const intent = text("intent");
  try {
    const runtime = await getActiveRuntimeConfig(request);
    switch (intent) {
      case "enroll":
        return { intent, token: await createNodeEnrollment(runtime, { nodeId: text("nodeId") }) };
      case "remove-node":
        await removeNode(runtime, text("nodeId"));
        return { intent, done: true };
      case "connect-cloud":
        await connectCloud(runtime, {
          provider: text("provider"),
          token: text("token"),
          ...(text("label") ? { label: text("label") } : {}),
        });
        return { intent, done: true };
      case "disconnect-cloud":
        await disconnectCloud(runtime);
        return { intent, done: true };
      case "set-scaling":
        await setCloudScaling(runtime, {
          consent: form.get("consent") === "true",
          maxMachines: Number(text("maxMachines")),
          cooldownMinutes: Number(text("cooldownMinutes")),
        });
        return { intent, done: true };
      case "request-machine":
        await requestCloudNode(runtime, {
          requestId: newRequestId(),
          ...(text("region") ? { region: text("region") } : {}),
        });
        return { intent, done: true };
      case "release-machine":
        await releaseCloudNode(runtime, text("machineId"));
        return { intent, done: true };
      default:
        return { intent, error: "Unknown action." };
    }
  } catch (error) {
    return { intent, error: error instanceof Error ? error.message : String(error) };
  }
}

export default function ServerFabricRoute() {
  const { pathname } = useLocation();
  const { snapshot, nodes, cloud } = useLoaderData<typeof clientLoader>();
  const normalizedPathname = pathname.replace(/\/+$/, "");

  if (!normalizedPathname.endsWith("/server/fabric")) {
    return <Outlet context={{ snapshot, nodes, cloud } satisfies FabricOutletContext} />;
  }

  return <FabricWorkspace snapshot={snapshot} />;
}
