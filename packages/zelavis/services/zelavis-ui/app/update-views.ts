import { button, link, message, node } from "./dom.ts";
import { resourceNotice } from "./page-kit.ts";
import { applyUpdate, checkForUpdate, getUpdateSnapshot, subscribeUpdates } from "./update-watch.ts";
import { ago, describeUpdate } from "./updates.ts";

/** The line at the top of every page: a newer version, the update running, or why it did not finish. */
export function mountUpdateBanner(host: HTMLElement) {
  const render = () => {
    const { status, unavailable, reconnecting, error, busy } = getUpdateSnapshot();
    const view = describeUpdate(status, reconnecting);
    if (unavailable || view.kind === "hidden" || view.kind === "available" && !status?.managed) { host.replaceChildren(); return; }
    const text = view.kind === "available"
      ? node("span", {}, "Zelavis ", node("strong", {}, view.latest), ` is available. You are running ${view.current}.`)
      : node("span", {}, view.headline, ...(view.kind !== "problem" && "detail" in view && view.detail ? [node("small", { class: "block" }, view.detail)] : []));
    const actions = node("span", { class: "actions" },
      ...(error ? [node("small", {}, error)] : []),
      ...(view.kind === "available" ? [button("Update now", applyUpdate, { class: "primary", ...(busy ? { disabled: "" } : {}) })] : []),
      ...(view.kind === "problem" || view.kind === "available" ? [link("Details", "/settings")] : []));
    host.replaceChildren(node("div", { role: "status", "data-testid": "update-banner", class: `update-banner ${view.kind === "problem" ? "problem" : ""}` }, text, actions));
  };
  render();
  return subscribeUpdates(render);
}

/** Which version runs, whether a newer one is out, and the button that installs it; follows the update while it runs. */
export function mount(host: HTMLElement) {
  let showLog = false;
  const render = () => {
    const { status, unavailable, reconnecting, error, busy } = getUpdateSnapshot();
    if (unavailable) { host.replaceChildren(); return; }
    const view = describeUpdate(status, reconnecting);
    const working = view.kind === "working";
    const row = (title: string, detail: string, meta?: string) => node("div", { class: "k-row" }, node("div", {}, node("p", { class: "k-row-label" }, title), node("p", { class: "k-row-detail" }, detail)), ...(meta ? [node("div", { class: "k-row-meta" }, meta)] : []));
    const body: Node[] = [];
    if (view.kind === "working") body.push(node("div", { role: "status" }, node("strong", {}, view.headline), ...(view.detail ? [node("p", { class: "muted" }, view.detail)] : [])));
    if (view.kind === "done") body.push(resourceNotice("Updated", view.detail ? `${view.headline} ${view.detail}` : view.headline));
    if (view.kind === "problem") {
      body.push(resourceNotice("The update did not complete", view.headline));
      if (view.log?.length) {
        body.push(button(showLog ? "Hide details" : "Show details", () => { showLog = !showLog; render(); }));
        if (showLog) body.push(node("pre", {}, view.log.join("\n")));
      }
    }
    if (status && !status.managed) body.push(resourceNotice("Updates are manual here", status.unmanagedReason ?? "This installation cannot update itself."));
    if (error) body.push(message(error, true));
    const canUpdate = Boolean(status?.managed && status.available) && !working && !busy;
    body.push(node("div", { class: "actions" },
      button(status?.available && status.latest ? `Update to ${status.latest}` : "Update", applyUpdate, { class: "primary", ...(canUpdate ? {} : { disabled: "" }) }),
      button("Check now", checkForUpdate, busy || working ? { disabled: "" } : {})));
    body.push(node("p", { class: "muted" }, "The server downloads the new version beside the current one, switches over and restarts, then checks it answers. If it does not, it goes back to the previous version by itself."));
    host.replaceChildren(node("section", { class: "k-card flush", "data-testid": "update-card" }, node("h2", {}, "Updates"),
      row("Running", status ? `${status.current}${status.channel ? ` (${status.channel} channel)` : ""}` : "checking"),
      row("Newest", status?.latest ? status.available ? `${status.latest} is available` : `${status.latest}, you are up to date` : status?.checkError ?? "not checked yet", `checked ${ago(status?.checkedAt)}`),
      node("div", { class: "k-row" }, node("div", { class: "k-stack" }, ...body))));
  };
  render();
  return subscribeUpdates(render);
}
