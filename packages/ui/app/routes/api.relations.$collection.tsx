import { getActiveRuntimeConfig, queryDatabaseDocuments } from "#/lib/runtime-api";
import type { Route } from "./+types/api.relations.$collection";

// Resource route — no component, only a clientLoader used by useFetcher in RelationFieldInput
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const documents = await queryDatabaseDocuments(runtime, params.collection).catch(() => []);
  return { documents };
}
