import { Navigate } from "react-router";

export const handle = {
  pageLabel: "Builder",
  sidebarTrail: ["Workspace", "Builder"],
} as const;

function BuilderIndex() {
  return <Navigate to="/builder/pages" replace />;
}

export default BuilderIndex;
