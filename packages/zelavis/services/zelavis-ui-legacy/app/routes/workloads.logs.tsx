import { useLoaderData } from "react-router";

import { DataRow, EmptyPanel } from "#/components/DashboardPage";
import { getActiveRuntimeConfig, listWorkloadLogs } from "#/lib/runtime-api";
import type { Route } from "./+types/workloads.logs";

export const handle = {
  pageLabel: "Workloads",
  sidebarTrail: ["Backend", "Workloads"],
  slots: [{ id: "logs", label: "Logs" }],
} as const;

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const logs = await listWorkloadLogs(runtime, {
    projectId: params.projectId,
  });

  return { logs };
}

export default function WorkloadLogsRoute() {
  const { logs } = useLoaderData<typeof clientLoader>();

  return (
    <section
      data-dashboard-slot-layout
      className="mx-auto w-full max-w-5xl"
    >
      <div data-dashboard-slot="logs" className="overflow-hidden rounded-md border">
        {logs.length > 0 ? (
          logs.map((log) => (
            <DataRow
              key={log.id}
              label={log.status}
              detail={`${log.workloadId} · ${
                log.responseStatus ? `${log.responseStatus} · ` : ""
              }${log.createdAt} · ${log.output}`}
            />
          ))
        ) : (
          <EmptyPanel
            title="No workload logs yet"
            description="Run a workload to create the first log entry."
          />
        )}
      </div>
    </section>
  );
}
