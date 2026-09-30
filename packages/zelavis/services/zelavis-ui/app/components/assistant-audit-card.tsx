import * as React from "react"
import { ScrollText } from "lucide-react"

import { ResourceNotice } from "#/components/DashboardPage"
import { Button } from "#/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card"
import {
  RuntimeApiError,
  listAssistantAudit,
  type AssistantAuditRecord,
  type RuntimeConfig,
} from "#/lib/runtime-api"

const DECISION_LABEL: Record<AssistantAuditRecord["decision"], string> = {
  allowed: "Allowed",
  denied: "Denied",
  invalid: "Invalid request",
  failed: "Failed",
  pending_approval: "Asked for approval",
  executed: "Ran after approval",
}

/**
 * What the Assistant did, for whom, and what was decided. Read-only, newest
 * first, and only shown to those who may audit it.
 */
export function AssistantAuditCard({ runtime }: { runtime: RuntimeConfig }) {
  const [records, setRecords] = React.useState<readonly AssistantAuditRecord[]>([])
  const [next, setNext] = React.useState<string>()
  const [loaded, setLoaded] = React.useState(false)
  const [hidden, setHidden] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()

  const load = React.useCallback(
    async (before?: string) => {
      setBusy(true)
      setError(undefined)
      try {
        const page = await listAssistantAudit(runtime, { before })
        setRecords((current) => (before ? [...current, ...page.records] : page.records))
        setNext(page.next)
        setLoaded(true)
      } catch (cause) {
        if (cause instanceof RuntimeApiError && (cause.status === 401 || cause.status === 403)) {
          setHidden(true)
        } else {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        setBusy(false)
      }
    },
    [runtime],
  )

  React.useEffect(() => {
    void load()
  }, [load])

  if (hidden) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="size-4" />
          Assistant activity
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4">
        {error ? <ResourceNotice title="Could not load" description={error} /> : null}
        {loaded && records.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Every tool the Assistant uses, and every decision on a change it asked for,
            is recorded here.
          </p>
        ) : null}
        {records.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" aria-label="Assistant activity">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Who</th>
                  <th className="py-1 pr-3 font-medium">What</th>
                  <th className="py-1 pr-3 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} className="border-t align-top">
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {new Date(record.at).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3">
                      <code>{record.principalId}</code>
                    </td>
                    <td className="py-1.5 pr-3">
                      <code>{record.tool}</code>
                      <div className="max-w-64 truncate text-muted-foreground" title={record.arguments}>
                        {record.arguments}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3">
                      {DECISION_LABEL[record.decision] ?? record.decision}
                      {record.reason ? (
                        <div className="max-w-64 truncate text-muted-foreground" title={record.reason}>
                          {record.reason}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {next ? (
          <div>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void load(next)}>
              Load older
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
