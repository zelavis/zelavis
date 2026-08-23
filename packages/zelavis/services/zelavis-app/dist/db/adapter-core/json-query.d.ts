import type { DatabaseDocumentFilter, DatabaseDocumentSort } from "../contracts/documents.js";
/**
 * Translates a `where`/`orderBy` pair against the documents table into a
 * SQL fragment that uses `json_extract(data_json, '$.path')` for pushdown.
 *
 * SQLite (better-sqlite3, bun:sqlite) and libSQL all
 * implement the JSON1 extension, so this produces the same SQL across every
 * adapter. The result still feeds a parameterized statement — paths are
 * validated against a strict regex and inlined; values flow through bind
 * parameters.
 */
export interface DocumentQueryFragment {
    /** Extra SQL appended after `WHERE tenant_id = ? AND collection_name = ?`. */
    whereSql: string;
    /** Bind parameters in declaration order. */
    whereParams: unknown[];
    /** ORDER BY clause including the keyword, or an empty string. */
    orderSql: string;
}
export declare function buildDocumentQueryFragment(where: readonly DatabaseDocumentFilter[], orderBy: readonly DatabaseDocumentSort[]): DocumentQueryFragment;
