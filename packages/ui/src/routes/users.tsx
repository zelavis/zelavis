import { createFileRoute } from "@tanstack/react-router";
import { Fingerprint, KeyRound, ShieldCheck, Users } from "lucide-react";

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatCard,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { getRuntimeConfig, listAuthProviders } from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export const Route = createFileRoute("/users")({ component: UsersRoute });

function UsersRoute() {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const providers = useRuntimeResource(
    async () => (runtime.data ? listAuthProviders(runtime.data) : []),
    [runtime.data],
  );
  const providerNames = providers.data ?? [];

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Users"
        title="Users & accounts"
        description="Accounts already live in the auth core. Dedicated dashboard user-management tools are still in progress, so this page summarizes the current identity model and registered sign-in methods."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Accounts"
          value="service-backed"
          detail="managed through AccountService in the auth core"
          icon={Users}
        />
        <StatCard
          label="Sign-in methods"
          value={`${providerNames.length} registered`}
          detail={
            providerNames.length > 0
              ? providerNames.join(", ")
              : "no auth providers registered yet"
          }
          icon={Fingerprint}
        />
        <StatCard
          label="Sessions"
          value="credential-ready"
          detail="sessions and credentials attach to accounts"
          icon={KeyRound}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Current identity model</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Accounts"
            detail="Canonical user records with email and/or username identifiers."
          />
          <DataRow
            label="Credentials"
            detail="Provider-linked identifiers and secrets mapped back to an account."
          />
          <DataRow
            label="Sessions"
            detail="Runtime-issued sessions that represent signed-in users after authentication."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" />
            Registered auth methods
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {providerNames.map((provider) => (
            <DataRow
              key={provider}
              label={provider}
              detail={`${runtime.data?.api.basePath ?? "/api/v1"}/auth/authenticate/${provider}`}
            />
          ))}
          {providerNames.length === 0 ? (
            <div className="p-4">
              <ResourceNotice
                title={
                  providers.loading
                    ? "Loading auth methods"
                    : "No auth methods registered"
                }
                description={
                  providers.error
                    ? "The auth endpoint is not reachable from this dashboard session."
                    : "Install an auth plugin to expose credential-based sign-in for user accounts."
                }
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
