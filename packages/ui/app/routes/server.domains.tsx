import { Globe2 } from "lucide-react";

import { DataRow, PageHeader, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { parseAsStringLiteral, useTypedSearchParams } from "#/lib/use-typed-search-params";

export const handle = {
  pageLabel: "Domains",
  sidebarTrail: ["Domains"],
} as const;

const domainSearchSchema = {
  domainAction: parseAsStringLiteral(["add", "buy", "transfer"] as const),
} as const;

const domainActionContent = {
  add: {
    title: "Add Domain",
    detail: "Connect an existing domain to Zelavis and verify ownership.",
  },
  buy: {
    title: "Buy Domain",
    detail: "Search and register a new domain through a future registrar provider adapter.",
  },
  transfer: {
    title: "Transfer Domain",
    detail: "Move an existing domain registration into a future Zelavis-managed registrar flow.",
  },
} as const;

export default function ServerDomainsRoute() {
  const [{ domainAction }] = useTypedSearchParams(domainSearchSchema);
  const action = domainAction ? domainActionContent[domainAction] : undefined;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Domains"
        title={action?.title ?? "Domains"}
        description={
          action?.detail ??
          "Server-wide domain inventory and future bindings for projects, apps, and system services."
        }
      />

      {action ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe2 className="size-4" />
              {action.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataRow
              label="Workflow"
              detail="The dashboard route and sidebar state are ready; provider-backed domain actions come next."
              meta={<StatusBadge state="draft" />}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe2 className="size-4" />
            Domain bindings
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="localhost"
            detail="Development host reserved for the default project."
            meta={<StatusBadge state="draft" />}
          />
        </CardContent>
      </Card>

      <ResourceNotice
        title="Provider boundary"
        description="DNS, TLS, and verification providers belong here as host-level provider adapters. Projects should consume bindings, not own the provider."
      />
    </section>
  );
}
