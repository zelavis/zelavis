import { Effect } from "effect";
import { array, label, object, request, type Config } from "./api.ts";
import { slugifyTableName } from "./create-table-dialog.ts";
import { mountDeleteTenant } from "./delete-tenant-dialog.ts";
import { button, link, node } from "./dom.ts";
import { badge, card, columns, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash, statCard } from "./page-kit.ts";
import { formatBytes } from "./storage-pages.ts";
import { tenantKind, validTenantId } from "./tenant-ids.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * Project → Database → Tenants: every Tenant of the Project's database with what it holds, a way to add one, and a backup of
 * any of them. A Tenant exists once it holds something, so adding one writes its first table; the database has no operation to
 * delete a Tenant (a dropped table leaves its history), so there is no delete here.
 */

export const tenantsScreen = Effect.fn("ui.tenantsScreen")(function*(context: ScreenContext, scoped: Config, base: string, projectId: string) {
  const api = scoped.api.basePath;
  const tenants = array(object(yield* request(`${api}/database/tenants/overview`)).tenants).map(object);
  const databasePath = `${base}/database`;

  const download = (tenantId: string) => context.run(request(`${api}/database/maintenance/backups/export`, "POST", { tenantId }).pipe(
    Effect.tap(backup => Effect.sync(() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
      const anchor = node("a", { href: url, download: `${projectId}-${tenantId.replace(/[^A-Za-z0-9_-]+/g, "_")}.backup.json` });
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFlash(`Backup of ${tenantId} downloaded.`);
    })),
  ));

  // One confirmation dialog for every row; it lives with the page and is removed when the page is.
  const dialogHost = node("div", { class: "dialog-host" });
  const confirmDelete = mountDeleteTenant(dialogHost, { api, removed: tenantId => { setFlash(`Deleted Tenant ${tenantId}.`); context.refresh(); } });

  const rows = tenants.map(entry => {
    const id = label(entry.tenantId, "");
    const tables = Number(entry.tables) || 0;
    const kind = tenantKind(id);
    const documents = Number(entry.documents) || 0;
    const detail = `${tables} ${tables === 1 ? "table" : "tables"} · ${documents} ${documents === 1 ? "document" : "documents"} · ${formatBytes(Number(entry.bytes) || 0)} · shard ${label(entry.shard, "?")}`;
    const actions = node("div", { class: "actions" }, badge(kind === "App" ? "active" : kind === "Plugin" ? "planned" : "ready"), node("span", { class: "muted" }, kind),
      tables > 0 ? link("Open tables", `${databasePath}?databaseTenant=${encodeURIComponent(id)}`) : node("span", { class: "muted" }, "No tables"),
      button("Back up", () => download(id), { "aria-label": `Download a backup of ${id}` }),
      // The App's own Tenant and a plugin's are not for the operator to delete from here: the app and the plugin stand on them.
      ...(kind === "Tenant" ? [button("Delete", () => confirmDelete.open({ tenantId: id, tables, documents, size: formatBytes(Number(entry.bytes) || 0) }), { class: "danger", "aria-label": `Delete Tenant ${id}` })] : []));
    return dataRow(id, detail, actions);
  });

  const tenantInput = node("input", { name: "tenantId", placeholder: "acme", "aria-label": "Tenant ID", autocomplete: "off", required: "", maxlength: "128" });
  const tableInput = node("input", { name: "table", placeholder: "orders", "aria-label": "First table name", autocomplete: "off", required: "", maxlength: "128" });
  tableInput.addEventListener("input", () => { tableInput.value = slugifyTableName(tableInput.value); });
  const problem = node("div", { "aria-live": "polite" });
  const create = node("button", { type: "submit", class: "primary" }, "Create tenant");
  const form = node("form", { class: "form" },
    node("label", {}, node("span", {}, "Tenant ID"), tenantInput),
    node("label", {}, node("span", {}, "First table"), tableInput),
    problem, node("div", { class: "actions" }, create));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const tenantId = tenantInput.value.trim(), table = slugifyTableName(tableInput.value) || tableInput.value.trim();
    if (!validTenantId(tenantId)) { problem.replaceChildren(node("div", { class: "notice error", role: "alert" }, "A Tenant ID uses letters, digits, _ . and -, starts with a letter or digit, and is not a zv name.")); return; }
    if (tenants.some(entry => entry.tenantId === tenantId)) { problem.replaceChildren(node("div", { class: "notice error", role: "alert" }, `Tenant ${tenantId} already exists.`)); return; }
    if (!table) { problem.replaceChildren(node("div", { class: "notice error", role: "alert" }, "Enter the name of its first table.")); return; }
    problem.replaceChildren(); create.setAttribute("disabled", "");
    context.run(request(`${api}/database/documents/collections`, "POST", { tenantId, name: table, surface: "database", metadata: { kind: "table" } }).pipe(Effect.ensuring(Effect.sync(() => create.removeAttribute("disabled")))), () => { setFlash(`Created Tenant ${tenantId} with table ${table}.`); context.refresh(); });
  });

  const own = tenants.filter(entry => tenantKind(label(entry.tenantId, "")) !== "Plugin");
  return page(
    dialogHost,
    flashNotice("Tenants"),
    resourceNotice("What a Tenant is", "A Tenant is a separate data space inside this Project, with its own tables, record history and writer. Apps usually keep one per customer or workspace. zelavis-app holds the app's own data; service:… Tenants belong to plugins."),
    columns(3,
      statCard("Tenants", String(own.length), `${tenants.length - own.length} more belong to plugins`),
      statCard("Tables", String(tenants.reduce((sum, entry) => sum + (Number(entry.tables) || 0), 0)), "Across every Tenant"),
      statCard("Documents", String(tenants.reduce((sum, entry) => sum + (Number(entry.documents) || 0), 0)), `${formatBytes(tenants.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0))} stored in every Tenant`)),
    rows.length ? rowsCard("Tenants", ...rows) : card("Tenants", node("p", { class: "muted" }, "No Tenant holds data yet.")),
    card("Create a tenant", node("p", { class: "muted" }, "A Tenant exists once it holds something, so creating one adds its first table. Deleting a Tenant removes its tables and its whole history for good; the App's own Tenant and plugins' Tenants cannot be deleted here."), form),
  );
});
