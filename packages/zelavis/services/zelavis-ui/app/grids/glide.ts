import * as Effect from "effect/Effect";
import { createElement, useState } from "react";
import { DataEditor, GridCellKind, GridColumnIcon, type GridCell, type Item, type Theme } from "@glideapps/glide-data-grid";
import { reactIsland } from "fuzor/islands/react";
import "@glideapps/glide-data-grid/dist/index.css";
import { cellText, cellValue, columnKind, columnWidth, editText, type ColumnKind, type GridAdapterOptions } from "./model.ts";

// Keep the isolated React 18 island typed against its own runtime, even when vendor declarations resolve host React types.
const CanvasEditor = DataEditor as unknown as import("react").ComponentType<Parameters<typeof DataEditor>[0]>;
const headerIcons: Record<ColumnKind, GridColumnIcon> = {
  id: GridColumnIcon.HeaderRowID, number: GridColumnIcon.HeaderNumber, boolean: GridColumnIcon.HeaderBoolean,
  string: GridColumnIcon.HeaderString, structure: GridColumnIcon.HeaderCode, mixed: GridColumnIcon.HeaderString, empty: GridColumnIcon.HeaderString,
};
/** The grid follows the dashboard's own colors, so light and dark both read as part of the page. */
function dashboardTheme(): Partial<Theme> {
  const root = document.documentElement, style = getComputedStyle(root);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const text = style.color || "#202124", surface = read("--surface", "#fff"), border = read("--border", "#e4e4e7"), muted = read("--muted", "#737373"), hover = read("--hover", "#f1f1f3");
  return {
    bgCell: surface, bgCellMedium: hover, bgHeader: hover, bgHeaderHasFocus: hover, bgHeaderHovered: border, bgBubble: hover, bgBubbleSelected: hover,
    textDark: text, textMedium: muted, textLight: muted, textHeader: muted, textHeaderSelected: surface, textBubble: text,
    borderColor: border, horizontalBorderColor: border, drilldownBorder: border, accentColor: read("--accent", "#27272a"), accentLight: hover,
    fontFamily: style.fontFamily, baseFontStyle: "13px", headerFontStyle: "600 12px", editorFontSize: "13px",
  };
}
const faded = (theme: Partial<Theme>) => ({ textDark: theme.textLight as string });
function Grid(props: GridAdapterOptions) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const theme = dashboardTheme();
  const kinds = props.data.columns.map(column => columnKind(props.data.records, column));
  const getCellContent = ([col, row]: Item): GridCell => {
    const record = props.data.records[row]; const column = props.data.columns[col];
    const value = cellValue(record, column);
    if (column.key === undefined) return { kind: GridCellKind.Text, data: record.id, displayData: record.id, allowOverlay: true, readonly: true };
    const readonly = props.readonly;
    if (typeof value === "boolean") return { kind: GridCellKind.Boolean, data: value, allowOverlay: false, readonly };
    if (typeof value === "number") return { kind: GridCellKind.Number, data: value, displayData: String(value), allowOverlay: true, readonly, contentAlign: "right", allowNegative: true, thousandSeparator: false };
    // Strings edit as plain text; every other value edits as its JSON literal so null, missing and structures keep their type.
    if (typeof value === "string") return { kind: GridCellKind.Text, data: value, displayData: value, allowOverlay: true, readonly };
    return { kind: GridCellKind.Text, data: editText(value), displayData: cellText(value), allowOverlay: true, readonly, ...(value === undefined || value === null ? { themeOverride: faded(theme) } : {}) };
  };
  const sorted = (col: number) => props.sort && props.data.columns[col]?.key === props.sort.path ? props.sort.direction : undefined;
  return createElement(CanvasEditor, {
    columns: props.data.columns.map((column, col) => ({ id: column.field, title: `${column.label}${sorted(col) === "asc" ? " ↑" : sorted(col) === "desc" ? " ↓" : ""}`, icon: headerIcons[kinds[col]], width: widths[column.field] ?? columnWidth(props.data.records, column) })),
    rows: props.data.records.length, getCellContent, getCellsForSelection: true, copyHeaders: true, theme,
    width: "100%", height: 440, freezeColumns: 1, rowMarkers: "number", rowHeight: 34, headerHeight: 36,
    onHeaderClicked: (col: number) => { const column = props.data.columns[col]; if (column?.key !== undefined) props.onSort(column.key); },
    onCellClicked: ([, row]: Item) => { const record = props.data.records[row]; if (record) props.onSelect(record.id); },
    onCellActivated: ([, row]: Item) => { const record = props.data.records[row]; if (record) props.onSelect(record.id); },
    onCellEdited: ([col, row]: Item, value: { kind: GridCellKind; data?: unknown }) => {
      const record = props.data.records[row]; const column = props.data.columns[col];
      if (!record || column.key === undefined) return;
      const original = cellValue(record, column);
      if (value.kind === GridCellKind.Boolean) props.onEdit(record.id, column.key, typeof value.data === "boolean" ? String(value.data) : "null");
      else if (value.kind === GridCellKind.Number) props.onEdit(record.id, column.key, typeof value.data === "number" ? JSON.stringify(value.data) : "null");
      else if (value.kind === GridCellKind.Text) props.onEdit(record.id, column.key, typeof original === "string" ? JSON.stringify(String(value.data ?? "")) : String(value.data ?? ""));
    },
    onColumnResize: (column, width) => setWidths(previous => ({ ...previous, [column.id!]: width })),
  });
}
export function mount(host: HTMLElement, options: GridAdapterOptions, signal?: AbortSignal) {
  return Effect.runPromise(Effect.gen(function* () {
  const ownedPortal = !document.getElementById("portal");
  const portal = ownedPortal ? document.createElement("div") : document.getElementById("portal")!;
  if (ownedPortal) { portal.id = "portal"; document.body.append(portal); }
  let mounted = false;
  yield* Effect.addFinalizer(() => Effect.sync(() => { if (!mounted && ownedPortal) portal.remove(); }));
    const client = yield* Effect.tryPromise({ try: signal => reactIsland(Grid).mountPersistent(host, options, { signal }), catch: cause => cause });
    mounted = true;
    return { update(next: GridAdapterOptions) { return client.update(next); }, dispose() { void client.dispose(); if (ownedPortal) portal.remove(); } };
  }).pipe(Effect.scoped), signal ? { signal } : undefined);
}
