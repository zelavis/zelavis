import * as React from "react"

import {
  RuntimeApiError,
  applyUpdate,
  checkForUpdate,
  getUpdateStatus,
  type RuntimeConfig,
  type UpdateStatus,
} from "#/lib/runtime-api"
import { updatePollDelay } from "#/lib/updates"

interface Snapshot {
  status: UpdateStatus | undefined
  unavailable: boolean
  reconnecting: boolean
  error: string | undefined
  busy: boolean
}

/**
 * One shared view of the installation's update state for the whole dashboard.
 *
 * The banner at the top of every page and the card in Settings read the same
 * store, so there is a single poller and a click in one shows in the other. It
 * polls slowly when idle and quickly while an update runs. The Platform restarts
 * during an update, so a refused connection while one is in progress means
 * "reconnecting", not "broken". When the version it reports is not the one this
 * page was loaded from, the page reloads so the new dashboard is the one shown.
 */
let snapshot: Snapshot = { status: undefined, unavailable: false, reconnecting: false, error: undefined, busy: false }
let loadedFrom: string | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let subscribers = 0
let source: RuntimeConfig | undefined
const listeners = new Set<() => void>()

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

function receive(status: UpdateStatus) {
  loadedFrom ??= status.current
  publish({ status, reconnecting: false })
  if (loadedFrom !== status.current) window.location.reload()
}

const working = () => snapshot.status?.state === "requested" || snapshot.status?.state === "running"

async function refresh() {
  if (!source) return
  try {
    receive(await getUpdateStatus(source))
  } catch (cause) {
    if (cause instanceof RuntimeApiError && [401, 403, 404].includes(cause.status)) {
      publish({ unavailable: true })
      return
    }
    // While an update runs the Platform restarts, so a refused connection is expected.
    if (working()) publish({ reconnecting: true })
  }
}

function schedule() {
  if (timer) clearTimeout(timer)
  if (subscribers === 0 || snapshot.unavailable) return
  timer = setTimeout(async () => {
    await refresh()
    schedule()
  }, updatePollDelay(snapshot.status, snapshot.reconnecting))
}

async function act(run: (config: RuntimeConfig) => Promise<UpdateStatus>) {
  if (!source) return
  publish({ busy: true, error: undefined })
  try {
    receive(await run(source))
  } catch (cause) {
    publish({ error: cause instanceof Error ? cause.message : String(cause) })
  } finally {
    publish({ busy: false })
    schedule()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  subscribers += 1
  if (subscribers === 1) void refresh().then(schedule)
  return () => {
    listeners.delete(listener)
    subscribers -= 1
    if (subscribers === 0 && timer) clearTimeout(timer)
  }
}

export function useUpdateStatus(runtime: RuntimeConfig | undefined) {
  source = runtime ?? source
  const state = React.useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
  return {
    ...state,
    check: () => act(checkForUpdate),
    apply: () => act(applyUpdate),
  }
}
