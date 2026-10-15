import { Effect } from "effect";
import { label, object, request, type Config } from "./api.ts";
import { link, node } from "./dom.ts";
import { card, page } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/** Project → Database → Create table. The table list and records are the Fuzor database view. */

/** A table name the database accepts: lowercase letters, digits, underscore and hyphen, starting with a letter or underscore. */
export function slugifyTableName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[^a-z_]+/i, "").replace(/^_+/, "_").replace(/_+$/g, "");
}

export const newTableScreen = Effect.fn("ui.newTable")(function*(context: ScreenContext, scoped: Config, base: string) {
  const name = node("input", { name: "name", placeholder: "articles", "aria-label": "Table name", autocomplete: "off" });
  name.addEventListener("input", () => { name.value = slugifyTableName(name.value); });
  const submit = node("button", { type: "submit", class: "primary" }, "Create and Open Table");
  const form = node("form", { class: "form" }, name, node("div", { class: "actions" }, submit, link("Cancel", base)));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const normalized = slugifyTableName(name.value) || name.value.trim();
    if (!normalized) return;
    submit.setAttribute("disabled", "");
    context.run(request(`${scoped.api.basePath}/database/documents/collections`, "POST", { tenantId: "zelavis-app", name: normalized, surface: "database", metadata: { kind: "table" } }).pipe(Effect.ensuring(Effect.sync(() => submit.removeAttribute("disabled")))),
      table => context.navigate(`${base}?databaseTable=${encodeURIComponent(label(object(table).name, normalized))}`));
  });
  return page(node("div", { class: "actions" }, link("Back to Database", base)), card("Create table", form));
});

