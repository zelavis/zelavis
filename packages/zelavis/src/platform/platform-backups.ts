/**
 * The Platform's own scheduled, encrypted, off-site backups: its System Store, which holds Projects, placements,
 * accounts, Edge routes and certificates, and the master secret everything encrypted at rest is sealed with.
 *
 * The store is captured logically, every record of every namespace as JSON lines, read through the store's own
 * paging, so the backup does not depend on what engine backs the store. Custody is explicit: the master secret is
 * one of those records, so a System Store backup is as sensitive as the store itself, and what protects it off the
 * host is the schedule's own key, answered once when the schedule is made. Restoring gives the records back as a
 * file on this host; applying them is the operator's act with the Platform stopped
 * (`zelavis system-store import`), because the store being replaced cannot authorize its own replacement.
 *
 * Schedules, runs, verification and restore are the same machinery as a Project's (`node-backups.ts`), here
 * behind `server.backups.manage` in system scope.
 */
import { Cause, Effect } from "effect";
import { integration, integrationValue, present, unwrapFailure } from "../core/runtime/effect-boundary.js";
import { joinPathParts } from "./shared.js";
import type { ZelavisServerRoute } from "../core/index.js";
import type { BackupComponent, DatabaseBackupsHost } from "../db/node-backups.js";
import { InvalidBackup } from "../db/errors.js";
import type { ZelavisSystemStore } from "../system-store.js";

const PAGE = 200;

/** Every System Store record, as one JSON line each: `{ namespace, key, value, updatedAt }`. */
export const systemStoreComponent = (store: ZelavisSystemStore, write: (path: string, lines: ReadonlyArray<string>) => Effect.Effect<void, InvalidBackup>): BackupComponent => ({
  name: "system-store",
  stage: (into) => Effect.gen(function* () {
    const lines: string[] = [];
    const namespaces = yield* Effect.tryPromise({ try: () => Promise.resolve(store.namespaces()), catch: (cause) => new InvalidBackup({ reason: `system-store.namespaces: ${String(cause)}` }) });
    for (const namespace of namespaces) {
      let after: string | undefined;
      for (;;) {
        const page = yield* Effect.tryPromise({
          try: () => Promise.resolve(store.page(namespace.namespace, { limit: PAGE, ...(after === undefined ? {} : { after }) })),
          catch: (cause) => new InvalidBackup({ reason: `system-store.page: ${String(cause)}` }),
        });
        for (const record of page.records) lines.push(JSON.stringify(record));
        if (page.next === undefined || page.records.length === 0) break;
        after = page.next;
      }
    }
    yield* write(`${into}/records.jsonl`, lines);
  }),
});

/** `runtime/backups/*`: the Platform's schedules and runs, the same operations a Project's database offers. */
export function platformBackupRoutes(context: { readonly apiPrefix: string; readonly apiVersion: string; readonly backups?: DatabaseBackupsHost }): readonly ZelavisServerRoute<any>[] {
  const access = { permissions: ["server.backups.manage"], scope: { type: "system" as const } };
  const base = joinPathParts(context.apiPrefix, context.apiVersion, "runtime/backups");
  const spec = (operationId: string, summary: string) => ({ operationId, summary, tags: ["runtime"], responses: { 200: { description: summary }, 400: { description: "Refused, with the reason" }, 404: { description: "This Platform runs no backups" } } });
  const guarded = (run: (backups: DatabaseBackupsHost) => Effect.Effect<unknown, unknown>) => present(Effect.gen(function* () {
    if (!context.backups) return { status: 404, body: { error: "This Platform runs no scheduled backups." } };
    return { status: 200, headers: { "cache-control": "no-store" }, body: yield* run(context.backups) };
  }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
    const error = unwrapFailure(Cause.squash(cause));
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }))));
  const object = (body: unknown): Record<string, unknown> => body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return [
    { id: "runtime.backups.schedules.list", method: "GET", path: `${base}/schedules`, access, spec: spec("listPlatformBackupSchedules", "The Platform's backup schedules"),
      handler: () => guarded((backups) => Effect.map(integrationValue(backups.schedules()), (schedules) => ({ schedules }))) },
    { id: "runtime.backups.schedules.create", method: "POST", path: `${base}/schedules`, access, spec: spec("createPlatformBackupSchedule", "Create a Platform backup schedule; its recoveryKey is answered once"),
      handler: ({ body }: { body: unknown }) => guarded((backups) => integration(() => backups.createSchedule(object(body) as never))) },
    { id: "runtime.backups.schedules.delete", method: "DELETE", path: `${base}/schedules/:name`, access, spec: spec("deletePlatformBackupSchedule", "Stop a Platform backup schedule"),
      handler: ({ body, params }: { body: unknown; params: Record<string, string> }) => guarded((backups) => object(body).confirm === params.name
        ? integration(() => backups.deleteSchedule(params.name!))
        : Effect.fail(new InvalidBackup({ reason: `Deleting a schedule needs { "confirm": "${params.name}" }.` }))) },
    { id: "runtime.backups.schedules.run", method: "POST", path: `${base}/schedules/:name/run`, access, spec: spec("runPlatformBackup", "Run a Platform backup now"),
      handler: ({ params }: { params: Record<string, string> }) => guarded((backups) => integration(() => backups.runNow(params.name!))) },
    { id: "runtime.backups.runs.list", method: "GET", path: `${base}/runs`, access, spec: spec("listPlatformBackupRuns", "The Platform's recorded backup runs, newest first"),
      handler: ({ query }: { query: URLSearchParams }) => guarded((backups) => Effect.map(integrationValue(backups.runs(query.get("schedule") ?? undefined)), (runs) => ({ runs }))) },
    { id: "runtime.backups.runs.verify", method: "POST", path: `${base}/schedules/:name/runs/:runId/verify`, access, spec: spec("verifyPlatformBackup", "Decrypt a Platform backup run and check it against its manifest"),
      handler: ({ params }: { params: Record<string, string> }) => guarded((backups) => integration(() => backups.verify(params.name!, params.runId!))) },
    { id: "runtime.backups.drill", method: "POST", path: `${base}/schedules/:name/drill`, access, spec: spec("drillPlatformBackup", "Restore the newest Platform run into a fresh directory, check it and measure recovery"),
      handler: ({ params, query }: { params: Record<string, string>; query: URLSearchParams }) => guarded((backups) => integration(() => backups.drill(params.name!, query.get("runId") ?? undefined))) },
    { id: "runtime.backups.drills.foreign", method: "POST", path: `${base}/drills`, access, spec: spec("drillForeignBackup", "Drill a run another host made, from its target, schedule name and recovery key alone"),
      handler: ({ body }: { body: unknown }) => guarded((backups) => integration(() => backups.drillFrom(object(body) as never))) },
    { id: "runtime.backups.runs.restore", method: "POST", path: `${base}/schedules/:name/runs/:runId/restore`, access, spec: spec("restorePlatformBackup", "Restore a Platform backup run to files on this host"),
      handler: ({ body, params }: { body: unknown; params: Record<string, string> }) => guarded((backups) => {
        const key = object(body).recoveryKey;
        return integration(() => backups.restore(params.name!, params.runId!, typeof key === "string" ? { recoveryKey: key } : undefined));
      }) },
  ];
}
