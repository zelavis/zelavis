import { Link, useLoaderData } from "react-router";
import { Activity, Clock, Globe2, Workflow } from "lucide-react";

import { DataRow, EmptyPanel, StatCard } from "#/components/DashboardPage";
import {
  getActiveRuntimeConfig,
  listWorkloads,
  type WorkloadDefinition,
} from "#/lib/runtime-api";

const workloadViews = ["functions", "jobs", "schedules", "webhooks"] as const;
type WorkloadView = (typeof workloadViews)[number];
type WorkloadsClientLoaderArgs = {
  params: { projectId: string };
  request: Request;
};

export const handle = {
  pageLabel: "Workloads",
  sidebarTrail: ["Backend", "Workloads"],
  slots: [{ id: "overview", label: "Overview" }],
} as const;

export async function clientLoader({ params, request }: WorkloadsClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const url = new URL(request.url);
  const requestedView =
    workloadViewFromPath(url.pathname) ?? url.searchParams.get("workloadView");
  const workloads = await listWorkloads(runtime, {
    projectId: params.projectId,
  });

  return {
    projectId: params.projectId,
    workloads,
    workloadView: workloadViews.includes(requestedView as WorkloadView)
      ? (requestedView as WorkloadView)
      : undefined,
  };
}

function workloadViewFromPath(pathname: string): WorkloadView | undefined {
  const lastSegment = pathname.split("/").filter(Boolean).at(-1);
  return workloadViews.includes(lastSegment as WorkloadView)
    ? (lastSegment as WorkloadView)
    : undefined;
}

function typePath(workload: WorkloadDefinition) {
  const plural =
    workload.type === "function"
      ? "functions"
      : workload.type === "job"
        ? "jobs"
        : workload.type === "schedule"
          ? "schedules"
          : "webhooks";

  return `/projects/${workload.projectId}/workloads/${plural}/${workload.id}`;
}

export default function WorkloadsRoute() {
  const { workloads, workloadView } = useLoaderData<typeof clientLoader>();
  const functions = workloads.filter((workload) => workload.type === "function");
  const jobs = workloads.filter((workload) => workload.type === "job");
  const schedules = workloads.filter((workload) => workload.type === "schedule");
  const webhooks = workloads.filter((workload) => workload.type === "webhook");
  const visibleWorkloads = workloadView
    ? workloads.filter((workload) => workload.type === workloadTypeForView(workloadView))
    : workloads;
  const emptyTitle = workloadView
    ? `No ${workloadView} yet`
    : "No workloads yet";
  const emptyDescription = workloadView
    ? `Use the sidebar action to add the first project ${singularWorkloadView(workloadView)}.`
    : "Use the sidebar action to add the first project function.";

  return (
    <section
      data-dashboard-slot-layout
      className="mx-auto grid w-full max-w-7xl gap-4"
    >
      <div
        data-dashboard-slot="overview"
        className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
      >
        <StatCard
          label="Functions"
          value={String(functions.length)}
          detail="HTTP handlers and public endpoints"
          icon={Workflow}
        />
        <StatCard
          label="Jobs"
          value={String(jobs.length)}
          detail="Manual and queued project tasks"
          icon={Activity}
        />
        <StatCard
          label="Schedules"
          value={String(schedules.length)}
          detail="Cron-like recurring workloads"
          icon={Clock}
        />
        <StatCard
          label="Webhooks"
          value={String(webhooks.length)}
          detail="Inbound event handlers"
          icon={Globe2}
        />
      </div>

      <div className="overflow-hidden rounded-md border">
        {visibleWorkloads.length > 0 ? (
          visibleWorkloads.map((workload) => (
            <DataRow
              key={workload.id}
              label={workload.name}
              detail={`${workload.type} · ${workload.enabled ? "enabled" : "disabled"}`}
              meta={
                <Link
                  to={typePath(workload)}
                  className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Open
                </Link>
              }
            />
          ))
        ) : (
          <EmptyPanel
            title={emptyTitle}
            description={emptyDescription}
          />
        )}
      </div>
    </section>
  );
}

function workloadTypeForView(view: WorkloadView): WorkloadDefinition["type"] {
  switch (view) {
    case "functions":
      return "function";
    case "jobs":
      return "job";
    case "schedules":
      return "schedule";
    case "webhooks":
      return "webhook";
  }
}

function singularWorkloadView(view: WorkloadView) {
  switch (view) {
    case "functions":
      return "function";
    case "jobs":
      return "job";
    case "schedules":
      return "schedule";
    case "webhooks":
      return "webhook";
  }
}
