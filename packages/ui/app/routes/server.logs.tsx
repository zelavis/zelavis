import { ReceiptText } from "lucide-react";

import { DataRow, PageHeader, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

export const handle = {
  pageLabel: "Logs",
  sidebarTrail: ["Server"],
} as const;

export default function ServerLogsRoute() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Server"
        title="Logs"
        description="Future host-level log streams for runtime events, web access, app processes, and project diagnostics."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ReceiptText className="size-4" />
            Log streams
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Runtime"
            detail="No persistent log sink is configured yet."
            meta={<StatusBadge state="draft" />}
          />
        </CardContent>
      </Card>

      <ResourceNotice
        title="Host boundary"
        description="Logs are global because projects can use different runtimes. Zelavis-native apps, WordPress installs, and static sites can all report into this layer later."
      />
    </section>
  );
}
