import { Archive } from "lucide-react";

import { DataRow, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

export const handle = {
  pageLabel: "Backups",
  sidebarTrail: ["Server"],
} as const;

export default function ServerBackupsRoute() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Archive className="size-4" />
            Backup policies
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Default retention"
            detail="No automatic backup provider is configured yet."
            meta={<StatusBadge state="draft" />}
          />
        </CardContent>
      </Card>

      <ResourceNotice
        title="Restore first"
        description="This area should model both scheduled backups and restore drills. A backup feature is not real until restore is first-class."
      />
    </section>
  );
}
