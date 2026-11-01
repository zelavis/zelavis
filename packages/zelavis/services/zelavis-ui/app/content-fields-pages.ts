import { Effect } from "effect";
import { array, object, request, type Config } from "./api.ts";
import { node } from "./dom.ts";
import type { ScreenContext } from "./screens.ts";

/** Content type → Fields: the schema builder island is given the schema versions and the type's preferences. */
export const fieldsScreen = Effect.fn("ui.contentFields")(function*(_context: ScreenContext, scoped: Config, studio: { api: string; base: string; preferences: unknown }, type: string) {
  const tenant = "zelavis-app";
  const api = scoped.api.basePath;
  const schemas = object(yield* request(`${api}/database/schemas/${encodeURIComponent(type)}?tenantId=${encodeURIComponent(tenant)}`));
  const collections = array(object(yield* request(`${api}/database/documents/collections?tenantId=${encodeURIComponent(tenant)}`)).collections).map(object);
  const documentCount = Number(collections.find(collection => collection.name === type)?.documentCount) || 0;
  const island = document.createElement("fuzor-island");
  island.setAttribute("src", "schema-builder");
  island.setAttribute("props", JSON.stringify({ api, tenant, contentType: type, studioBase: studio.base, schemasJson: JSON.stringify(array(schemas.schemas)), documentCount, preferences: studio.preferences }));
  return node("div", {}, island);
});
