import { useOutletContext, useParams } from "react-router";

import { FabricWorkspace } from "#/components/fabric/FabricWorkspace";
import type { FabricOutletContext } from "./server.fabric";

export const handle = {
  pageLabel: "Server",
  sidebarTrail: ["Server"],
} as const;

export default function ServerFabricDetailRoute() {
  const { snapshot, nodes, cloud } = useOutletContext<FabricOutletContext>();
  const { fabricSection, fabricDetail } = useParams();

  return (
    <FabricWorkspace
      snapshot={snapshot}
      nodes={nodes}
      cloud={cloud}
      section={fabricSection}
      detail={fabricDetail}
    />
  );
}
