import { Outlet, useOutletContext, useParams } from "react-router";

import { FabricWorkspace } from "#/components/fabric/FabricWorkspace";
import type { FabricOutletContext } from "./server.fabric";

export const handle = {
  pageLabel: "Fabric",
  sidebarTrail: ["Fabric"],
} as const;

export default function ServerFabricSectionRoute() {
  const { snapshot } = useOutletContext<FabricOutletContext>();
  const { fabricSection, fabricDetail } = useParams();

  if (fabricDetail) {
    return <Outlet context={{ snapshot } satisfies FabricOutletContext} />;
  }

  return <FabricWorkspace snapshot={snapshot} section={fabricSection} />;
}
