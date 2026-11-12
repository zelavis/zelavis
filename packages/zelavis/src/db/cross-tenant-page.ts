/** Merge bounded derived-index pages; source Tenant partitions are never queried. */
import { Effect } from "effect";
import { CursorMismatch } from "./errors.js";
import { compareDocuments } from "./document-planner.js";
import type { DocumentsApi } from "./documents.js";
import type { Document, DocumentCursor, DocumentPage, FindPageInput } from "./document-model.js";

const CHUNK = 128;
const MAX_CURSOR = 512 * 1024;

export const crossTenantPage = (
  documents: ReadonlyArray<DocumentsApi>,
  query: Omit<FindPageInput, "after" | "cursors" | "limit">,
  identity: string,
  input: { readonly limit?: number; readonly after?: DocumentCursor },
) => Effect.gen(function* () {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be an integer from 1 to 1000");
  const positions = yield* Effect.try({
    try: (): Array<DocumentCursor | undefined> => {
      if (input.after === undefined) return documents.map(() => undefined);
      if (typeof input.after !== "string" || input.after.length > MAX_CURSOR) throw new Error("cursor exceeds its size bound");
      const parsed: unknown = JSON.parse(Buffer.from(input.after, "base64url").toString("utf8"));
      if (!parsed || typeof parsed !== "object" || !("v" in parsed) || parsed.v !== 1 || !("identity" in parsed) || parsed.identity !== identity || !("positions" in parsed) || !Array.isArray(parsed.positions) || parsed.positions.length !== documents.length || !parsed.positions.every(item => item === null || typeof item === "string")) throw new Error("cursor belongs to another index, query or shard set");
      return parsed.positions.map(item => item === null ? undefined : item as DocumentCursor);
    },
    catch: cause => new CursorMismatch({ reason: cause instanceof Error ? cause.message : "invalid cross-Tenant cursor" }),
  });
  const states: Array<{ page?: DocumentPage; offset: number; ended: boolean }> = documents.map(() => ({ offset: 0, ended: false }));
  const fill = (index: number) => Effect.gen(function* () {
    const state = states[index];
    if (state.ended || (state.page !== undefined && state.offset < state.page.documents.length)) return;
    if (state.page !== undefined && state.page.next === undefined) { state.ended = true; return; }
    state.page = yield* documents[index].findPage({
      ...query, limit: Math.min(limit + 1, CHUNK), cursors: true,
      ...(positions[index] === undefined ? {} : { after: positions[index] }),
    });
    state.offset = 0;
    state.ended = state.page.documents.length === 0;
  });
  for (let i = 0; i < documents.length; i++) yield* fill(i);
  const order = query.similar !== undefined ? [{ path: "$score", direction: "desc" as const }]
    : query.geometry !== undefined && "near" in query.geometry && (query.orderBy?.length ?? 0) === 0 ? [{ path: "$distance" }] : query.orderBy ?? [];
  const compare = compareDocuments(order);
  const found: Document[] = [];
  while (found.length < limit) {
    let best = -1;
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      if (state.ended || state.page === undefined) continue;
      if (best === -1 || compare(state.page.documents[state.offset], states[best].page!.documents[states[best].offset]) < 0) best = i;
    }
    if (best === -1) break;
    const state = states[best];
    const cursor = state.page!.cursors?.[state.offset];
    if (cursor === undefined) return yield* Effect.die(new Error("derived index page omitted its requested continuation"));
    found.push(state.page!.documents[state.offset]);
    positions[best] = cursor;
    state.offset += 1;
    yield* fill(best);
  }
  const more = states.some(state => !state.ended && state.page !== undefined && state.offset < state.page.documents.length);
  return {
    documents: found,
    ...(more ? { next: Buffer.from(JSON.stringify({ v: 1, identity, positions: positions.map(position => position ?? null) })).toString("base64url") as DocumentCursor } : {}),
  };
});
