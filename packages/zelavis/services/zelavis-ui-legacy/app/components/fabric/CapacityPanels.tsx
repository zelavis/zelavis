import { Cloud, Server } from "lucide-react";
import { useFetcher } from "react-router";

import { DataRow, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import type {
  RuntimeCloudScaling,
  RuntimeCloudConnection,
  RuntimeCloudNode,
  RuntimeEnrollmentToken,
  RuntimeNode,
  RuntimeNodeEnrollment,
} from "#/lib/runtime-api";
import { CLOUD_PROVIDERS, describeScaleOutOutcome, joinCommand } from "#/lib/capacity";

/** What a loader could read. `unavailable` carries the reason: no permission, or not composed in. */
export type Loaded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface NodesData {
  readonly nodes: readonly RuntimeNode[];
  readonly enrollments: readonly RuntimeNodeEnrollment[];
  readonly platform: { readonly url: string; readonly fingerprint: string } | null;
}

export interface CloudData {
  readonly connection: RuntimeCloudConnection | null;
  readonly machines: readonly RuntimeCloudNode[];
  readonly scaling: RuntimeCloudScaling | null;
}

export type CapacityActionResult =
  | { readonly intent: "enroll"; readonly token: RuntimeEnrollmentToken }
  | { readonly intent: string; readonly done: true }
  | { readonly intent: string; readonly error: string };

const FABRIC_ACTION = "/server/fabric";

function Failure({ title, reason }: { title: string; reason: string }) {
  return <ResourceNotice title={title} description={reason} />;
}

function ActionError({ result }: { result: CapacityActionResult | undefined }) {
  if (!result || !("error" in result)) return null;
  return (
    <p role="alert" className="px-4 pb-3 text-sm text-destructive">
      {result.error}
    </p>
  );
}

function when(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

export function NodesCapacityPanel({ data }: { data: Loaded<NodesData> }) {
  const fetcher = useFetcher<CapacityActionResult>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  if (!data.ok) return <Failure title="Nodes are not available" reason={data.reason} />;
  const { nodes, enrollments, platform } = data.value;
  const pending = enrollments.filter((enrollment) => enrollment.state === "unused");
  const issued = result && "token" in result ? result.token : undefined;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4" />
            Fabric nodes
          </CardTitle>
          <CardDescription>Enrolled machines that run Projects for this Platform.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {nodes.length === 0 ? (
            <DataRow label="No nodes enrolled" detail="Add a machine below. This Platform keeps running Projects itself until one joins." />
          ) : (
            nodes.map((node) => (
              <DataRow
                key={node.nodeId}
                label={node.nodeId}
                detail={`${node.url} · ${node.version ?? "unknown version"}${node.compatibility === "behind" ? " · behind this Platform" : ""} · enrolled ${when(node.enrolledAt)}`}
                meta={
                  <span className="flex items-center gap-2">
                    <StatusBadge state={node.state === "active" ? (node.compatibility === "behind" ? "degraded" : "active") : "unavailable"} />
                    {node.state === "active" ? (
                      <fetcher.Form method="post" action={FABRIC_ACTION}>
                        <input type="hidden" name="intent" value="remove-node" />
                        <input type="hidden" name="nodeId" value={node.nodeId} />
                        <Button type="submit" variant="outline" disabled={busy}>Revoke</Button>
                      </fetcher.Form>
                    ) : null}
                  </span>
                }
              />
            ))
          )}
          {pending.map((enrollment) => (
            <DataRow
              key={`pending-${enrollment.nodeId}`}
              label={enrollment.nodeId}
              detail={`${enrollment.origin === "cloud" ? "Requested through the cloud" : "Waiting for the machine to join"} · expires ${when(enrollment.expiresAt)}`}
              meta={<StatusBadge state="provisioning" />}
            />
          ))}
          <ActionError result={result?.intent === "remove-node" ? result : undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a machine you manage</CardTitle>
          <CardDescription>
            Install the worker role on the machine, then run the command shown here as root. The token works once.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {platform ? (
            <fetcher.Form method="post" action={FABRIC_ACTION} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="intent" value="enroll" />
              <Input name="nodeId" placeholder="node-id, for example worker-1" required className="max-w-xs" aria-label="Node id" />
              <Button type="submit" disabled={busy}>Create join command</Button>
            </fetcher.Form>
          ) : (
            <Failure
              title="This installation does not accept nodes yet"
              reason="Start it with an enrollment port (zelavis serve --enrollment-port) so machines have somewhere to join."
            />
          )}
          <ActionError result={result?.intent === "enroll" ? result : undefined} />
          {issued && platform ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                Run on {issued.nodeId} (expires {when(issued.expiresAt)}). This is the only time the token is shown.
              </p>
              <code className="block overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs" data-testid="join-command">
                {joinCommand({ platform, nodeId: issued.nodeId, token: issued.token })}
              </code>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

export function CloudCapacityPanel({ data }: { data: Loaded<CloudData> }) {
  const fetcher = useFetcher<CapacityActionResult>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  if (!data.ok) return <Failure title="Cloud capacity is not available" reason={data.reason} />;
  const { connection, machines, scaling } = data.value;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="size-4" />
            Cloud provider
          </CardTitle>
          <CardDescription>
            Optional. Connecting a provider lets Zelavis create and delete worker machines in it. Existing servers keep working without one.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {connection ? (
            <DataRow
              label={`${connection.label} (${connection.provider})`}
              detail={`Token ending ${connection.tokenHint} · connected ${when(connection.connectedAt)} by ${connection.connectedBy}`}
              meta={
                <fetcher.Form method="post" action={FABRIC_ACTION}>
                  <input type="hidden" name="intent" value="disconnect-cloud" />
                  <Button type="submit" variant="outline" disabled={busy || machines.length > 0}>Disconnect</Button>
                </fetcher.Form>
              }
            />
          ) : (
            <fetcher.Form method="post" action={FABRIC_ACTION} className="grid gap-3 p-4">
              <input type="hidden" name="intent" value="connect-cloud" />
              <p className="text-sm text-muted-foreground">
                The token can create and delete machines in its cloud project, so use a token from a dedicated project. It is stored encrypted, never shown again, and every use is audited.
              </p>
              <select name="provider" className="h-9 max-w-xs rounded-md border bg-background px-2 text-sm" aria-label="Provider" defaultValue={CLOUD_PROVIDERS[0].id}>
                {CLOUD_PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
              <Input name="label" placeholder="Label (optional)" className="max-w-xs" aria-label="Label" />
              <Input name="token" type="password" autoComplete="off" placeholder="API token" required className="max-w-xs" aria-label="API token" />
              <div>
                <Button type="submit" disabled={busy}>Connect</Button>
              </div>
            </fetcher.Form>
          )}
          <ActionError result={result && (result.intent === "connect-cloud" || result.intent === "disconnect-cloud") ? result : undefined} />
        </CardContent>
      </Card>

      {connection && scaling ? (
        <Card>
          <CardHeader>
            <CardTitle>Automatic scale-out</CardTitle>
            <CardDescription>
              Off by default. When on, Zelavis requests one machine at a time, and only after Projects have stayed unplaceable for lack of capacity for a couple of minutes. It never deletes machines by itself, and each request is audited.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <fetcher.Form method="post" action={FABRIC_ACTION} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="intent" value="set-scaling" />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="consent" value="true" defaultChecked={scaling.settings.consent} />
                Allow Zelavis to spend money on machines
              </label>
              <label className="flex items-center gap-2 text-sm">
                At most
                <Input name="maxMachines" type="number" min={1} max={20} defaultValue={scaling.settings.maxMachines} className="w-20" aria-label="Maximum machines" />
                machines
              </label>
              <label className="flex items-center gap-2 text-sm">
                Pause
                <Input name="cooldownMinutes" type="number" min={1} max={1440} defaultValue={scaling.settings.cooldownMinutes} className="w-24" aria-label="Minutes between requests" />
                minutes between requests
              </label>
              <Button type="submit" disabled={busy}>Save</Button>
            </fetcher.Form>
            <p className="text-sm text-muted-foreground" data-testid="scale-out-status">
              {scaling.settings.consent ? "Automatic scale-out is on. " : "Automatic scale-out is off. "}
              {describeScaleOutOutcome(scaling.last?.outcome)}
            </p>
            <ActionError result={result?.intent === "set-scaling" ? result : undefined} />
          </CardContent>
        </Card>
      ) : null}

      {connection ? (
        <Card>
          <CardHeader>
            <CardTitle>Machines Zelavis created</CardTitle>
            <CardDescription>Only machines this Platform created appear here, and only those are ever deleted.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {machines.length === 0 ? (
              <DataRow label="No machines" detail="Request one to add a worker that enrolls itself." />
            ) : (
              machines.map((machine) => (
                <DataRow
                  key={machine.id}
                  label={machine.id}
                  detail={machine.region ? `${machine.provider} · ${machine.region}` : machine.provider}
                  meta={
                    <span className="flex items-center gap-2">
                      <StatusBadge state={machine.state} />
                      <fetcher.Form method="post" action={FABRIC_ACTION}>
                        <input type="hidden" name="intent" value="release-machine" />
                        <input type="hidden" name="machineId" value={machine.id} />
                        <Button type="submit" variant="outline" disabled={busy || machine.state === "releasing"}>Release</Button>
                      </fetcher.Form>
                    </span>
                  }
                />
              ))
            )}
            <fetcher.Form method="post" action={FABRIC_ACTION} className="flex flex-wrap items-center gap-2 p-4">
              <input type="hidden" name="intent" value="request-machine" />
              <Input name="region" placeholder="Location (optional, per your policy)" className="max-w-xs" aria-label="Location" />
              <Button type="submit" disabled={busy}>Request a machine</Button>
            </fetcher.Form>
            <ActionError result={result && (result.intent === "request-machine" || result.intent === "release-machine") ? result : undefined} />
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
