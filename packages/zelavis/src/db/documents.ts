/**
 * The documents API: collections of JSON documents over one tenant's partition.
 *
 * The definition is split by concern — the public shapes (`document-model.ts`),
 * how records are named and stored (`document-records.ts`), what a document
 * contributes to the lenses (`document-indexing.ts`), a collection's checked
 * declarations (`document-definitions.ts`), how a read is planned
 * (`document-planner.ts`) — and the API itself is three layers over one
 * tenant's store: the shared core (`document-core.ts`), the reads
 * (`document-reads.ts`) and the writes (`document-writes.ts`).
 */
import type { DocumentsApi } from "./document-model.js";
import { documentCore } from "./document-core.js";
import { documentReads } from "./document-reads.js";
import { documentWrites } from "./document-writes.js";
import type { SchemasApi } from "./schemas.js";
import type { ObjectStoreApi } from "./store.js";
import type { TenantId } from "./topology.js";

export type { Json, JsonObject } from "./json.js";
export { collectionModalities } from "./document-model.js";
export type { CollectionSurface, Collection, CollectionModalities, SpatialIndex, EmbeddingIndex, EdgeDefinition, MeasureDefinition, Analyzer, ReferenceConstraint, CheckConstraint, HighlightOptions, Document, FilterOperator, DocumentFilter, NullPlacement, DocumentSort, IndexField, IndexDefinition, CollectionIndex, SimilarFilter, LinkFilter, TraverseInput, TraverseStep, TraverseResult, MeasureOperation, SummarizeInput, Summary, GroupedSummary, FindDocumentsInput, SpatialFilter, RelatedFilter, DocumentWrite, DocumentWritten, RelatedDocuments, DocumentCursor, FindPageInput, DocumentPage, DocumentsApi } from "./document-model.js";
export { compareDocuments } from "./document-planner.js";
export { documentRecord, collectionRecord } from "./document-records.js";

/**
 * The document API for one tenant on one shard.
 *
 * Takes the store directly rather than from context because a tenant's shard is
 * chosen by the partition map at call time, not by what happens to be provided.
 */
export const documentsFor = (
  store: ObjectStoreApi,
  tenant: TenantId,
  schemas?: SchemasApi,
): DocumentsApi => {
  const core = documentCore(store, tenant, schemas);
  const reads = documentReads(core);
  const writes = documentWrites(core, reads);
  return { ...reads.operations, ...writes.operations } satisfies DocumentsApi;
};
