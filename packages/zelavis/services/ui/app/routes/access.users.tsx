import { useRouteLoaderData } from "react-router";
import { KeyRound, UserRound, UsersRound } from "lucide-react";

import {
  DataRow,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import type { clientLoader as rootClientLoader } from "../root";

export const handle = {
  pageLabel: "Users",
  sidebarTrail: ["Access"],
} as const;

const plannedUsers = [
  {
    id: "owner_demo",
    label: "Owner demo",
    role: "owner",
    detail: "System-wide principal with wildcard permissions.",
  },
  {
    id: "customer_demo",
    label: "Customer demo",
    role: "customer",
    detail: "Project-scoped principal used by the current customer demo.",
  },
] as const;

export default function AccessUsersRoute() {
  const rootData = useRouteLoaderData<typeof rootClientLoader>("root");
  const principal = rootData?.runtime.access?.principal;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-4">
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Current principal"
          value={principal?.id ?? "none"}
          detail="Real user listing will come from the core access/user endpoints."
          icon={UserRound}
        />
        <StatCard
          label="Role source"
          value="core"
          detail="Hosting Provider customers and owners use the same principal model."
          icon={KeyRound}
        />
        <StatCard
          label="User levels"
          value="4"
          detail="Owner, operator, reseller, and customer are the initial product levels."
          icon={UsersRound}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UsersRound className="size-4" />
            Demo users
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {plannedUsers.map((user) => (
            <DataRow
              key={user.id}
              label={user.label}
              detail={user.detail}
              meta={<StatusBadge state={user.role} />}
            />
          ))}
        </CardContent>
      </Card>

      <ResourceNotice
        title="Next implementation target"
        description="User creation, invites, sessions, API keys, and customer account links should be backed by access endpoints before becoming editable here."
      />
    </section>
  );
}
