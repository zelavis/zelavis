export const gridLibraries = ["glide", "tabulator", "vtable"] as const;
export type GridLibrary = typeof gridLibraries[number];
export type GridRecord = { id: string; data: Record<string, unknown>; version?: number };
export type GridColumn = { field: string; label: string; key?: string };
export type GridData = { records: GridRecord[]; columns: GridColumn[] };
export function gridLibrary(value: string | null): GridLibrary { return gridLibraries.includes(value as GridLibrary) ? value as GridLibrary : "glide"; }
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
export function pageNumber(value: string | null, fallback: number, maximum: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.min(maximum, Number(value));
}
export interface GridAdapterOptions extends Record<string, unknown> {
  data: GridData;
  readonly: boolean;
  selectedId?: string;
  onSelect(id: string): void;
  onEdit(id: string, key: string, text: string): void;
}
export interface GridAdapter { update(options: GridAdapterOptions): void | Promise<void>; dispose(): void; }
