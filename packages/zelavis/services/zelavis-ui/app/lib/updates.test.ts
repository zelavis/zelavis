import { describe, expect, it } from "vitest"

import { describeUpdate, updatePollDelay } from "./updates"
import type { UpdateStatus } from "./runtime-api"

const base: UpdateStatus = { current: "2.0.0-alpha.8", channel: "alpha", available: false, managed: true, state: "idle" }

describe("describeUpdate", () => {
  it("shows nothing until there is something to say", () => {
    expect(describeUpdate(undefined).kind).toBe("hidden")
    expect(describeUpdate(base).kind).toBe("hidden")
  })

  it("offers the newer version", () => {
    expect(describeUpdate({ ...base, latest: "2.0.0-alpha.9", available: true })).toEqual({ kind: "available", latest: "2.0.0-alpha.9", current: "2.0.0-alpha.8" })
  })

  it("follows an update from the request to the restart", () => {
    expect(describeUpdate({ ...base, latest: "2.0.0-alpha.9", available: true, state: "requested" }).kind).toBe("working")
    const running = describeUpdate({ ...base, state: "running", run: { id: "1", state: "running", from: "2.0.0-alpha.8", startedAt: "2026-10-02T10:00:00Z", message: "Installing 2.0.0-alpha.9." } })
    expect(running).toMatchObject({ kind: "working", headline: "Installing 2.0.0-alpha.9." })
    expect(describeUpdate(undefined, true)).toMatchObject({ kind: "working", headline: "Restarting Zelavis…" })
  })

  it("says so when the new version is the one running", () => {
    const done = describeUpdate({ ...base, current: "2.0.0-alpha.9", state: "succeeded", run: { id: "1", state: "succeeded", from: "2.0.0-alpha.8", to: "2.0.0-alpha.9", startedAt: "2026-10-02T10:00:00Z" } })
    expect(done).toEqual({ kind: "done", headline: "Updated to 2.0.0-alpha.9." })
  })

  it("does not claim success for an old run when something newer is out", () => {
    const view = describeUpdate({ ...base, current: "2.0.0-alpha.9", latest: "2.0.0-alpha.10", available: true, state: "succeeded", run: { id: "1", state: "succeeded", from: "2.0.0-alpha.8", to: "2.0.0-alpha.9", startedAt: "2026-10-02T10:00:00Z" } })
    expect(view.kind).toBe("available")
  })

  it("reports a failure or a rollback with the installer's log", () => {
    const view = describeUpdate({ ...base, state: "rolled-back", run: { id: "1", state: "rolled-back", from: "2.0.0-alpha.8", startedAt: "2026-10-02T10:00:00Z", message: "Version did not answer. Rolled back.", log: ["npm error"] } })
    expect(view).toMatchObject({ kind: "problem", headline: "Version did not answer. Rolled back.", log: ["npm error"] })
  })
})

describe("updatePollDelay", () => {
  it("polls quickly only while something is happening", () => {
    expect(updatePollDelay({ ...base, state: "running" }, false)).toBe(2000)
    expect(updatePollDelay(undefined, true)).toBe(2000)
    expect(updatePollDelay(base, false)).toBeGreaterThan(60_000)
  })
})
