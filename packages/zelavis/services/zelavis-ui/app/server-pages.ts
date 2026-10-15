import { Effect } from "effect";
import { array, label, object, request } from "./api.ts";
import { button, empty, link, message, node } from "./dom.ts";
import type { ScreenContext } from "./screens.ts";

/** Server pages the Fuzor dashboard renders itself. A path listed here never falls back to the React island. */
export const nativeServerPaths = ["/server/logs", "/server/terminal"] as const;

const LEVELS = ["debug", "info", "warn", "error"] as const;
const heading = (text: string, ...actions: HTMLElement[]) => node("div", { class: "toolbar" }, node("h1", {}, text), node("div", { class: "actions" }, ...actions));
const notice = (text: string) => node("p", { class: "muted" }, text);

/**
 * Server → Logs: the Platform's recent log, newest first, filterable by level and by the reference an
 * "Action failed" message shows. The filters live in the URL, so a reload or a shared link shows the same view.
 */
export const logsScreen = Effect.fn("ui.logsScreen")(function*(context: ScreenContext) {
  const api = context.config.api.basePath;
  const requestedLevel = context.url.searchParams.get("level") ?? "";
  const requestedReference = (context.url.searchParams.get("ref") ?? "").trim();
  const level = (LEVELS as readonly string[]).includes(requestedLevel) ? requestedLevel : "";
  const reference = /^[0-9a-f]{1,64}$/.test(requestedReference) ? requestedReference : "";
  const query = new URLSearchParams({ limit: "300" });
  if (level) query.set("level", level);
  if (reference) query.set("correlationId", reference);
  const page = object(yield* request(`${api}/runtime/logs?${query}`));
  // The API answers oldest first, which suits following; a person reading wants the newest on top.
  const entries = array(page.entries).map(object).reverse();

  const referenceInput = node("input", { name: "ref", value: reference, placeholder: "8ad2ea39082e4cf6", autocomplete: "off", spellcheck: "false", ...(requestedReference && !reference ? { "aria-invalid": "true" } : {}) });
  const levelSelect = node("select", { name: "level", "aria-label": "Level" }, node("option", { value: "" }, "All levels"), ...LEVELS.map(entry => node("option", { value: entry, ...(entry === level ? { selected: "" } : {}) }, `${entry} and above`)));
  const filters = node("form", { class: "filters" },
    node("label", {}, node("span", {}, "Reference"), referenceInput),
    node("label", {}, node("span", {}, "Level"), levelSelect),
    node("button", { type: "submit", class: "primary" }, "Filter"),
    ...(reference || level ? [button("Clear", () => context.setSearch({ ref: undefined, level: undefined }))] : []),
    button("Refresh", () => context.refresh()));
  filters.addEventListener("submit", event => {
    event.preventDefault();
    context.setSearch({ ref: referenceInput.value.trim() || undefined, level: levelSelect.value || undefined });
  });

  const list = node("ul", { class: "log-entries" });
  for (const entry of entries) {
    const correlation = typeof entry.correlationId === "string" ? entry.correlationId : undefined;
    const when = new Date(label(entry.at, ""));
    list.append(node("li", { class: `log-entry ${label(entry.level, "info")}` },
      node("div", { class: "log-meta" },
        node("time", { datetime: label(entry.at, "") }, Number.isNaN(when.getTime()) ? label(entry.at) : when.toLocaleString()),
        node("span", { class: "log-level" }, label(entry.level, "info")),
        node("span", { class: "log-source" }, label(entry.source)),
        ...(correlation ? [link(correlation, `/server/logs?ref=${correlation}`, { class: "log-reference" })] : [])),
      node("p", { class: "log-message" }, label(entry.message, "")),
      ...(typeof entry.detail === "string" ? [node("pre", { class: "log-detail" }, entry.detail)] : [])));
  }

  return node("section", { class: "panel" },
    heading("Logs"),
    notice("What this Platform recorded about itself since it started, newest first. It is kept in memory and emptied by a restart; the service journal keeps the same error lines. Paste the reference from an “Action failed” message to see the cause behind it."),
    filters,
    ...(requestedReference && !reference ? [message("A reference is the hexadecimal code shown with the error.", true)] : []),
    node("p", { class: "muted" }, `${entries.length} ${entries.length === 1 ? "entry" : "entries"}${page.truncated === true ? " (older entries were dropped)" : ""}`),
    entries.length ? list : empty("Nothing recorded", reference || level ? "Nothing matches this filter." : "Unexpected request failures appear here with their reference."));
});

/**
 * Server → Terminal: a shell on this server, inside tmux, for principals with `server.terminal.use`. The page
 * lists the caller's sessions; the selected one is in the URL, and its view is an island that owns xterm and the
 * polling for exactly as long as the page is shown.
 */
export const terminalScreen = Effect.fn("ui.terminalScreen")(function*(context: ScreenContext) {
  const api = context.config.api.basePath;
  const overview = object(yield* request(`${api}/runtime/terminal`));
  const sessions = array(overview.sessions).map(object).map(session => ({ id: label(session.id, "") })).filter(session => session.id);
  const intro = notice("A shell on this server, as the account the Platform runs as (not root), inside tmux: closing this page leaves it running and the next visit picks it up again. Opening and closing sessions is written to the Platform log; what you type is not recorded.");

  if (overview.available !== true) {
    const install = button("Install tmux", () => context.run(request(`${api}/runtime/terminal/install`, "POST", {}), () => context.refresh()), { class: "primary" });
    return node("section", { class: "panel" }, heading("Terminal"), intro,
      node("div", { class: "empty" }, node("h2", {}, "The terminal is not available on this server."), node("p", {}, label(overview.reason, "")), install,
        node("p", { class: "muted" }, "Installs the tmux package through the audited host package operation; it needs the server.packages.install permission.")));
  }

  const requested = context.url.searchParams.get("session") ?? "";
  const selected = sessions.find(session => session.id === requested) ?? sessions.at(-1);
  const open = button("New terminal", () => context.run(request(`${api}/runtime/terminal/sessions`, "POST", { cols: 100, rows: 30 }), created => {
    const id = object(object(created).session).id;
    context.setSearch({ session: typeof id === "string" ? id : undefined });
  }));
  const close = selected ? [button("Close this session", () => context.run(request(`${api}/runtime/terminal/sessions/${encodeURIComponent(selected.id)}`, "DELETE"), () => context.setSearch({ session: undefined })))] : [];
  const tabs = sessions.map((session, index) => button(`Session ${index + 1}`, () => context.setSearch({ session: session.id }), { class: session.id === selected?.id ? "primary" : "", "aria-pressed": String(session.id === selected?.id) }));

  const view = selected
    ? (() => { const island = document.createElement("fuzor-island"); island.setAttribute("src", "terminal"); island.setAttribute("props", JSON.stringify({ apiBase: api, sessionId: selected.id })); return island; })()
    : empty("No open sessions", "Open a terminal to get a shell. It keeps running if you leave.");
  return node("section", { class: "panel" },
    heading("Terminal", ...tabs, open, ...close),
    intro,
    node("p", { class: "muted" }, `${sessions.length} of ${label(overview.maxSessions, "8")} sessions`),
    view);
});
