import { useState } from "react";

import { CodeEditor } from "#/components/code/CodeEditor";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type { WorkloadDefinition, WorkloadType } from "#/lib/runtime-api";

const defaultCode = `export default async function handler(ctx) {
  return new Response("Hello from Zelavis Workloads");
}
`;

export function WorkloadForm({
  defaultType = "function",
  disabled,
  error,
  mode,
  output,
  workload,
}: {
  defaultType?: WorkloadType;
  disabled?: boolean;
  error?: string;
  mode: "create" | "edit";
  output?: string;
  workload?: WorkloadDefinition;
}) {
  const [type, setType] = useState<WorkloadType>(workload?.type ?? defaultType);
  const [code, setCode] = useState(workload?.code ?? defaultCode);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {output ? (
        <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm">
          <p className="font-medium">Run output</p>
          <pre className="mt-2 whitespace-pre-wrap text-muted-foreground">
            {output}
          </pre>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Name</span>
            <Input
              name="name"
              defaultValue={workload?.name ?? "hello-world"}
              required
              disabled={disabled}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Type</span>
            {mode === "edit" ? <input type="hidden" name="type" value={type} /> : null}
            <select
              name="type"
              value={type}
              onChange={(event) => setType(event.target.value as WorkloadType)}
              disabled={disabled || mode === "edit"}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="function">Function</option>
              <option value="job">Job</option>
              <option value="schedule">Schedule</option>
              <option value="webhook">Webhook</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Route</span>
            <Input
              name="route"
              defaultValue={workload?.route ?? "/api/hello"}
              disabled={disabled}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Schedule</span>
            <Input
              name="schedule"
              defaultValue={workload?.schedule ?? ""}
              placeholder="0 * * * *"
              disabled={disabled}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="enabled"
              value="true"
              defaultChecked={workload?.enabled ?? true}
              disabled={disabled}
            />
            <span>Enabled</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" name="intent" value="save" disabled={disabled}>
              {mode === "create" ? "Create" : "Save"}
            </Button>
            {mode === "edit" ? (
              <Button
                type="submit"
                name="intent"
                value="run"
                variant="outline"
                disabled={disabled}
              >
                Run
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-w-0">
          <input type="hidden" name="code" value={code} />
          <CodeEditor
            value={code}
            onChange={setCode}
            minHeight={520}
            ariaLabel="Workload JavaScript editor"
          />
        </div>
      </div>
    </div>
  );
}
