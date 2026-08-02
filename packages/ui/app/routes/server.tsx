import { Archive, Globe2, ReceiptText, Server } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { buttonVariants } from "#/components/ui/button";
import { cn } from "#/lib/utils";

export const handle = {
  pageLabel: "Server",
  sidebarTrail: ["Server"],
} as const;

const serverSections = [
  {
    title: "Domains",
    path: "/server/domains",
    icon: Globe2,
    detail: "Hostnames, TLS, and project bindings.",
  },
  {
    title: "Backups",
    path: "/server/backups",
    icon: Archive,
    detail: "Snapshots, retention, and restore points.",
  },
  {
    title: "Logs",
    path: "/server/logs",
    icon: ReceiptText,
    detail: "Runtime, access, and project logs.",
  },
] as const;

function ServerRoute() {
  const { pathname } = useLocation();

  if (pathname !== "/server") {
    return <Outlet />;
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Server"
        title="Server"
        description="Global host controls for things that sit above individual projects."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Domains"
          value="planned"
          detail="Bind hostnames to projects and system services."
          icon={Globe2}
        />
        <StatCard
          label="Backups"
          value="planned"
          detail="Coordinate database, file, and project snapshots."
          icon={Archive}
        />
        <StatCard
          label="Logs"
          value="planned"
          detail="Read server and project log streams from one place."
          icon={ReceiptText}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4" />
            Host management
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {serverSections.map((section) => (
            <DataRow
              key={section.title}
              label={section.title}
              detail={section.detail}
              meta={
                <Link
                  to={section.path}
                  className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
                >
                  Open
                </Link>
              }
            />
          ))}
        </CardContent>
      </Card>

      <ResourceNotice
        title="Server layer placeholder"
        description="These screens establish the cPanel/Plesk-style host boundary. Live domain, backup, and log providers can plug in here later without becoming project features."
      />
    </section>
  );
}

export default ServerRoute;
