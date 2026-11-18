import { Effect } from "effect";
import type { DocumentCursor } from "zelavis/db";
import { projectPath, type hostingProvisions } from "./provisions.js";
import { platformFailure, type HostingStore, type Platform } from "./runtime.js";
import { accessEndsAt, type hostingSubscriptions } from "./subscriptions.js";

export function hostingEntitlements(
  store: HostingStore, subscriptions: ReturnType<typeof hostingSubscriptions>,
  provisions: ReturnType<typeof hostingProvisions>, platform: Platform, now: () => number,
) {
  const timestamp = () => new Date(now()).toISOString();
  const reconcileCustomer = Effect.fn(function* (id: string) {
    const current = yield* store.transaction(tx => Effect.gen(function* () {
      const latest = yield* subscriptions.get(id, tx);
      if (!latest?.reviewAfter || Date.parse(latest.reviewAfter) > now()) return;
      const endsAt = accessEndsAt(latest);
      if (latest.state === "suspended" || !endsAt || Date.parse(endsAt) > now()) return latest;
      const next = { ...latest, state: "suspended" as const, entitlementsPending: true, updatedAt: timestamp() };
      yield* subscriptions.put(tx, next);
      return next;
    }));
    if (!current?.entitlementsPending) return;

    const projects = yield* provisions.removeMissing(id);
    if (!projects) return;
    yield* provisions.syncRoles(projects);
    if (projects.state === "suspended") {
      const outcomes = yield* Effect.forEach(projects.billedProjects, projectId =>
        platform("POST", `${projectPath(projectId)}/stop`).pipe(
          Effect.flatMap(response => response.ok || response.status === 404 ? Effect.void : Effect.fail(platformFailure(response.status))),
          Effect.result,
        ), { concurrency: 4 });
      for (const outcome of outcomes) if (outcome._tag === "Failure") return yield* outcome.failure;
    }
    yield* store.transaction(tx => Effect.gen(function* () {
      const latest = yield* subscriptions.require(id, tx);
      const { entitlementsPending: _pending, reviewAfter: _review, ...next } = latest;
      const reviewAfter = next.state === "suspended" ? undefined : accessEndsAt(next);
      yield* subscriptions.put(tx, { ...next, ...(reviewAfter ? { reviewAfter } : {}) });
    }));
  });
  let cursor: DocumentCursor | undefined;
  return () => Effect.gen(function* () {
    const page = yield* subscriptions.page({
      limit: 50, after: cursor, where: [{ path: "reviewAfter", op: "lte", value: timestamp() }],
    });
    for (const { principalId } of page.items) {
      yield* subscriptions.permitFor(principalId).withPermit(reconcileCustomer(principalId)).pipe(
        Effect.catch(error => Effect.logWarning("Hosting entitlement reconciliation deferred", { code: error.code })),
      );
    }
    cursor = page.next;
  });
}
