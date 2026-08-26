import { Outlet, useLoaderData, useLocation } from "react-router";

import { FabricWorkspace } from "#/components/fabric/FabricWorkspace";
import {
  getActiveRuntimeConfig,
  getFabricSnapshot,
  type FabricSnapshot,
} from "#/lib/runtime-api";
import type { Route } from "./+types/server.fabric";

export const handle = {
  pageLabel: "Server",
  sidebarTrail: ["Server"],
} as const;

export interface FabricOutletContext {
  snapshot: FabricSnapshot;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const snapshot = await getFabricSnapshot(runtime);
  return { snapshot };
}

export default function ServerFabricRoute() {
  const { pathname } = useLocation();
  const { snapshot } = useLoaderData<typeof clientLoader>();
  const normalizedPathname = pathname.replace(/\/+$/, "");

  if (!normalizedPathname.endsWith("/server/fabric")) {
    return <Outlet context={{ snapshot } satisfies FabricOutletContext} />;
  }

  return <FabricWorkspace snapshot={snapshot} />;
}
