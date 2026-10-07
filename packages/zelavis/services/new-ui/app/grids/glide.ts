import { createElement, useState } from "react";
import { DataEditor, GridCellKind, type GridCell, type Item } from "@glideapps/glide-data-grid";
import { reactIsland } from "fuzor/islands/react";
import "@glideapps/glide-data-grid/dist/index.css";
import { cellText, cellValue, editText, type GridAdapterOptions } from "./model.ts";

// Keep the isolated React 18 island typed against its own runtime, even when vendor declarations resolve host React types.
const CanvasEditor = DataEditor as unknown as import("react").ComponentType<Parameters<typeof DataEditor>[0]>;
function Grid(props: GridAdapterOptions) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const getCellContent = ([col, row]: Item): GridCell => {
    const record = props.data.records[row]; const column = props.data.columns[col];
    const value = cellValue(record, column);
    return { kind: GridCellKind.Text, data: column.key === undefined ? record.id : editText(value), displayData: cellText(value), allowOverlay: true, readonly: props.readonly || column.key === undefined };
  };
  return createElement(CanvasEditor, {
    columns: props.data.columns.map(column => ({ id: column.field, title: column.label, width: widths[column.field] ?? (column.key === undefined ? 200 : 180) })),
    rows: props.data.records.length, getCellContent, getCellsForSelection: true, copyHeaders: true,
    width: "100%", height: 440, freezeColumns: 1, rowMarkers: "number", rowHeight: 36,
    onCellClicked: ([, row]: Item) => { const record = props.data.records[row]; if (record) props.onSelect(record.id); },
    onCellActivated: ([, row]: Item) => { const record = props.data.records[row]; if (record) props.onSelect(record.id); },
    onCellEdited: ([col, row]: Item, value: { kind: GridCellKind; data?: unknown }) => {
      const record = props.data.records[row]; const column = props.data.columns[col];
      if (record && column.key !== undefined && value.kind === GridCellKind.Text) props.onEdit(record.id, column.key, String(value.data ?? ""));
    },
    onColumnResize: (column, width) => setWidths(previous => ({ ...previous, [column.id!]: width })),
  });
}
export async function mount(host: HTMLElement, options: GridAdapterOptions) {
  const ownedPortal = !document.getElementById("portal");
  const portal = ownedPortal ? document.createElement("div") : document.getElementById("portal")!;
  if (ownedPortal) { portal.id = "portal"; document.body.append(portal); }
  try {
    const client = await reactIsland(Grid).mountPersistent(host, options);
    return { update(next: GridAdapterOptions) { return client.update(next); }, dispose() { void client.dispose(); if (ownedPortal) portal.remove(); } };
  } catch (error) { if (ownedPortal) portal.remove(); throw error; }
}
