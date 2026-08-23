import type { DatabaseJson } from "./json.js";
export type SqlParameter = string | number | boolean | null | Uint8Array;
export interface SqlQueryInput {
    tenantId?: string;
    statement: string;
    parameters?: readonly SqlParameter[];
}
export interface SqlQueryResult {
    rows: Record<string, DatabaseJson | Uint8Array>[];
}
export interface SqlExecuteInput {
    tenantId?: string;
    statement: string;
    parameters?: readonly SqlParameter[];
}
export interface SqlExecuteResult {
    rowsAffected: number;
    lastInsertId?: string | number;
}
export interface SqlDatabase {
    query(input: SqlQueryInput): Promise<SqlQueryResult>;
    execute(input: SqlExecuteInput): Promise<SqlExecuteResult>;
}
