import { useOutletContext, useParams } from "react-router";

import { FabricWorkspace } from "#/components/fabric/FabricWorkspace";
import type { FabricOutletContext } from "./server.fabric";

export const handle = {
  pageLabel: "Fabric",
  sidebarTrail: ["Fabric"],
} as const;

export default function ServerFabricDetailRoute() {
  const { snapshot } = useOutletContext<FabricOutletContext>();
  const { fabricSection, fabricDetail } = useParams();

  return (
    <FabricWorkspace
      snapshot={snapshot}
      section={fabricSection}
      detail={fabricDetail}
    />
  );
}
