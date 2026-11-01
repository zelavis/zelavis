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
import { DashboardNotFound } from "#/components/DashboardNotFound";
import { getManagedProject } from "#/lib/routing";
import type { clientLoader as rootClientLoader } from "../root";

export const handle = {
  pageLabel: "Backend",
  sidebarTrail: ["Backend"],
} as const;

export default function BackendRoute() {
  const { projectId } = useParams();
  const rootData = useRouteLoaderData<typeof rootClientLoader>("root");
  if (!projectId) return <DashboardNotFound />;
  const project = rootData?.projects.find(value => value.id === projectId);
  const managed = getManagedProject(project);
  const capabilities = rootData?.runtime.capabilities;
  const visible = (name: string) => capabilities?.[name]?.available === true &&
    (!managed || capabilities[name].used === true);
  const hasDb = visible("database");
  const hasAuth = visible("identity");
  const hasStorage = visible("storage");
  const hasWorkloads = visible("workloads");

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
  ].filter(section => !managed || section.active);

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
            Backend APIs
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
        title="Project data"
        description="Zelavis data belongs to this Project. For managed apps, the application’s own data remains separate."
      />
    </section>
  );
}
