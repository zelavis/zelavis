import { Globe2 } from "lucide-react";

import { DataRow, PageHeader, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

export const handle = {
  pageLabel: "Domains",
  sidebarTrail: ["Server"],
} as const;

export default function ServerDomainsRoute() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Server"
        title="Domains"
        description="Server-wide domain inventory and future bindings for projects, apps, and system services."
      />

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
        description="DNS, TLS, and verification providers belong here as host-level integrations. Projects should consume bindings, not own the provider."
      />
    </section>
  );
}
