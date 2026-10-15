import { Globe2 } from "lucide-react";

import {
  DataRow,
  ResourceNotice,
  StatusBadge,
} from "#/components/DashboardPage";
import {
  DashboardSlot,
  DashboardSlotLayout,
} from "#/components/DashboardSlots";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  parseAsStringLiteral,
  useTypedSearchParams,
} from "#/lib/use-typed-search-params";

export const handle = {
  pageLabel: "Domains",
  sidebarTrail: ["Domains"],
  slots: [
    {
      id: "overview",
      label: "Domain overview",
      description: "Server-wide domain inventory and provider boundary.",
    },
    {
      id: "create",
      label: "Domain workflow",
      description: "Add, buy, or transfer domain workflows.",
    },
    {
      id: "main",
      label: "Domain bindings",
      description: "Current host and project bindings.",
    },
    {
      id: "detail",
      label: "Domain provider boundary",
      description: "DNS, TLS, and verification ownership rules.",
    },
  ],
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
    detail:
      "Search and register a new domain through a future registrar provider adapter.",
  },
  transfer: {
    title: "Transfer Domain",
    detail:
      "Move an existing domain registration into a future Zelavis-managed registrar flow.",
  },
} as const;

export default function ServerDomainsRoute() {
  const [{ domainAction }] = useTypedSearchParams(domainSearchSchema);
  const action = domainAction ? domainActionContent[domainAction] : undefined;

  return (
    <DashboardSlotLayout>
      <DomainOverviewSlot action={action} />
      {action ? <DomainWorkflowSlot action={action} /> : null}
      <DomainBindingsSlot />
      <DomainProviderBoundarySlot />
    </DashboardSlotLayout>
  );
}

function DomainOverviewSlot({
  action,
}: {
  action?: (typeof domainActionContent)[keyof typeof domainActionContent];
}) {
  return (
    <DashboardSlot id="overview" label="Domain overview">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe2 className="size-4" />
            Domain inventory
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label={action?.title ?? "Server-wide domains"}
            detail={
              action?.detail ??
              "Hostnames will bind to projects, apps, and system services from this global layer."
            }
            meta={<StatusBadge state={action ? "draft" : "planned"} />}
          />
        </CardContent>
      </Card>
    </DashboardSlot>
  );
}

function DomainWorkflowSlot({
  action,
}: {
  action: (typeof domainActionContent)[keyof typeof domainActionContent];
}) {
  return (
    <DashboardSlot id="create" label="Domain workflow">
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
    </DashboardSlot>
  );
}

function DomainBindingsSlot() {
  return (
    <DashboardSlot id="main" label="Domain bindings">
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
            detail="Development host reserved for a local project."
            meta={<StatusBadge state="draft" />}
          />
        </CardContent>
      </Card>
    </DashboardSlot>
  );
}

function DomainProviderBoundarySlot() {
  return (
    <DashboardSlot id="detail" label="Domain provider boundary">
      <ResourceNotice
        title="Provider boundary"
        description="DNS, TLS, and verification providers belong here as host-level provider adapters. Projects should consume bindings, not own the provider."
      />
    </DashboardSlot>
  );
}
