import { Download, RefreshCw } from "lucide-react"
import { Link } from "react-router"

import { Button } from "#/components/ui/button"
import { useUpdateStatus } from "#/hooks/use-update-status"
import type { RuntimeConfig } from "#/lib/runtime-api"
import { describeUpdate } from "#/lib/updates"

/** The line at the top of every page: a newer version, the update running, or why it did not finish. */
export function UpdateBanner({ runtime }: { runtime?: RuntimeConfig }) {
  const { status, unavailable, reconnecting, error, busy, apply } = useUpdateStatus(runtime)
  if (unavailable) return null
  const view = describeUpdate(status, reconnecting)
  if (view.kind === "hidden" || (view.kind === "available" && !status?.managed)) return null

  const tone =
    view.kind === "problem"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-sky-500/25 bg-sky-500/10 text-sky-900 dark:text-sky-100"

  return (
    <div role="status" data-testid="update-banner" className={`rounded-md border px-4 py-3 text-sm ${tone}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {view.kind === "available" ? (
          <span>
            Zelavis <strong className="font-medium">{view.latest}</strong> is available. You are running {view.current}.
          </span>
        ) : (
          <span className="flex items-center gap-2">
            {view.kind === "working" ? <RefreshCw className="size-4 shrink-0 animate-spin" /> : null}
            <span>
              {view.headline}
              {"detail" in view && view.detail ? <span className="block opacity-80">{view.detail}</span> : null}
            </span>
          </span>
        )}
        <span className="flex shrink-0 items-center gap-3">
          {error ? <span className="text-xs">{error}</span> : null}
          {view.kind === "available" ? (
            <Button onClick={() => void apply()} disabled={busy}>
              <Download className="size-4" />
              Update now
            </Button>
          ) : null}
          {view.kind === "problem" || view.kind === "available" ? (
            <Link to="/settings" className="text-sm font-medium underline-offset-4 hover:underline">
              Details
            </Link>
          ) : null}
        </span>
      </div>
    </div>
  )
}
