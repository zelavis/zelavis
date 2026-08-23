import { Cpu, Database, Files, Fingerprint, Server } from "lucide-react";
import { Link, useParams, useRouteLoaderData } from "react-router";

import {
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { buttonVariants } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import type { clientLoader as rootClientLoader } from "../root";

export const handle = {
  pageLabel: "Backend",
  sidebarTrail: ["Backend"],
} as const;

export default function BackendRoute() {
  const { projectId = "default" } = useParams();
  const rootData = useRouteLoaderData<typeof rootClientLoader>("root");
  const services = rootData?.runtime.services ?? [];

  const hasDb = services.some((s) => s.name === "@zelavis/db");
  const hasAuth = services.some((s) => s.name === "@zelavis/auth");
  const hasStorage = services.some((s) => s.name === "@zelavis/storage");
  const hasWorkloads = services.some((s) => s.name === "@zelavis/workloads");

  const backendSections = [
    {
      title: "Database",
      path: `/projects/${projectId}/database`,
      icon: Database,
      detail: "Tables, document collections, queries, and schemas.",
      active: hasDb,
    },
    {
      title: "Auth",
      path: `/projects/${projectId}/auth`,
      icon: Fingerprint,
      detail: "Authentication providers, sessions, and credentials.",
      active: hasAuth,
    },
    {
      title: "Storage",
      path: `/projects/${projectId}/storage`,
      icon: Files,
      detail: "Buckets, media assets, uploads, and file storage.",
      active: hasStorage,
    },
    {
      title: "Workloads",
      path: `/projects/${projectId}/workloads`,
      icon: Cpu,
      detail: "Functions, jobs, schedules, and webhooks.",
      active: hasWorkloads,
    },
  ] as const;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {backendSections.map((section) => {
          const Icon = section.icon;
          return (
            <StatCard
              key={section.title}
              label={section.title}
              value={section.active ? "ready" : "planned"}
              detail={section.detail}
              icon={Icon}
            />
          );
        })}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4" />
            Backend Services
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {backendSections.map((section) => {
            const Icon = section.icon;
            return (
              <div
                key={section.title}
                className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-md border p-2">
                    <Icon className="size-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      <span>{section.title}</span>
                      <StatusBadge
                        state={section.active ? "ready" : "planned"}
                      />
                    </div>
                    <p className="text-muted-foreground text-sm">
                      {section.detail}
                    </p>
                  </div>
                </div>

                <Link
                  to={section.path}
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "self-start sm:self-auto",
                  )}
                >
                  Open {section.title}
                </Link>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <ResourceNotice
        title="Project-scoped Backend Architecture"
        description="Each Zelavis project mounts dedicated, isolated instances of core backend services served by the long-running Zelavis server runtime."
      />
    </section>
  );
}
