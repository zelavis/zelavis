import { Effect } from "effect";
import { array, label, object, request } from "./api.ts";
import { button, message, node } from "./dom.ts";
import { card, dataRow, rowsCard } from "./page-kit.ts";
import { formatBytes } from "./storage-pages.ts";

/** What a drill of a managed app's run found of the app's own data, as one sentence, or nothing for any other run. */
const appCaptured = (value: unknown): string => {
  const app = object(value);
  if (app.recipe === undefined) return "";
  const captured = array(app.captured).map(entry => label(entry, ""));
  const missing = array(app.missing).map(entry => label(entry, ""));
  return ` The app (${label(app.recipe)}): ${captured.length === 0 ? "nothing" : captured.join(", ")} captured${missing.length === 0 ? "" : `; ${missing.join(", ")} not backed up`}.`;
};

/**
 * Scheduled, encrypted, off-site backups: schedules, recent runs and a form, over the same routes the SDK and CLI
 * use. A Project's page passes its database's routes, Server → Backups the Platform's (`runtime/backups`).
 */
export const backupSchedulesPanel = Effect.fn("ui.backupSchedules")(function*(
  schedulesApi: string,
  runsApi: string,
  act: (effect: Effect.Effect<unknown, unknown>, done: (result: unknown) => string) => void,
) {
  const schedules = array(object(yield* request(schedulesApi)).schedules).map(object);
  const runs = array(object(yield* request(runsApi)).runs).map(object).slice(0, 20);
  const scheduleRows = schedules.map(schedule => {
    const name = label(schedule.name, "");
    const target = object(schedule.target);
    return dataRow(name, `${label(schedule.cron)} · keep ${label(schedule.keep)} · ${label(target.kind)} ${label(target.location)} · key ${label(schedule.keyFingerprint)}${schedule.nextRunAt ? ` · next ${label(schedule.nextRunAt)}` : ""}`,
      node("div", { class: "actions" },
        button("Run now", () => act(request(`${schedulesApi}/${encodeURIComponent(name)}/run`, "POST", {}), result => {
          const run = object(result);
          return run.status === "ok" ? `Backed up ${label(run.bytes)} bytes as run ${label(run.runId)}.` : `Backup run failed: ${label(run.error)}`;
        }), { "aria-label": `Run backup ${name} now` }),
        button("Drill", () => act(request(`${schedulesApi}/${encodeURIComponent(name)}/drill`, "POST", {}), result => {
          const drill = object(object(result).drill);
          return drill.ok === true
            ? `Drill of ${name}: restored and opened in ${label(drill.rtoMs)} ms; its data was ${Math.round(Number(drill.rpoMs) / 1000)} s old.` + appCaptured(drill.app)
            : `Drill of ${name} failed: ${label(drill.error)}`;
        }), { "aria-label": `Drill backup ${name}` }),
        button("Delete", () => {
          if (!window.confirm(`Stop schedule ${name}? Runs already at the target stay there.`)) return;
          act(request(`${schedulesApi}/${encodeURIComponent(name)}`, "DELETE", { confirm: name }), () => `Deleted schedule ${name}.`);
        }, { class: "danger", "aria-label": `Delete backup schedule ${name}` })));
  });
  const runRows = runs.map(run => {
    const schedule = label(run.schedule, ""), runId = label(run.runId, "");
    const state = `${label(run.status)}${run.bytes === undefined ? "" : ` · ${formatBytes(Number(run.bytes))}`}${run.verified === undefined ? "" : ` · ${run.verified ? "verified" : "does not verify"}`}${run.restoredTo ? ` · restored to ${label(run.restoredTo)}` : ""}${run.drill ? ` · drill ${object(run.drill).ok === true ? `ok, ${label(object(run.drill).rtoMs)} ms` : "failed"}` : ""}${run.error ? ` · ${label(run.error)}` : ""}`;
    return dataRow(`${schedule} · ${runId}`, state, node("div", { class: "actions" }, ...(run.status !== "ok" ? [] : [
      button("Verify", () => act(request(`${schedulesApi}/${encodeURIComponent(schedule)}/runs/${encodeURIComponent(runId)}/verify`, "POST", {}),
        result => object(result).verified === true ? `Run ${runId} decrypts and matches its manifest.` : `Run ${runId} does not verify.`), { "aria-label": `Verify backup run ${runId}` }),
      button("Restore", () => {
        if (!window.confirm(`Restore run ${runId} into an image directory on this host? The live database is not touched.`)) return;
        act(request(`${schedulesApi}/${encodeURIComponent(schedule)}/runs/${encodeURIComponent(runId)}/restore`, "POST", {}),
          result => `Restored run ${runId} to ${label(object(result).restoredTo)}.`);
      }, { "aria-label": `Restore backup run ${runId}` }),
    ])));
  });
  const definition = node("textarea", { rows: "7", maxlength: "4096", "aria-label": "Backup schedule JSON" },
    JSON.stringify({ name: "nightly", cron: "0 3 * * *", keep: 14, target: { kind: "s3", bucket: "", region: "", endpoint: "", accessKeyId: "", secretAccessKey: "" } }, null, 2));
  const scheduleForm = node("form", { class: "form" }, node("label", {}, "Schedule", definition),
    node("p", { class: "muted" }, 'cron is five or six fields (UTC unless timeZone is set); target is { "kind": "s3", … } or { "kind": "directory", "path": "/mnt/offsite" }. The target is tested for conditional writes before it is accepted.'),
    node("button", { type: "submit", class: "primary" }, "Create schedule"));
  scheduleForm.addEventListener("submit", event => {
    event.preventDefault();
    let input: unknown;
    try { input = JSON.parse(definition.value); } catch { window.alert("The schedule is not JSON."); return; }
    act(request(schedulesApi, "POST", input), result => {
      const created = object(result);
      // Shown once: the host keeps a copy for scheduled runs, but recovery after losing the host needs this one.
      window.prompt(`Schedule ${label(created.name)} created. Copy its recovery key now and keep it off this host; it is not shown again.`, label(created.recoveryKey));
      return `Created schedule ${label(created.name)}.`;
    });
  });

  return [
    scheduleRows.length ? rowsCard("Schedules", ...scheduleRows) : card(undefined, message("No backup schedules.")),
    card("Create a schedule", scheduleForm),
    ...(runRows.length ? [rowsCard("Recent runs", ...runRows)] : []),
  ];
});
