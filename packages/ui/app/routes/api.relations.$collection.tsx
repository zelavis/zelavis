import { getRuntimeConfig, queryDatabaseDocuments } from "#/lib/runtime-api";
import type { Route } from "./+types/api.relations.$collection";

// Resource route — no component, only a clientLoader used by useFetcher in RelationFieldInput
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const runtime = await getRuntimeConfig();
  const documents = await queryDatabaseDocuments(runtime, params.collection).catch(() => []);
  return { documents };
}
