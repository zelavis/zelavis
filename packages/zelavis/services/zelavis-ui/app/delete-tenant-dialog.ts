import { Cause, Effect } from "effect";
import { registerDialog } from "fuzor/ui/components/dialog";
import { request } from "./api.ts";
import { message, node } from "./dom.ts";

export interface DeleteTenant {
  tenantId: string;
  tables: number;
  documents: number;
  size: string;
}

/**
 * The confirmation for removing a Tenant, on `fuzor/ui`'s dialog. Removal cannot be undone and takes the Tenant's history with it,
 * so the button stays disabled until the Tenant ID is typed again, the same confirmation the HTTP route, the SDK and the CLI ask for.
 */
export function mountDeleteTenant(host: HTMLElement, options: { api: string; removed(tenant: string): void }) {
  registerDialog();
  const doc = host.ownerDocument;
  const lifetime = new AbortController();
  const dialog = doc.createElement("fuzor-dialog") as HTMLElement & { setOpen(open: boolean): void };
  const title = doc.createElement("fuzor-dialog-title");
  const description = doc.createElement("fuzor-dialog-description");
  const confirm = node("input", { name: "confirm", "aria-label": "Type the Tenant ID to confirm", autocomplete: "off", spellcheck: "false" });
  const errors = node("div", { "aria-live": "polite" });
  const remove = node("button", { type: "submit", class: "danger", disabled: "" }, "Delete tenant");
  const cancel = node("button", { type: "button" }, "Cancel");
  const prompt = node("span", {});
  const form = node("form", { class: "form" }, node("label", {}, prompt, confirm), errors, node("div", { class: "actions" }, remove, cancel));
  const content = doc.createElement("fuzor-dialog-content");
  content.setAttribute("aria-label", "Delete tenant");
  const header = doc.createElement("fuzor-dialog-header"); header.append(title, description);
  content.append(header, form);
  const portal = doc.createElement("fuzor-dialog-portal"); portal.append(doc.createElement("fuzor-dialog-overlay"), content);
  dialog.append(portal);
  host.append(dialog);

  let target: DeleteTenant | undefined, busy = false;
  const matches = () => target !== undefined && confirm.value === target.tenantId;
  confirm.addEventListener("input", () => { if (!busy) matches() ? remove.removeAttribute("disabled") : remove.setAttribute("disabled", ""); });
  cancel.addEventListener("click", () => dialog.setOpen(false));
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || !target || !matches()) return;
    const { tenantId } = target;
    busy = true; remove.setAttribute("disabled", ""); errors.replaceChildren();
    Effect.runFork(request(`${options.api}/database/tenants/${encodeURIComponent(tenantId)}`, "DELETE", { confirm: tenantId }).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => Effect.sync(() => { busy = false; dialog.setOpen(false); options.removed(tenantId); }),
        onFailure: cause => Effect.sync(() => { busy = false; const error = Cause.squash(cause); errors.replaceChildren(message(error instanceof Error ? error.message : String(error), true)); if (matches()) remove.removeAttribute("disabled"); }),
      }),
    ), { signal: lifetime.signal });
  });
  return {
    open(next: DeleteTenant) {
      target = next; confirm.value = ""; errors.replaceChildren(); remove.setAttribute("disabled", "");
      title.textContent = `Delete tenant ${next.tenantId}`;
      description.textContent = `This removes ${next.tables} ${next.tables === 1 ? "table" : "tables"}, ${next.documents} ${next.documents === 1 ? "document" : "documents"} (${next.size}) and the Tenant's whole history. It cannot be undone. Download a backup first if you may need it.`;
      prompt.textContent = `Type ${next.tenantId} to confirm`;
      dialog.setOpen(true);
      setTimeout(() => confirm.focus(), 0);
    },
    dispose() { lifetime.abort(); dialog.remove(); },
  };
}
