import { Form, redirect, useLoaderData, useNavigation } from "react-router";

import { WorkloadForm } from "#/components/workloads/WorkloadForm";
import {
  getActiveRuntimeConfig,
  getWorkload,
  runWorkload,
  type WorkloadType,
  updateWorkload,
} from "#/lib/runtime-api";
import type { Route } from "./+types/workloads.$workloadId";

export const handle = {
  pageLabel: "Workloads",
  sidebarTrail: ["Backend", "Workloads"],
  slots: [{ id: "edit", label: "Edit" }],
} as const;

function readFormString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const workload = await getWorkload(runtime, params.workloadId);

  return { workload };
}

export async function clientAction({ request, params }: Route.ClientActionArgs) {
  const formData = await request.formData();
  const runtime = await getActiveRuntimeConfig(request);
  const intent = String(formData.get("intent") ?? "save");

  try {
    if (intent === "run") {
      const log = await runWorkload(runtime, params.workloadId);
      return { output: log.output };
    }

    await updateWorkload(runtime, params.workloadId, {
      projectId: params.projectId,
      type: (readFormString(formData, "type") || "function") as WorkloadType,
      name: readFormString(formData, "name"),
      route: readFormString(formData, "route") || undefined,
      schedule: readFormString(formData, "schedule") || undefined,
      code: readFormString(formData, "code"),
      enabled: formData.get("enabled") === "true",
    });

    return redirect(`/projects/${params.projectId}/workloads`);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default function WorkloadDetailRoute({
  actionData,
}: Route.ComponentProps) {
  const { workload } = useLoaderData<typeof clientLoader>();
  const navigation = useNavigation();
  const error =
    actionData && "error" in actionData && typeof actionData.error === "string"
      ? actionData.error
      : undefined;
  const output =
    actionData &&
    "output" in actionData &&
    typeof actionData.output === "string"
      ? actionData.output
      : undefined;

  return (
    <Form
      method="post"
      data-dashboard-slot-layout
      className="min-h-0 min-w-0"
    >
      <div data-dashboard-slot="edit">
        <WorkloadForm
          mode="edit"
          workload={workload}
          error={error}
          output={output}
          disabled={navigation.state !== "idle"}
        />
      </div>
    </Form>
  );
}
