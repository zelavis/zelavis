import { useParams } from "react-router";
import { Database, Globe2, Settings2 } from "lucide-react";

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

export const handle = {
  pageLabel: "Settings",
  sidebarTrail: ["Settings"],
} as const;

export default function ProjectSettingsRoute() {
  const { projectId = "default" } = useParams();

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Project"
        title="Project Settings"
        description="Project-owned settings for this Zelavis app. Runtime and dashboard-wide preferences live in global settings."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="size-4" />
            Project identity
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Project ID"
            detail={projectId}
            meta={<StatusBadge state="draft" />}
          />
          <DataRow
            label="Project type"
            detail="Zelavis-native app"
            meta={<StatusBadge state="ready" />}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe2 className="size-4" />
            Project bindings
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Primary domain"
            detail="Managed from the global Domains area."
            meta={<StatusBadge state="planned" />}
          />
          <DataRow
            label="Database tenant"
            detail="Project-scoped data is isolated by tenant-aware storage."
            meta={<Database className="size-4 text-muted-foreground" />}
          />
        </CardContent>
      </Card>

      <ResourceNotice
        title="Global settings moved"
        description="Appearance, runtime services, root path, and server-wide preferences are available from the footer dropdown."
      />
    </section>
  );
}
