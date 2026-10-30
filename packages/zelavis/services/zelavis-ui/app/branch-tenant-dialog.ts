import { Cause, Effect } from "effect";
import { registerDialog } from "fuzor/ui/components/dialog";
import { request } from "./api.ts";
import { message, node } from "./dom.ts";
import { ensureBrand } from "./brand.ts";
import { validTenantId } from "./tenant-ids.ts";

/**
 * Branching a Tenant into a new one, on `fuzor/ui`'s dialog. The branch is a copy as of one moment that then goes its own
 * way, so all it asks is the new Tenant's ID, and whether the source's undelivered outbox messages go along (by default
 * they stay with the source, which is the one to deliver them). The same request the HTTP route, the SDK and the CLI make.
 */
export function mountBranchTenant(host: HTMLElement, options: { api: string; taken(tenant: string): boolean; branched(from: string, into: string): void }) {
  ensureBrand();
  registerDialog();
  const doc = host.ownerDocument;
  const lifetime = new AbortController();
  const dialog = doc.createElement("zv-dialog") as HTMLElement & { setOpen(open: boolean): void };
  const title = doc.createElement("zv-dialog-title");
  const description = doc.createElement("zv-dialog-description");
  const into = node("input", { name: "into", "aria-label": "New Tenant ID", autocomplete: "off", spellcheck: "false", required: "", maxlength: "128" });
  const copyOutbox = node("input", { type: "checkbox", name: "copyOutbox" });
  const errors = node("div", { "aria-live": "polite" });
  const branch = node("button", { type: "submit", class: "primary" }, "Branch tenant");
  const cancel = node("button", { type: "button" }, "Cancel");
  const form = node("form", { class: "form" },
    node("label", {}, node("span", {}, "New Tenant ID"), into),
    node("label", {}, copyOutbox, node("span", {}, "Also copy its undelivered outbox messages")),
    errors, node("div", { class: "actions" }, branch, cancel));
  const content = doc.createElement("zv-dialog-content");
  content.setAttribute("aria-label", "Branch tenant");
  const header = doc.createElement("zv-dialog-header"); header.append(title, description);
  content.append(header, form);
  const portal = doc.createElement("zv-dialog-portal"); portal.append(doc.createElement("zv-dialog-overlay"), content);
  dialog.append(portal);
  host.append(dialog);

  let source: string | undefined, busy = false;
  cancel.addEventListener("click", () => dialog.setOpen(false));
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || source === undefined) return;
    const from = source, target = into.value.trim();
    if (!validTenantId(target)) { errors.replaceChildren(message("A Tenant ID uses letters, digits, _ . and -, starts with a letter or digit, and is not a zv name.", true)); return; }
    if (target === from || options.taken(target)) { errors.replaceChildren(message(`Tenant ${target} already exists; a branch needs a new one.`, true)); return; }
    busy = true; branch.setAttribute("disabled", ""); errors.replaceChildren();
    Effect.runFork(request(`${options.api}/database/tenants/${encodeURIComponent(from)}/branch`, "POST", { into: target, outbox: copyOutbox.checked ? "copy" : "leave" }).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => Effect.sync(() => { busy = false; branch.removeAttribute("disabled"); dialog.setOpen(false); options.branched(from, target); }),
        onFailure: cause => Effect.sync(() => { busy = false; branch.removeAttribute("disabled"); const error = Cause.squash(cause); errors.replaceChildren(message(error instanceof Error ? error.message : String(error), true)); }),
      }),
    ), { signal: lifetime.signal });
  });
  return {
    open(tenantId: string, divided = false) {
      source = tenantId; into.value = ""; copyOutbox.checked = false; errors.replaceChildren(); branch.removeAttribute("disabled");
      title.textContent = `Branch tenant ${tenantId}`;
      description.textContent = `Makes a new Tenant holding a copy of ${tenantId} as it is now: its tables, records and history. ${tenantId} keeps taking writes; nothing written to either afterwards reaches the other, and the branch is not merged back.${divided ? ` ${tenantId} is divided into parts: each part is copied as of its own moment, so the parts of the branch are consistent within themselves but not with one another.` : ""}`;
      dialog.setOpen(true);
      setTimeout(() => into.focus(), 0);
    },
    dispose() { lifetime.abort(); dialog.remove(); },
  };
}
