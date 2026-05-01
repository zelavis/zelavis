import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/builder")({ component: BuilderIndex });

function BuilderIndex() {
  return <Navigate to="/builder/pages" replace />;
}
