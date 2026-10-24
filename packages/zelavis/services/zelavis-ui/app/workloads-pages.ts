import { Effect } from "effect";
import { array, label, object, request, type Config } from "./api.ts";
import { button, empty, link, node } from "./dom.ts";
import { columns, dataRow, page, rowsCard, statCard } from "./page-kit.ts";
import { notRunning, projectContext } from "./project-context.ts";
import type { ScreenContext } from "./screens.ts";
import { dropdown } from "./dropdown.ts";

/** Project → Workloads: functions, jobs, schedules and webhooks, their editor, run output and logs. */

const VIEWS = ["functions", "jobs", "schedules", "webhooks"] as const;
const TYPE_OF: Record<string, string> = { functions: "function", jobs: "job", schedules: "schedule", webhooks: "webhook" };
const PLURAL: Record<string, string> = { function: "functions", job: "jobs", schedule: "schedules", webhook: "webhooks" };
const DEFAULT_CODE = 'export default async function handler(ctx) {\n  return new Response("Hello from Zelavis Workloads");\n}\n';

export const workloadsScreen = Effect.fn("ui.workloadsScreen")(function*(context: ScreenContext) {
  const entered = yield* projectContext(context);
  if (entered.missing) return entered.missing;
  const { project, scoped } = entered;
  if (!scoped) return notRunning();
  const api = scoped.api.basePath;
  const base = `/projects/${encodeURIComponent(project.id)}/workloads`;
  const rest = context.path.split("/").slice(4).filter(Boolean);
  const [first, second] = rest;
  if (first === "new") return editorScreen(context, scoped, base, undefined);
  if (first === "logs") return yield* logsScreen(api, project.id);
  if (first === "settings") return settingsScreen();
  if (first && second && (VIEWS as readonly string[]).includes(first)) {
    const workload = object(yield* request(`${api}/workloads/${encodeURIComponent(second)}`));
    return editorScreen(context, scoped, base, workload);
  }
  const requested = first ?? context.url.searchParams.get("workloadView") ?? "";
  const view = (VIEWS as readonly string[]).includes(requested) ? requested : undefined;
  return yield* listScreen(api, project.id, base, view);
});

const listScreen = Effect.fn("ui.workloadList")(function*(api: string, projectId: string, base: string, view: string | undefined) {
  const workloads = array(object(yield* request(`${api}/workloads?projectId=${encodeURIComponent(projectId)}`)).workloads).map(object);
  const count = (type: string) => String(workloads.filter(workload => workload.type === type).length);
  const visible = view ? workloads.filter(workload => workload.type === TYPE_OF[view]) : workloads;
  const singular = view ? TYPE_OF[view] : "function";
  return page(
    columns(3,
      statCard("Functions", count("function"), "HTTP handlers and public endpoints"), statCard("Jobs", count("job"), "Manual and queued project tasks"),
      statCard("Schedules", count("schedule"), "Cron-like recurring workloads"), statCard("Webhooks", count("webhook"), "Inbound event handlers")),
    visible.length
      ? rowsCard("", ...visible.map(workload => dataRow(label(workload.name), `${label(workload.type)} · ${workload.enabled === true ? "enabled" : "disabled"}`, link("Open", `${base}/${PLURAL[label(workload.type, "function")] ?? "functions"}/${encodeURIComponent(label(workload.id, ""))}`))))
      : empty(view ? `No ${view} yet` : "No workloads yet", `Use the sidebar action to add the first project ${singular}.`),
    node("div", { class: "actions" }, link("Add workload", `${base}/new`, { class: "primary" }), link("Logs", `${base}/logs`), link("Settings", `${base}/settings`)));
});

const logsScreen = Effect.fn("ui.workloadLogs")(function*(api: string, projectId: string) {
  const logs = array(object(yield* request(`${api}/workloads/logs?projectId=${encodeURIComponent(projectId)}`)).logs).map(object);
  return page(logs.length
    ? rowsCard("", ...logs.map(log => dataRow(label(log.status), `${label(log.workloadId)} · ${log.responseStatus ? `${label(log.responseStatus)} · ` : ""}${label(log.createdAt)} · ${label(log.output)}`)))
    : empty("No workload logs yet", "Run a workload to create the first log entry."));
});

function settingsScreen() {
  return page(rowsCard("",
    dataRow("Runner", "Development stub runner. Isolated runner adapters come next."),
    dataRow("Scope", "Workloads are project-scoped and served by the long-running Zelavis runtime."),
    dataRow("Provider sync", "External serverless providers belong behind optional Workloads provider plugins.")));
}

/** The create and edit form. The code lives in a CodeMirror island whose changes the form listens for. */
function editorScreen(context: ScreenContext, scoped: Config, base: string, workload: Record<string, unknown> | undefined) {
  const api = scoped.api.basePath;
  const editing = workload !== undefined;
  let code = label(workload?.code, DEFAULT_CODE);
  const type = label(workload?.type, "function");
  const name = node("input", { name: "name", value: label(workload?.name, "hello-world"), required: "", "aria-label": "Name" });
  const kind = dropdown({ name: "type", label: "Type", value: type, disabled: Boolean(editing) }, ["function", "job", "schedule", "webhook"].map(entry => ({ value: entry, label: entry[0].toUpperCase() + entry.slice(1) })));
  const route = node("input", { name: "route", value: label(workload?.route, "/api/hello"), "aria-label": "Route" });
  const schedule = node("input", { name: "schedule", value: label(workload?.schedule, ""), placeholder: "0 * * * *", "aria-label": "Schedule" });
  const enabled = node("input", { type: "checkbox", name: "enabled", ...(workload?.enabled === false ? {} : { checked: "" }) });
  const output = node("div", { role: "status" });
  const body = () => ({ projectId: context.projectId, type: kind.value, name: name.value.trim(), ...(route.value.trim() ? { route: route.value.trim() } : {}), ...(schedule.value.trim() ? { schedule: schedule.value.trim() } : {}), code, enabled: enabled.checked });
  const save = node("button", { type: "submit", class: "primary" }, editing ? "Save" : "Create");
  const run = editing ? [button("Run", () => context.run(request(`${api}/workloads/${encodeURIComponent(label(workload.id, ""))}/run`, "POST", {}), result => {
    output.replaceChildren(node("div", { class: "k-notice" }, node("p", { class: "k-row-label" }, "Run output"), node("pre", {}, label(object(result).output, ""))));
  }))] : [];
  const island = document.createElement("fuzor-island");
  island.setAttribute("src", "code-editor");
  island.setAttribute("props", JSON.stringify({ value: code, minHeight: 520, ariaLabel: "Workload JavaScript editor" }));
  island.addEventListener("code-change", event => { code = String((event as CustomEvent<string>).detail); });
  const form = node("form", { class: "workload-form" },
    node("div", { class: "form" }, node("label", {}, node("span", {}, "Name"), name), node("label", {}, node("span", {}, "Type"), kind), node("label", {}, node("span", {}, "Route"), route), node("label", {}, node("span", {}, "Schedule"), schedule),
      node("label", {}, enabled, node("span", {}, "Enabled")), node("div", { class: "actions" }, save, ...run)),
    island);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (editing) context.run(request(`${api}/workloads/${encodeURIComponent(label(workload.id, ""))}`, "PUT", body()), () => context.navigate(base));
    else context.run(request(`${api}/workloads`, "POST", body()), created => context.navigate(`${base}/functions/${encodeURIComponent(label(object(created).id, ""))}`));
  });
  return page(output, form);
}

