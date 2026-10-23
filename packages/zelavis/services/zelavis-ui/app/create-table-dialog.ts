import { Cause, Effect } from "effect";
import { registerDialog } from "fuzor/ui/components/dialog";
import { label, object, request } from "./api.ts";
import { message, node } from "./dom.ts";

/** A table name the database accepts: lowercase letters, digits, underscore and hyphen, starting with a letter or underscore. */
export function slugifyTableName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z_]+/i, "").replace(/^_+/, "_").replace(/_+$/g, "");
}

export interface CreateTableOptions {
  /** The Project's API root. */
  api: string;
  /** Tenants offered in the picker, and the one selected first. */
  tenants: readonly string[];
  tenant: string;
  /** Called with the created table once the database has accepted it. */
  created(tenant: string, table: string): void;
  /** Called when the dialog closes without creating, so the URL state that opened it can be cleared. */
  dismissed(): void;
}

/**
 * The Create Table dialog, built on `fuzor/ui`'s dialog (focus trap, Escape, focus return). It is opened by URL state
 * (`databaseDialog=create-table`, set by the sidebar's Create Table item), so a reload or a shared link reopens it.
 */
export function mountCreateTable(host: HTMLElement, options: CreateTableOptions) {
  registerDialog();
  const doc = host.ownerDocument;
  const lifetime = new AbortController();
  const tenant = node("select", { name: "tenantId", "aria-label": "Tenant" });
  const name = node("input", { name: "name", placeholder: "articles", "aria-label": "Table name", autocomplete: "off", required: "", maxlength: "128" });
  name.addEventListener("input", () => { name.value = slugifyTableName(name.value); });
  const errors = node("div", { "aria-live": "polite" });
  const submit = node("button", { type: "submit", class: "primary" }, "Create and Open Table");
  const cancel = node("button", { type: "button" }, "Cancel");
  const form = node("form", { class: "form" }, node("label", {}, node("span", {}, "Tenant"), tenant), node("label", {}, node("span", {}, "Table name"), name), errors, node("div", { class: "actions" }, submit, cancel));
  const dialog = doc.createElement("fuzor-dialog") as HTMLElement & { setOpen(open: boolean): void; isOpen: boolean };
  const content = doc.createElement("fuzor-dialog-content");
  content.setAttribute("aria-label", "Create table");
  const title = doc.createElement("fuzor-dialog-title"); title.textContent = "Create table";
  const description = doc.createElement("fuzor-dialog-description"); description.textContent = "A table holds records in one Tenant. Its name uses lowercase letters, digits, _ and -.";
  const header = doc.createElement("fuzor-dialog-header"); header.append(title, description);
  content.append(header, form);
  const overlay = doc.createElement("fuzor-dialog-overlay");
  const portal = doc.createElement("fuzor-dialog-portal"); portal.append(overlay, content);
  dialog.append(portal);
  host.append(dialog);

  let open = false, busy = false;
  const close = () => { if (dialog.isOpen) dialog.setOpen(false); };
  cancel.addEventListener("click", close);
  // Escape, the overlay and Cancel all end in a state change; the URL follows it.
  dialog.addEventListener("ui:open-change", event => {
    const next = Boolean((event as CustomEvent<{ open: boolean }>).detail?.open);
    if (next === open) return;
    open = next;
    if (!next && !busy) options.dismissed();
    if (next) setTimeout(() => name.focus(), 0);
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy) return;
    const chosen = tenant.value || options.tenant;
    const table = slugifyTableName(name.value) || name.value.trim();
    if (!table) { errors.replaceChildren(message("Enter a table name.", true)); return; }
    busy = true; submit.setAttribute("disabled", ""); errors.replaceChildren();
    Effect.runFork(request(`${options.api}/database/documents/collections`, "POST", { tenantId: chosen, name: table, surface: "database", metadata: { kind: "table" } }).pipe(
      Effect.map(created => label(object(created).name, table)),
      Effect.matchCauseEffect({
        onSuccess: created => Effect.sync(() => { busy = false; name.value = ""; options.created(chosen, created); }),
        onFailure: cause => Effect.sync(() => { busy = false; submit.removeAttribute("disabled"); const error = Cause.squash(cause); errors.replaceChildren(message(error instanceof Error ? error.message : String(error), true)); }),
      }),
    ), { signal: lifetime.signal });
  });
  return {
    /** Follow the URL: open or close the dialog, and offer the current Tenants. */
    sync(wanted: boolean, tenants: readonly string[], current: string) {
      const names = [...new Set([...tenants, current].filter(Boolean))];
      const selected = tenant.value || current;
      tenant.replaceChildren(...names.map(value => { const option = node("option", { value }, value); option.selected = value === selected; return option; }));
      if (wanted !== open) { open = wanted; dialog.setOpen(wanted); if (wanted) setTimeout(() => name.focus(), 0); }
      if (!wanted) { errors.replaceChildren(); submit.removeAttribute("disabled"); }
    },
    dispose() { lifetime.abort(); dialog.remove(); },
  };
}
