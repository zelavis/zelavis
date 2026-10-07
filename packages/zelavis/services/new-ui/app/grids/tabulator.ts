import { TabulatorFull as Tabulator, type CellComponent, type RowComponent, type ColumnDefinition, type EmptyCallback } from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator.min.css";
import { cellText, cellValue, editText, type GridAdapterOptions } from "./model.ts";
export async function mount(host: HTMLElement, options: GridAdapterOptions) {
  let current = options;
  const rowsFor = (options: GridAdapterOptions) => options.data.records.map(record => Object.fromEntries(options.data.columns.map(column => [column.field, cellValue(record, column)])));
  const columnsFor = (options: GridAdapterOptions): ColumnDefinition[] => options.data.columns.map(column => ({ title: column.label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"), field: column.field, width: column.key === undefined ? 200 : 180, frozen: column.key === undefined, headerSort: false,
    formatter(cell: CellComponent) { const span = document.createElement("span"); span.textContent = cellText(cell.getValue()); return span; },
    ...(column.key === undefined ? {} : {
      editable: () => !current.readonly,
      editor(cell: CellComponent, onRendered: EmptyCallback, success: (value: unknown) => void, cancel: (value: unknown) => void) {
        const input = document.createElement("input"); input.value = editText(cell.getValue()); input.setAttribute("aria-label", `Edit ${column.label} as JSON`);
        let finished = false;
        const commit = () => { if (!finished) { finished = true; success(input.value); } };
        input.addEventListener("keydown", event => { if (event.key === "Enter") commit(); if (event.key === "Escape") { finished = true; cancel(cell.getValue()); } });
        input.addEventListener("blur", commit); onRendered(() => { input.focus(); input.select(); }); return input;
      },
      cellEdited(cell: CellComponent) { current.onEdit(String(cell.getRow().getData().id), column.key!, String(cell.getValue())); }
    })
  }));
  const table = new Tabulator(host, { data: rowsFor(options), columns: columnsFor(options), index: "id", height: 440, layout: "fitData", movableColumns: true, selectableRows: 1 });
  table.on("rowClick", (_event: UIEvent, row: RowComponent) => current.onSelect(String(row.getData().id)));
  table.on("tableBuilt", () => { if (options.selectedId) table.selectRow(options.selectedId); });
  let rendered = JSON.stringify(rowsFor(options));
  return { async update(next: GridAdapterOptions) {
    const schemaChanged = JSON.stringify(current.data.columns) !== JSON.stringify(next.data.columns);
    current = next;
    if (schemaChanged) table.setColumns(columnsFor(next));
    const rows = rowsFor(next), serialized = JSON.stringify(rows);
    if (serialized !== rendered) { await table.replaceData(rows); rendered = serialized; }
    if (next.selectedId) table.selectRow(next.selectedId);
  }, dispose() { table.destroy(); } };
}
