import { Form, redirect, useNavigation } from "react-router";

import { WorkloadForm } from "#/components/workloads/WorkloadForm";
import {
  createWorkload,
  getRuntimeConfig,
  type WorkloadType,
} from "#/lib/runtime-api";
import type { Route } from "./+types/workloads.new";

export const handle = {
  pageLabel: "Workloads",
  sidebarTrail: ["Backend", "Workloads"],
  slots: [{ id: "create", label: "Create" }],
} as const;

function readFormString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

export async function clientAction({ request, params }: Route.ClientActionArgs) {
  const formData = await request.formData();
  const runtime = await getRuntimeConfig();

  try {
    const workload = await createWorkload(runtime, {
      projectId: params.projectId,
      type: (readFormString(formData, "type") || "function") as WorkloadType,
      name: readFormString(formData, "name"),
      route: readFormString(formData, "route") || undefined,
      schedule: readFormString(formData, "schedule") || undefined,
      code: readFormString(formData, "code"),
      enabled: formData.get("enabled") === "true",
    });

    return redirect(
      `/projects/${params.projectId}/workloads/functions/${workload.id}`,
    );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default function NewWorkloadRoute({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const error =
    actionData && "error" in actionData && typeof actionData.error === "string"
      ? actionData.error
      : undefined;

  return (
    <Form
      method="post"
      data-dashboard-slot-layout
      className="min-h-0 min-w-0"
    >
      <div data-dashboard-slot="create">
        <WorkloadForm
          mode="create"
          error={error}
          disabled={navigation.state !== "idle"}
        />
      </div>
    </Form>
  );
}
