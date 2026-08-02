import { Archive, Database, Files, Globe2, MonitorCog, Package, ReceiptText } from "lucide-react";
import { useParams } from "react-router";

import { DashboardNotFound } from "#/components/DashboardNotFound";
import { DataRow, PageHeader, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { getManagedProjectKindFromId } from "#/lib/routing";

export const handle = {
  pageLabel: "Project",
} as const;

const managedSections = {
  domains: {
    title: "Domains",
    icon: Globe2,
    detail: "Project hostnames and TLS bindings will be managed here.",
  },
  files: {
    title: "Files",
    icon: Files,
    detail: "A project file manager and deployment file view will live here.",
  },
  database: {
    title: "Database",
    icon: Database,
    detail: "Managed app database access belongs here, separate from Zelavis-native collections.",
  },
  backups: {
    title: "Backups",
    icon: Archive,
    detail: "Project restore points and backup policy overrides will live here.",
  },
  logs: {
    title: "Logs",
    icon: ReceiptText,
    detail: "Application and web server logs for this managed project will live here.",
  },
  updates: {
    title: "Updates",
    icon: Package,
    detail: "Managed app core, theme, plugin, or runtime update controls will live here.",
  },
  admin: {
    title: "App Admin",
    icon: MonitorCog,
    detail: "This opens or proxies the app's own admin area, such as wp-admin for WordPress.",
  },
} as const;

export default function ManagedProjectSectionRoute() {
  const params = useParams();
  const managedKind = getManagedProjectKindFromId(params.projectId);

  if (!managedKind) {
    return <DashboardNotFound />;
  }

  const section =
    managedSections[params.managedSection as keyof typeof managedSections] ??
    managedSections.admin;
  const Icon = section.icon;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Managed Project"
        title={section.title}
        description={section.detail}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon className="size-4" />
            {section.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label={params.projectId ?? "project"}
            detail="Project-specific host controls are scaffolded; provider-backed behavior comes next."
            meta={<StatusBadge state="draft" />}
          />
        </CardContent>
      </Card>

      <ResourceNotice
        title="Managed app boundary"
        description="This project does not expose Zelavis-native sections like Auth, Content, and Plugins. It gets hosting controls similar to managed WordPress or generic app hosting."
      />
    </section>
  );
}
