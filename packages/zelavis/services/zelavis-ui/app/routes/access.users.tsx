import { useLoaderData } from "react-router";
import { KeyRound, UserRound, UsersRound } from "lucide-react";

import {
  DataRow,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { getRuntimeConfig, listAuthAccounts } from "#/lib/runtime-api";

export const handle = {
  pageLabel: "Users",
  sidebarTrail: ["Access"],
} as const;

export async function clientLoader() {
  const runtime = await getRuntimeConfig();
  return { accounts: await listAuthAccounts(runtime) };
}

export default function AccessUsersRoute() {
  const { accounts } = useLoaderData<typeof clientLoader>();
  const ownerCount = accounts.filter((account) =>
    account.roles?.includes("owner"),
  ).length;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-4">
      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Current principal"
          value={accounts[0]?.id ?? "none"}
          detail="Accounts are loaded from the permission-gated Platform Auth endpoint."
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
          value={String(accounts.length)}
          detail={`${ownerCount} owner account${ownerCount === 1 ? "" : "s"}.`}
          icon={UsersRound}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UsersRound className="size-4" />
            Platform users
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {accounts.map((account) => (
            <DataRow
              key={account.id}
              label={account.displayName ?? account.email ?? account.username ?? account.id}
              detail={account.email ?? account.username ?? account.id}
              meta={<StatusBadge state={account.roles?.[0] ?? (account.verified ? "verified" : "unverified")} />}
            />
          ))}
          {accounts.length === 0 ? (
            <DataRow
              label="No accounts"
              detail="Bootstrap the first Platform owner to create the initial account."
              meta={<StatusBadge state="pending" />}
            />
          ) : null}
        </CardContent>
      </Card>

      <ResourceNotice
        title="Next implementation target"
        description="User creation, invites, session administration, API keys, and customer account links should be backed by access endpoints before becoming editable here."
      />
    </section>
  );
}
