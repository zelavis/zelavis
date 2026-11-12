export type GridRecord = { id: string; data: Record<string, unknown>; version?: number };
export type GridColumn = { field: string; label: string; key?: string };
export type GridData = { records: GridRecord[]; columns: GridColumn[] };
export function gridData(values: unknown[]): GridData {
  const ids = new Set<string>();
  const records = values.map(value => {
    if (!value || typeof value !== "object") throw new Error("Invalid database record.");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || ids.has(row.id) || !row.data || typeof row.data !== "object" || Array.isArray(row.data)) throw new Error("Invalid or duplicate database record.");
    ids.add(row.id);
    return { id: row.id, data: row.data as Record<string, unknown>, ...(typeof row.version === "number" ? { version: row.version } : {}) };
  });
  const keys = [...new Set(records.flatMap(row => Object.keys(row.data)))].sort();
  return { records, columns: [{ field: "id", label: "Record ID" }, ...keys.map(key => ({ field: `f_${Array.from(key, char => char.codePointAt(0)!.toString(16)).join("_")}`, label: key, key }))] };
}
/** What a column mostly holds, from the loaded rows: null and missing values do not decide it, and a column mixing types is `mixed`. */
export type ColumnKind = "id" | "number" | "boolean" | "string" | "structure" | "mixed" | "empty";
export function columnKind(records: readonly GridRecord[], column: GridColumn): ColumnKind {
  if (column.key === undefined) return "id";
  let kind: ColumnKind = "empty";
  for (const record of records) {
    const value = cellValue(record, column);
    if (value === undefined || value === null) continue;
    const next: ColumnKind = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "string" ? "string" : "structure";
    if (kind === "empty") kind = next; else if (kind !== next) return "mixed";
  }
  return kind;
}
/** A width in pixels that fits the header and a sample of the loaded values, bounded so one long value cannot take the screen. */
export function columnWidth(records: readonly GridRecord[], column: GridColumn): number {
  let longest = column.label.length + 4;
  for (const record of records.slice(0, 50)) longest = Math.max(longest, Math.min(cellText(cellValue(record, column)).length, 48));
  return Math.max(96, Math.min(360, Math.round(longest * 7.4 + 28)));
}
export function cellValue(row: GridRecord, column: GridColumn): unknown { return column.key === undefined ? row.id : Object.hasOwn(row.data, column.key) ? row.data[column.key] : undefined; }
export function cellText(value: unknown): string { return value === undefined ? "(missing)" : typeof value === "string" ? value : JSON.stringify(value); }
/** Editors use JSON literals so strings, booleans, numbers, null and structures retain their types. */
export function editText(value: unknown): string { return value === undefined ? "" : JSON.stringify(value); }
export function parseEdit(text: string): unknown {
  if (text.length > 1048576) throw new Error("A cell exceeds the editor size limit.");
  if (!text.trim()) throw new Error('Use a JSON value: "text", 42, true, null, [] or {}.');
  return JSON.parse(text, (_key, value: unknown) => { if (typeof value === "number" && !Number.isFinite(value)) throw new Error("JSON numbers must be finite."); return value; });
}
export function changedRecord(row: GridRecord, key: string, value: unknown): GridRecord {
  return { ...row, data: { ...row.data, [key]: value } };
}
/** The operators the Documents query accepts for a single field, as offered by the filter control. */
export const filterOperators = ["eq", "ne", "gt", "gte", "lt", "lte"] as const;
export type FilterOperator = typeof filterOperators[number];
export type GridFilter = { path: string; op: FilterOperator; value: unknown };
export type GridSort = { path: string; direction: "asc" | "desc" };
/** A filter value is a JSON literal when it parses, otherwise the text itself, so `5` is a number and `draft` a string. */
export function filterValue(text: string): unknown { try { return parseEdit(text); } catch { return text; } }
export function parseFilter(raw: string | null): GridFilter | undefined {
  if (!raw) return undefined;
  const [path, op, ...rest] = raw.split("|");
  if (!path || !filterOperators.includes(op as FilterOperator) || !rest.length) return undefined;
  return { path, op: op as FilterOperator, value: filterValue(rest.join("|")) };
}
export function filterParam(path: string, op: FilterOperator, text: string): string { return `${path}|${op}|${text}`; }
export function parseSort(raw: string | null): GridSort | undefined {
  if (!raw) return undefined;
  const at = raw.lastIndexOf(":"), direction = raw.slice(at + 1);
  if (at < 1 || (direction !== "asc" && direction !== "desc")) return undefined;
  return { path: raw.slice(0, at), direction };
}
/** Hidden columns are field names in the URL as a JSON array, so a name containing any character survives. */
export function parseHidden(raw: string | null): string[] {
  if (!raw) return [];
  try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))].slice(0, 200) : []; } catch { return []; }
}
export function hiddenParam(hidden: readonly string[]): string | undefined { return hidden.length ? JSON.stringify(hidden) : undefined; }
export function pageNumber(value: string | null, fallback: number, maximum: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.min(maximum, Number(value));
}
export interface GridAdapterOptions extends Record<string, unknown> {
  data: GridData;
  sort?: GridSort;
  onSort(key: string): void;
  readonly: boolean;
  selectedId?: string;
  onSelect(id: string): void;
  onEdit(id: string, key: string, text: string): void;
}
export interface GridAdapter { update(options: GridAdapterOptions): void | Promise<void>; dispose(): void; }
