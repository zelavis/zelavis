import * as React from "react"
import { Download, RefreshCw } from "lucide-react"

import { DataRow, ResourceNotice } from "#/components/DashboardPage"
import { Button } from "#/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card"
import { useUpdateStatus } from "#/hooks/use-update-status"
import type { RuntimeConfig } from "#/lib/runtime-api"
import { describeUpdate } from "#/lib/updates"

function ago(iso: string | undefined) {
  if (!iso) return "not yet"
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}

/**
 * Which version runs, whether a newer one is out, and the button that installs it.
 * The update runs on the server as root and survives the restart; this card follows it.
 */
export function UpdateCard({ runtime }: { runtime: RuntimeConfig }) {
  const { status, unavailable, reconnecting, error, busy, check, apply } = useUpdateStatus(runtime)
  const [showLog, setShowLog] = React.useState(false)
  if (unavailable) return null

  const view = describeUpdate(status, reconnecting)
  const working = view.kind === "working"
  const canUpdate = Boolean(status?.managed && status.available) && !working && !busy

  return (
    <Card data-testid="update-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="size-4" />
          Updates
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <DataRow label="Running" detail={status ? `${status.current}${status.channel ? ` (${status.channel} channel)` : ""}` : "checking"} />
        <DataRow
          label="Newest"
          detail={
            status?.latest
              ? status.available ? `${status.latest} is available` : `${status.latest}, you are up to date`
              : status?.checkError ?? "not checked yet"
          }
          meta={<span className="text-xs text-muted-foreground">checked {ago(status?.checkedAt)}</span>}
        />
        <div className="grid gap-3 p-4">
          {view.kind === "working" ? (
            <div role="status" className="flex items-start gap-2 text-sm">
              <RefreshCw className="mt-0.5 size-4 shrink-0 animate-spin" />
              <span>
                <strong className="font-medium">{view.headline}</strong>
                {view.detail ? <span className="block text-muted-foreground">{view.detail}</span> : null}
              </span>
            </div>
          ) : null}
          {view.kind === "done" ? <ResourceNotice title="Updated" description={view.detail ? `${view.headline} ${view.detail}` : view.headline} /> : null}
          {view.kind === "problem" ? (
            <>
              <ResourceNotice title="The update did not complete" description={view.headline} />
              {view.log && view.log.length > 0 ? (
                <div>
                  <Button variant="outline" onClick={() => setShowLog((open) => !open)}>
                    {showLog ? "Hide details" : "Show details"}
                  </Button>
                  {showLog ? (
                    <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{view.log.join("\n")}</pre>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {status && !status.managed ? (
            <ResourceNotice title="Updates are manual here" description={status.unmanagedReason ?? "This installation cannot update itself."} />
          ) : null}
          {error ? <ResourceNotice title="Action failed" description={error} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void apply()} disabled={!canUpdate}>
              <Download className="size-4" />
              {status?.available && status.latest ? `Update to ${status.latest}` : "Update"}
            </Button>
            <Button variant="outline" onClick={() => void check()} disabled={busy || working}>
              <RefreshCw className="size-4" />
              Check now
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The server downloads the new version beside the current one, switches over and restarts, then checks it
            answers. If it does not, it goes back to the previous version by itself.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
