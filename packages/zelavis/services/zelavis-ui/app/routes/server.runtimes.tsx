import { Boxes, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";

import { DataRow, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  detectDeploymentBackends,
  getActiveRuntimeConfig,
  listDeploymentBackends,
  updateDeploymentBackendPolicy,
} from "#/lib/runtime-api";
import type { Route } from "./+types/server.runtimes";

export const handle = {
  pageLabel: "Deployment backends",
  sidebarTrail: ["Deployment backends"],
} as const;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  return { runtime, ...(await listDeploymentBackends(runtime)) };
}

export default function ServerRuntimesRoute() {
  const { runtime, policy, backends } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();

  async function run(id: string, action: "detect" | "enable" | "disable" | "default") {
    setPending(`${id}:${action}`);
    setError(undefined);
    try {
      if (action === "detect") {
        await detectDeploymentBackends(runtime, id);
      } else {
        await updateDeploymentBackendPolicy(runtime, id, action);
      }
      revalidator.revalidate();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4" /> Deployment policy
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow
            label="Default for new Projects"
            detail="Changing this policy never migrates an existing Project. Every Project keeps its stored backend assignment."
            meta={<span className="font-medium capitalize">{policy.defaultBackend}</span>}
          />
        </CardContent>
      </Card>

      {error ? <ResourceNotice title="Action failed" description={error} /> : null}

      <section className="grid gap-4 lg:grid-cols-2">
        {backends.map((backend) => {
          const canEnable = !backend.enabled && backend.executable && backend.detection.state === "ready";
          return (
            <Card key={backend.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{backend.title}</CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">{backend.capabilities.description}</p>
                  </div>
                  <StatusBadge state={backend.detection.state} />
                </div>
              </CardHeader>
              <CardContent className="grid gap-4 border-t pt-4">
                <dl className="grid gap-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Policy</dt>
                    <dd className="font-medium">{backend.isDefault ? "Enabled · Default" : backend.enabled ? "Enabled" : "Disabled"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Project driver</dt>
                    <dd className="font-medium">{backend.executable ? "Registered" : "Not registered"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Isolation boundary</dt>
                    <dd className="font-medium capitalize">{backend.capabilities.isolationBoundary.replace("-", " ")}</dd>
                  </div>
                  {backend.detection.version ? (
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Version</dt>
                      <dd className="font-medium">{backend.detection.version}</dd>
                    </div>
                  ) : null}
                </dl>
                {backend.detection.error ? <p className="text-sm text-destructive">{backend.detection.error}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" disabled={Boolean(pending)} onClick={() => run(backend.id, "detect")}>
                    <RefreshCw className="size-4" />
                    {pending === `${backend.id}:detect` ? "Checking..." : "Detect"}
                  </Button>
                  {canEnable ? <Button type="button" disabled={Boolean(pending)} onClick={() => run(backend.id, "enable")}>Enable</Button> : null}
                  {backend.enabled && !backend.isDefault ? <Button type="button" variant="outline" disabled={Boolean(pending)} onClick={() => run(backend.id, "default")}>Make default</Button> : null}
                  {backend.enabled && !backend.isDefault && backend.id !== "native" ? <Button type="button" variant="outline" disabled={Boolean(pending)} onClick={() => run(backend.id, "disable")}>Disable</Button> : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <ResourceNotice
        title="Detection is read-only"
        description="This phase does not install Docker, access its control socket, migrate Projects, or claim that the current native process driver provides a hardened Linux jail. Those require the privileged Agent and native-isolation implementation described in the architecture plan."
      />
    </section>
  );
}
