import { Effect } from "effect";
import { ApiError, array, label, object, request, type Config } from "./api.ts";
import { button, json, link, message, node, table } from "./dom.ts";
import { card, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/** An operator view over the shared index API; the page owns no index state. */
export const crossTenantIndexesScreen = Effect.fn("ui.crossTenantIndexes")(function*(context: ScreenContext, scoped: Config, base: string) {
  const api = `${scoped.api.basePath}/database/cross-tenant-indexes`;
  const path = `${base}/database/cross-tenant-indexes`;
  const indexes = array(object(yield* request(api)).indexes).map(object);
  const selected = indexes.find(index => index.name === context.url.searchParams.get("index"));
  const permissions = array(object(object(scoped.access).principal).permissions);
  const canManage = scoped.access === undefined || permissions.includes("*") || permissions.includes("database.indexes.manage");
  const parse = (text: string) => Effect.try({ try: () => {
    if (text.length > 8192) throw new TypeError("Use at most 8192 characters of JSON.");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Use a JSON object.");
    return value;
  }, catch: cause => new ApiError({ message: String(cause) }) });
  const act = (effect: Effect.Effect<unknown, ApiError>, text: string) => context.run(effect, () => { setFlash(text); context.refresh(); });
  const rows = indexes.map(index => {
    const name = label(index.name, ""), failures = array(index.failures).map(object);
    const detail = `${label(index.collection)} · ${array(index.shards).length} derived shards · ${label(index.partitions, "0")} partitions · ${index.refreshedAt ? `last full refresh ${label(index.refreshedAt)}` : "no completed full refresh"}`;
    return dataRow(name, detail, node("div", { class: "actions" },
      link("Query", `${path}?index=${encodeURIComponent(name)}`, { "aria-label": `Query index ${name}` }),
      ...(canManage ? [
        button("Refresh", () => act(request(`${api}/${encodeURIComponent(name)}/refresh`, "POST", {}), `Refreshed index ${name}.`), { "aria-label": `Refresh index ${name}` }),
        button("Drop", () => { if (window.confirm(`Drop derived index ${name}? Source records stay in their Tenants.`)) context.run(request(`${api}/${encodeURIComponent(name)}`, "DELETE"), () => { setFlash(`Dropped index ${name}.`); context.setSearch({ index: undefined, query: undefined, after: undefined }); }); }, { "aria-label": `Drop index ${name}`, class: "danger" }),
      ] : []),
      ...failures.map(failure => message(`${label(failure.partition)}: ${label(failure.error)}`, true))));
  });
  const content: Node[] = [flashNotice("Index updated"),
    resourceNotice("Search across Tenants", "An index copies one collection from every Tenant and follows their record histories. Results are eventually consistent. Source records remain in their Tenants; plugin-private Tenants are excluded."),
    rows.length ? rowsCard("Indexes", ...rows) : card(undefined, message("No cross-Tenant indexes have been defined.")),
  ];
  if (selected) {
    const name = label(selected.name, ""), query = context.url.searchParams.get("query") ?? "{}";
    const after = context.url.searchParams.get("after");
    const result = yield* parse(query).pipe(Effect.flatMap(body => request(`${api}/${encodeURIComponent(name)}/query`, "POST", { ...object(body), ...(after ? { after } : {}) })),
      Effect.map(object), Effect.catch(error => Effect.succeed({ error: error.message } as Record<string, unknown>)));
    const input = node("textarea", { rows: "5", maxlength: "8192", "aria-label": "Index query JSON" }, query);
    const form = node("form", { class: "form" }, node("label", {}, "Query filters, geometry, similarity, order and limit", input), node("button", { type: "submit", class: "primary" }, "Run query"));
    form.addEventListener("submit", event => { event.preventDefault(); context.setSearch({ query: input.value, after: undefined }); });
    const matches = array(result.matches).map(object).map(match => ({ ...match, data: JSON.stringify(match.data) }));
    content.push(card(name, form,
      result.error ? message(label(result.error), true) : matches.length ? table(matches, ["tenant", "part", "id", "version", "data"]) : message("No matching records."),
      ...(typeof result.next === "string" ? [button("Next page", () => context.setSearch({ after: result.next as string }))] : []),
      ...(after ? [button("First page", () => context.setSearch({ after: undefined }))] : []),
      node("details", {}, node("summary", {}, "Index definition"), json(selected))));
  }
  if (canManage) {
    const initial = context.url.searchParams.get("definition") ?? JSON.stringify({ name: "", collection: "", columns: [] }, null, 2);
    const definition = node("textarea", { rows: "8", maxlength: "8192", "aria-label": "Index definition JSON" }, initial);
    const form = node("form", { class: "form" }, node("label", {}, "Definition", definition),
      node("p", { class: "muted" }, 'Give it a name and collection; columns lists the source fields to filter or order by. Optional analyzer: { "fields": ["title"], "version": 1 }. You can also declare shards, spatial, embedding and non-unique composite indexes over source fields.'),
      node("button", { type: "submit", class: "primary" }, "Create index"));
    form.addEventListener("submit", event => { event.preventDefault(); context.run(parse(definition.value).pipe(Effect.flatMap(body => request(api, "POST", body))), result => {
      setFlash(`Created index ${label(object(result).name)}.`);
      context.setSearch({ index: label(object(result).name, ""), definition: undefined, query: undefined, after: undefined });
    }); });
    content.push(card("Create an index", form));
  }
  return page(...content);
});
