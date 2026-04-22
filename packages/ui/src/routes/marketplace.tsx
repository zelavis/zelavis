import { createFileRoute } from "@tanstack/react-router";
import { Boxes, PackageOpen, Store } from "lucide-react";

import {
  DataRow,
  PageHeader,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

const marketplaceRows = [
  {
    label: "Official packages",
    detail: "Core Zelavis packages and installable domain extensions.",
    state: "ready",
  },
  {
    label: "Community plugins",
    detail: "Reserved space for external providers, adapters, and addons.",
    state: "planned",
  },
  {
    label: "Marketplace publishing",
    detail: "Submission, review, and discovery flows are still in progress.",
    state: "planned",
  },
] as const;

export const Route = createFileRoute("/marketplace")({
  component: Marketplace,
});

function Marketplace() {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Community"
        title="Marketplace"
        description="A future home for official packages, community plugins, and installable extensions around Zelavis."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Official"
          value="Core + domain"
          detail="Runtime, auth, database, UI, and optional domain packages."
          icon={Store}
        />
        <StatCard
          label="Community"
          value="Adapters + plugins"
          detail="Third-party auth methods, storage drivers, and provider packages."
          icon={PackageOpen}
        />
        <StatCard
          label="Status"
          value="Early"
          detail="The marketplace surface is planned, but not yet wired to a registry."
          icon={Boxes}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Marketplace roadmap</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {marketplaceRows.map((item) => (
            <DataRow
              key={item.label}
              label={item.label}
              detail={item.detail}
              meta={<StatusBadge state={item.state} />}
            />
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
