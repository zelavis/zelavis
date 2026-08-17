import { Link, useRouteLoaderData } from "react-router";
import {
  Fingerprint,
  KeyRound,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";

import {
  DataRow,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { RuntimeDashboardAccess } from "#/lib/runtime-api";
import type { clientLoader as rootClientLoader } from "../root";

export const handle = {
  pageLabel: "Access",
  sidebarTrail: ["Access"],
} as const;

const plannedLevels = [
  {
    label: "Owner",
    detail: "Full system grants for the Zelavis instance and every project.",
  },
  {
    label: "Operator",
    detail: "Delegated support and operations grants across selected resources.",
  },
  {
    label: "Reseller",
    detail: "Scoped customer and project grants under a reseller boundary.",
  },
  {
    label: "Customer",
    detail: "Project-scoped grants for the customer's own apps and sites.",
  },
] as const;

function formatScope(scope: NonNullable<RuntimeDashboardAccess["principal"]["grants"]>[number]["scope"]) {
  if (!scope) {
    return "global";
  }

  if (scope.type === "project") {
    return `project:${scope.projectId ?? scope.projectIdParam ?? "*"}`;
  }

  if (scope.type === "service") {
    return `service:${scope.serviceName ?? scope.serviceNameParam ?? "*"}`;
  }

  return "system";
}

export default function AccessRoute() {
  const rootData = useRouteLoaderData<typeof rootClientLoader>("root");
  const access = rootData?.runtime.access;
  const principal = access?.principal;
  const roles = principal?.roles?.join(", ") || "none";
  const grantCount = principal?.grants?.length ?? 0;
  const projectCount = access?.projects?.length ?? 0;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-4">
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Current view"
          value={access?.label ?? "Unknown"}
          detail="The dashboard filters projects, menus, and actions from this principal."
          icon={Fingerprint}
        />
        <StatCard
          label="Roles"
          value={roles}
          detail="Roles describe broad shape; permissions authorize concrete actions."
          icon={UserRound}
        />
        <StatCard
          label="Project grants"
          value={String(projectCount)}
          detail="Customer and reseller dashboards are project-scope first."
          icon={KeyRound}
        />
      </section>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            Demo access modes
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/access?as=owner" />}
            >
              Owner
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/access?as=customer" />}
            >
              Customer
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Principal"
            detail={principal?.id ?? "No principal"}
            meta={<StatusBadge state={principal?.type ?? "anonymous"} />}
          />
          <DataRow
            label="Mode"
            detail={access?.mode ?? "unknown"}
            meta={<StatusBadge state={access?.mode ?? "unknown"} />}
          />
          <DataRow
            label="Permissions"
            detail={principal?.permissions?.join(", ") || "grants only"}
            meta={<StatusBadge state={principal?.permissions?.includes("*") ? "ready" : "planned"} />}
          />
        </CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" />
              Current grants
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {principal?.grants?.length ? (
              principal.grants.map((grant) => (
                <DataRow
                  key={`${grant.permission}:${formatScope(grant.scope)}`}
                  label={grant.permission}
                  detail={formatScope(grant.scope)}
                  meta={<StatusBadge state="active" />}
                />
              ))
            ) : (
              <DataRow
                label="Wildcard owner"
                detail={principal?.permissions?.includes("*") ? "All permissions" : "No grants"}
                meta={<StatusBadge state={principal?.permissions?.includes("*") ? "ready" : "planned"} />}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UsersRound className="size-4" />
              User levels
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {plannedLevels.map((level) => (
              <DataRow
                key={level.label}
                label={level.label}
                detail={level.detail}
                meta={<StatusBadge state={level.label === access?.label ? "active" : "planned"} />}
              />
            ))}
          </CardContent>
        </Card>
      </section>

      <ResourceNotice
        title="First foundation, not final user management"
        description="This screen proves the core principal and grant model in the dashboard. Real user creation, role editing, customer accounts, reseller boundaries, and Hosting Provider billing links should come next as endpoint-backed capabilities."
      />
    </section>
  );
}
