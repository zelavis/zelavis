import * as React from "react"
import { AlertTriangle, Check, Clock, Loader2, X } from "lucide-react"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import type { RuntimeAssistantApproval } from "#/lib/runtime-api"

const RESOLVED_TEXT: Record<Exclude<RuntimeAssistantApproval["status"], "pending" | "running">, string> = {
  executed: "Approved",
  failed: "Approved, but it failed",
  denied: "Denied",
  expired: "Expired",
}

/**
 * A change the Assistant asked to make. It names the target by id, says plainly
 * when the change cannot be undone, and has no default action: nothing is
 * focused, Approve is never the Enter key's target, and an irreversible change
 * cannot be approved until its id has been typed out.
 */
export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: RuntimeAssistantApproval
  onDecide: (decision: "approve" | "deny", confirm?: string) => Promise<void>
}) {
  const [confirm, setConfirm] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const pending = approval.status === "pending"
  const confirmed = !approval.irreversible || confirm === approval.target.id

  async function decide(decision: "approve" | "deny") {
    setBusy(true)
    setError(undefined)
    try {
      await onDecide(decision, decision === "approve" ? confirm : undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Approval needed"
      className={
        approval.irreversible && pending
          ? "mx-2 my-2 grid gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm"
          : "mx-2 my-2 grid gap-3 rounded-lg border bg-card p-3 text-sm"
      }
    >
      <div className="flex items-start gap-2">
        {pending ? (
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : approval.status === "running" ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
        ) : approval.status === "executed" ? (
          <Check className="mt-0.5 size-4 shrink-0" />
        ) : (
          <X className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        <div className="grid gap-0.5">
          <div className="font-medium">{approval.label}</div>
          <div className="text-xs text-muted-foreground">
            {approval.target.kind} · <code>{approval.target.id}</code>
          </div>
        </div>
      </div>

      {pending && approval.irreversible ? (
        <div role="alert" className="flex items-start gap-2 text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>This cannot be undone.</span>
        </div>
      ) : null}

      {pending ? (
        <>
          {approval.irreversible ? (
            <label className="grid gap-1.5 text-xs font-medium">
              Type <code>{approval.target.id}</code> to confirm
              <Input
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void decide("deny")}>
              Deny
            </Button>
            <Button
              type="button"
              variant={approval.irreversible ? "destructive" : "default"}
              disabled={busy || !confirmed}
              onClick={() => void decide("approve")}
            >
              Approve
            </Button>
          </div>
        </>
      ) : (
        <div className="text-xs text-muted-foreground">
          {approval.status === "running"
            ? "Running…"
            : `${RESOLVED_TEXT[approval.status as keyof typeof RESOLVED_TEXT]}${approval.outcome ? `. ${approval.outcome}` : ""}`}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
