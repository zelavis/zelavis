import { KeyRound, Server, ShieldCheck, SquareStack } from "lucide-react";

import {
  DataRow,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

export const handle = {
  pageLabel: "Permissions",
  sidebarTrail: ["Access"],
} as const;

const permissionGroups = [
  {
    label: "System",
    permission: "server.manage",
    detail: "Server, domains, resources, security, backups, and logs.",
    icon: Server,
  },
  {
    label: "Projects",
    permission: "projects.list",
    detail: "List projects visible to the current principal.",
    icon: SquareStack,
  },
  {
    label: "Project content",
    permission: "project.content.read",
    detail: "Read project content surfaces for a scoped project.",
    icon: KeyRound,
  },
  {
    label: "Project website",
    permission: "project.website.manage",
    detail: "Manage the website surface for a scoped project.",
    icon: ShieldCheck,
  },
] as const;

export default function AccessPermissionsRoute() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-4">
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Scopes"
          value="system / project / service"
          detail="Permissions become useful only when paired with a scope."
          icon={ShieldCheck}
        />
        <StatCard
          label="Authority"
          value="endpoint"
          detail="Dashboard filtering is presentation; endpoints enforce access."
          icon={KeyRound}
        />
        <StatCard
          label="Plugin rule"
          value="shared"
          detail="Hosting Provider and other modules use the same permission model."
          icon={SquareStack}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            Initial permission vocabulary
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {permissionGroups.map((group) => (
            <DataRow
              key={group.permission}
              label={group.permission}
              detail={group.detail}
              meta={<StatusBadge state={group.label.toLowerCase()} />}
            />
          ))}
        </CardContent>
      </Card>

      <ResourceNotice
        title="Permission names are still early"
        description="The important part is the core shape: explicit permissions, system/project/service scopes, and endpoint enforcement before dashboard controls."
      />
    </section>
  );
}
