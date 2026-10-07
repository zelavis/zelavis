import { ListTable } from "@visactor/vtable";
import { InputEditor } from "@visactor/vtable-editors";
import { cellText, cellValue, editText, type GridAdapterOptions } from "./model.ts";
function safeText(raw: string) { try { return cellText(JSON.parse(raw)); } catch { return raw; } }
export async function mount(host: HTMLElement, options: GridAdapterOptions) {
  let current = options;
  const editor = new InputEditor();
  host.style.height = "440px";
  const rowsFor = (options: GridAdapterOptions) => options.data.records.map(record => Object.fromEntries(options.data.columns.map(column => [column.field, column.key === undefined ? record.id : editText(cellValue(record, column))])));
  const columnsFor = (options: GridAdapterOptions) => options.data.columns.map(column => ({ field: column.field, title: column.label, width: column.key === undefined ? 200 : 180,
      fieldFormat: (record: Record<string, unknown>) => { if (column.key === undefined) return record.id; const raw = record[column.field]; return raw === "" ? "(missing)" : safeText(String(raw)); },
      ...(!options.readonly && column.key !== undefined ? { editor } : {})
    }));
  const table = new ListTable(host, {
    records: rowsFor(options), columns: columnsFor(options),
    frozenColCount: 1, defaultRowHeight: 36, defaultHeaderRowHeight: 40,
    keyboardOptions: { moveFocusCellOnTab: true, moveFocusCellOnEnter: false, copySelected: true, editCellOnEnter: true },
    // Keydown preparation queues an uncancellable vendor timer. Enter still opens
    // the editor through editCellOnEnter, without eager preparation on selection.
    editCellTrigger: "doubleclick",
  });
  const selected = (args: { col: number; row: number }) => {
    if (args.row < 1) return;
    const record = table.getCellOriginRecord(args.col, args.row) as Record<string, unknown> | undefined;
    if (record?.id) current.onSelect(String(record.id));
  };
  table.on("click_cell", selected); table.on("selected_cell", selected);
  table.on("change_cell_value", args => {
    const column = current.data.columns[args.col];
    const record = table.getCellOriginRecord(args.col, args.row) as Record<string, unknown>;
    if (!current.readonly && column?.key !== undefined && record?.id) current.onEdit(String(record.id), column.key, String(args.changedValue));
  });
  if (options.selectedId) { const index = options.data.records.findIndex(record => record.id === options.selectedId); if (index >= 0) table.selectCell(0, index + 1); }
  const observer = new ResizeObserver(() => { table.resize(); }); observer.observe(host);
  let rendered = JSON.stringify(rowsFor(options));
  return { update(next: GridAdapterOptions) {
    const schemaChanged = JSON.stringify(current.data.columns) !== JSON.stringify(next.data.columns) || current.readonly !== next.readonly;
    current = next;
    if (schemaChanged) table.updateColumns(columnsFor(next), { clearColWidthCache: false });
    const rows = rowsFor(next), serialized = JSON.stringify(rows);
    if (serialized !== rendered) { table.setRecords(rows); rendered = serialized; }
  }, dispose() { observer.disconnect(); table.cancelEditCell(); table.release(); } };
}
