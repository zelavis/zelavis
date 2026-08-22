import { useLoaderData, useRevalidator, useRouteLoaderData } from "react-router";
import {
  DataEditor,
  type DataEditorProps,
  type GridCell,
  type GridColumn,
  type Item,
} from "@glideapps/glide-data-grid";
import { Pin, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CodeEditor } from "#/components/code/CodeEditor";
import { ResourceNotice } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "#/components/ui/sheet";
import {
  getActiveRuntimeConfig,
  insertDatabaseDocument,
  queryDatabaseDocuments,
  queryDatabaseSystemTable,
} from "#/lib/runtime-api";
import { parseAsString, parseAsStringLiteral, useTypedSearchParams } from "#/lib/use-typed-search-params";
import type { clientLoader as rootClientLoader } from '../root';
import { cn } from "#/lib/utils";

export const handle = {
  pageLabel: "Database",
  sidebarTrail: ["Backend", "Database"],
} as const;

export async function clientLoader({ request }: import("./+types/database").Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const url = new URL(request.url);
  const databaseTable = url.searchParams.get('databaseTable') || undefined;
  const systemTable = url.searchParams.get('systemTable') || undefined;

  const [systemRows, tableRows] = await Promise.all([
    systemTable ? queryDatabaseSystemTable(runtime, systemTable as Parameters<typeof queryDatabaseSystemTable>[1], { limit: 100 }).catch(() => []) : Promise.resolve([]),
    databaseTable ? queryDatabaseDocuments(runtime, databaseTable).catch(() => []) : Promise.resolve([]),
  ]);

  return { systemRows, tableRows };
}

type DatabaseGridRow = {
  id: string;
  version?: number;
  updatedAt?: string;
  data: Record<string, unknown>;
};

type DatabaseSystemTableName =
  | "zv_collections"
  | "zv_events"
  | "zv_schemas"
  | "zv_time_series_checkpoints"
  | "zv_time_series_points";

type DatabaseGridSorting = {
  id: string;
  desc: boolean;
};

type SavedDatabaseView = {
  name: string;
  target: string;
  columnVisibility: Record<string, boolean>;
  pinnedColumns: string[];
  columnSizing: Record<string, number>;
  columnOrder: string[];
  sorting: DatabaseGridSorting[];
  globalFilter: string;
};

const DATABASE_GRID_VIEWS_STORAGE_KEY = "zelavis:database-grid-views";
const ACTIONS_COLUMN = "__zelavis_actions";
const DATABASE_SYSTEM_TABLES = [
  "zv_collections",
  "zv_events",
  "zv_schemas",
  "zv_time_series_checkpoints",
  "zv_time_series_points",
] as const satisfies readonly DatabaseSystemTableName[];
const DEFAULT_SYSTEM_TABLE: DatabaseSystemTableName = "zv_collections";

function readSystemTableName(value: unknown): DatabaseSystemTableName {
  return typeof value === "string" &&
    DATABASE_SYSTEM_TABLES.includes(value as DatabaseSystemTableName)
    ? (value as DatabaseSystemTableName)
    : DEFAULT_SYSTEM_TABLE;
}

function isSystemTableName(value: unknown): value is DatabaseSystemTableName {
  return (
    typeof value === "string" &&
    DATABASE_SYSTEM_TABLES.includes(value as DatabaseSystemTableName)
  );
}

function parseSavedDatabaseViews(value: unknown): SavedDatabaseView[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is SavedDatabaseView => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    const view = entry as Partial<SavedDatabaseView>;
    return typeof view.name === "string" && typeof view.target === "string";
  });
}

function renderRawCellValue(value: unknown) {
  if (value === undefined) {
    return "-";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function getColumnTitle(column: string) {
  if (column === ACTIONS_COLUMN) {
    return "";
  }
  if (column === "id") {
    return "ID";
  }
  return column;
}

function readRowValue(row: DatabaseGridRow, column: string): unknown {
  if (column === ACTIONS_COLUMN) {
    return "";
  }
  if (column === "id") {
    return row.id;
  }
  return row.data[column];
}

function createTextCell(value: unknown, readonly: boolean): GridCell {
  const displayData = renderRawCellValue(value);

  return {
    kind: "text",
    allowOverlay: true,
    readonly,
    data: displayData,
    displayData,
  } as GridCell;
}

function createCell(value: unknown, readonly: boolean): GridCell {
  if (typeof value === "number") {
    return {
      kind: "number",
      allowOverlay: true,
      readonly,
      data: value,
      displayData: String(value),
    } as GridCell;
  }

  if (typeof value === "boolean") {
    return {
      kind: "boolean",
      allowOverlay: false,
      readonly,
      data: value,
    } as GridCell;
  }

  return createTextCell(value, readonly);
}

function createActionCell(): GridCell {
  return {
    kind: "text",
    allowOverlay: false,
    readonly: true,
    data: "Edit",
    displayData: "Edit",
    contentAlign: "center",
    cursor: "pointer",
  } as GridCell;
}

function compareValues(left: unknown, right: unknown) {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return renderRawCellValue(left).localeCompare(renderRawCellValue(right));
}

function DatabaseDataGrid(props: {
  collection: string;
  rows: DatabaseGridRow[];
  columns: string[];
  target: string;
  selectedRowId?: string;
  activeSavedViewName?: string;
  createEnabled?: boolean;
  createError?: string;
  createPending?: boolean;
  onSelectRow: (id: string) => void;
  onClearSelectedRow: () => void;
  onCreateRow?: (input: {
    id?: string;
    data: Record<string, unknown>;
  }) => Promise<void>;
  onSavedViewNameChange?: (name?: string) => void;
  onActivateSavedViewTarget?: (target: string, viewName?: string) => void;
}) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [sorting, setSorting] = useState<DatabaseGridSorting[]>([]);
  const [pinnedColumns, setPinnedColumns] = useState<string[]>([]);
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({});
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailDraft, setDetailDraft] = useState("");
  const [detailError, setDetailError] = useState<string>();
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [createIdDraft, setCreateIdDraft] = useState("");
  const [createDataDraft, setCreateDataDraft] = useState("{}");
  const [createDraftError, setCreateDraftError] = useState<string>();
  const [savedViews, setSavedViews] = useState<SavedDatabaseView[]>([]);
  const [viewNameDraft, setViewNameDraft] = useState("");
  const storageKey = `zelavis:database-grid:${props.collection}`;

  const allColumnKeys = useMemo(
    () => [ACTIONS_COLUMN, "id", ...props.columns],
    [props.columns],
  );

  const visibleColumnKeys = useMemo(() => {
    const known = new Set(allColumnKeys);
    const ordered = [
      ACTIONS_COLUMN,
      "id",
      ...pinnedColumns.filter((column) => known.has(column) && column !== "id"),
      ...columnOrder.filter(
        (column) =>
          known.has(column) &&
          column !== "id" &&
          column !== ACTIONS_COLUMN &&
          !pinnedColumns.includes(column),
      ),
      ...allColumnKeys.filter(
        (column) =>
          column !== "id" &&
          column !== ACTIONS_COLUMN &&
          !pinnedColumns.includes(column) &&
          !columnOrder.includes(column),
      ),
    ];

    return ordered.filter(
      (column) =>
        column === "id" ||
        column === ACTIONS_COLUMN ||
        columnVisibility[column] !== false,
    );
  }, [allColumnKeys, columnOrder, columnVisibility, pinnedColumns]);

  const filteredRows = useMemo(() => {
    const normalizedFilter = globalFilter.trim().toLowerCase();
    const rows = normalizedFilter
      ? props.rows.filter((row) =>
          `${row.id} ${allColumnKeys
            .map((column) => renderRawCellValue(readRowValue(row, column)))
            .join(" ")}`
            .toLowerCase()
            .includes(normalizedFilter),
        )
      : props.rows;

    const activeSort = sorting[0];
    if (!activeSort) {
      return rows;
    }

    return [...rows].sort((left, right) => {
      const result = compareValues(
        readRowValue(left, activeSort.id),
        readRowValue(right, activeSort.id),
      );
      return activeSort.desc ? -result : result;
    });
  }, [allColumnKeys, globalFilter, props.rows, sorting]);

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      visibleColumnKeys.map((column) => {
        const activeSort = sorting.find((entry) => entry.id === column);
        const sortMarker = activeSort ? (activeSort.desc ? " ↓" : " ↑") : "";
        return {
          id: column,
          title: `${getColumnTitle(column)}${sortMarker}`,
          width:
            columnSizing[column] ??
            (column === ACTIONS_COLUMN ? 72 : column === "id" ? 220 : 180),
          icon:
            column === ACTIONS_COLUMN
              ? "headerCode"
              : column === "id"
                ? "headerRowID"
                : typeof readRowValue(filteredRows[0] ?? { id: "", data: {} }, column) ===
                    "number"
                    ? "headerNumber"
                    : typeof readRowValue(filteredRows[0] ?? { id: "", data: {} }, column) ===
                        "boolean"
                      ? "headerBoolean"
                      : "headerString",
        };
      }),
    [columnSizing, filteredRows, sorting, visibleColumnKeys],
  );

  const selectedRow = props.rows.find(
    (row) => row.id === props.selectedRowId,
  );

  useEffect(() => {
    if (!selectedRow) {
      setDetailDraft("");
      setDetailError(undefined);
      return;
    }

    setDetailDraft(JSON.stringify(selectedRow.data, null, 2));
    setDetailError(undefined);
  }, [selectedRow]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as Partial<SavedDatabaseView>;
      setColumnVisibility(parsed.columnVisibility ?? {});
      setPinnedColumns(parsed.pinnedColumns ?? []);
      setColumnSizing(parsed.columnSizing ?? {});
      setColumnOrder(parsed.columnOrder ?? []);
      setSorting(parsed.sorting ?? []);
      setGlobalFilter(parsed.globalFilter ?? "");
    } catch {
      // Ignore corrupt persisted grid preferences.
    }
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(DATABASE_GRID_VIEWS_STORAGE_KEY);
      setSavedViews(raw ? parseSavedDatabaseViews(JSON.parse(raw)) : []);
    } catch {
      setSavedViews([]);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        columnVisibility,
        pinnedColumns,
        columnSizing,
        columnOrder,
        sorting,
        globalFilter,
      }),
    );
  }, [
    columnOrder,
    columnSizing,
    columnVisibility,
    globalFilter,
    pinnedColumns,
    sorting,
    storageKey,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      DATABASE_GRID_VIEWS_STORAGE_KEY,
      JSON.stringify(savedViews),
    );
  }, [savedViews]);

  function saveCurrentView() {
    const trimmedName = viewNameDraft.trim();
    if (!trimmedName) {
      return;
    }

    const nextView: SavedDatabaseView = {
      name: trimmedName,
      target: props.target,
      columnVisibility,
      pinnedColumns,
      columnSizing,
      columnOrder,
      sorting,
      globalFilter,
    };

    setSavedViews((current) => {
      const withoutDuplicate = current.filter((view) => view.name !== trimmedName);
      return [...withoutDuplicate, nextView].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    });
    props.onSavedViewNameChange?.(trimmedName);
  }

  function loadSavedViewIntoState(view: SavedDatabaseView) {
    setColumnVisibility(view.columnVisibility);
    setPinnedColumns(view.pinnedColumns);
    setColumnSizing(view.columnSizing);
    setColumnOrder(view.columnOrder);
    setSorting(view.sorting);
    setGlobalFilter(view.globalFilter);
  }

  function applySavedView(name: string) {
    props.onSavedViewNameChange?.(name || undefined);
    const view = savedViews.find((entry) => entry.name === name);
    if (!view) {
      return;
    }

    if (props.target !== view.target) {
      props.onActivateSavedViewTarget?.(view.target, view.name);
      return;
    }

    loadSavedViewIntoState(view);
  }

  function deleteSavedView(name: string) {
    setSavedViews((current) => current.filter((view) => view.name !== name));
    if (props.activeSavedViewName === name) {
      props.onSavedViewNameChange?.(undefined);
    }
  }

  useEffect(() => {
    if (!props.activeSavedViewName) {
      return;
    }

    const view = savedViews.find((entry) => entry.name === props.activeSavedViewName);
    if (!view || props.target !== view.target) {
      return;
    }

    loadSavedViewIntoState(view);
  }, [props.activeSavedViewName, props.target, savedViews]);

  function getCellContent([col, row]: Item): GridCell {
    const column = visibleColumnKeys[col];
    const rowData = filteredRows[row];
    if (!column || !rowData) {
      return createTextCell(undefined, true);
    }

    if (column === ACTIONS_COLUMN) {
      return createActionCell();
    }

    if (column === "id") {
      return {
        kind: "row-id",
        allowOverlay: false,
        readonly: true,
        data: rowData.id,
      } as GridCell;
    }

    const value = readRowValue(rowData, column);
    return createCell(value, true);
  }

  function toggleSort(column: string) {
    if (column === ACTIONS_COLUMN) {
      return;
    }

    setSorting((current) => {
      const active = current[0];
      if (!active || active.id !== column) {
        return [{ id: column, desc: false }];
      }
      if (!active.desc) {
        return [{ id: column, desc: true }];
      }
      return [];
    });
  }

  async function submitNewRow() {
    if (!props.onCreateRow || props.createPending) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(createDataDraft);
    } catch (error) {
      setCreateDraftError(
        error instanceof Error ? error.message : "Row JSON is invalid.",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setCreateDraftError("Row data must be a JSON object.");
      return;
    }

    setCreateDraftError(undefined);
    try {
      await props.onCreateRow({
        id: createIdDraft.trim() || undefined,
        data: parsed as Record<string, unknown>,
      });
      setCreateIdDraft("");
      setCreateDataDraft("{}");
      setCreateDrawerOpen(false);
    } catch {
      // The parent owns the runtime error message so the drawer can stay open.
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 rounded-md border bg-muted/15 p-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={globalFilter}
              onChange={(event) => setGlobalFilter(event.target.value)}
              placeholder={`Filter ${props.collection} rows and visible cells`}
              className="pl-9"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="rounded-md border bg-background px-2 py-1 text-xs">
              {filteredRows.length}/{props.rows.length} rows
            </span>
            <span className="rounded-md border bg-background px-2 py-1 text-xs">
              {visibleColumnKeys.length}/{allColumnKeys.length} columns
            </span>
            {props.createEnabled ? (
              <Button
                type="button"
                onClick={() => setCreateDrawerOpen(true)}
                disabled={props.createPending}
              >
                <Plus className="size-4" />
                New Row
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,12rem)_minmax(0,14rem)_auto_auto]">
          <select
            value={props.activeSavedViewName ?? ""}
            onChange={(event) => applySavedView(event.target.value)}
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Saved database view"
          >
            <option value="">Saved views</option>
            {savedViews.map((view) => (
              <option key={view.name} value={view.name}>
                {view.name}{" "}
                ({view.target})
              </option>
            ))}
          </select>
          <Input
            value={viewNameDraft}
            onChange={(event) => setViewNameDraft(event.target.value)}
            placeholder="Save current as..."
            aria-label="Database view name"
          />
          <Button type="button" variant="outline" onClick={saveCurrentView}>
            Save View
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!props.activeSavedViewName}
            onClick={() => deleteSavedView(props.activeSavedViewName ?? "")}
          >
            Delete View
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span className="rounded-md border bg-background px-2 py-1">
            {props.createEnabled ? "Collection table" : "Read-only system table"}
          </span>
          <span className="rounded-md border bg-background px-2 py-1">
            View target: {props.target}
          </span>
          <span className="rounded-md border bg-background px-2 py-1">
            Frozen columns: {2 + pinnedColumns.length}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {allColumnKeys
            .filter((column) => column !== "id" && column !== ACTIONS_COLUMN)
            .map((column) => (
              <label
                key={column}
                className="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground"
              >
                <input
                  type="checkbox"
                  checked={columnVisibility[column] !== false}
                  onChange={(event) => {
                    setColumnVisibility((current) => ({
                      ...current,
                      [column]: event.target.checked,
                    }));
                  }}
                />
                {getColumnTitle(column)}
                <button
                  type="button"
                  className={cn(
                    "rounded-sm border px-1 py-0.5 text-[10px]",
                    pinnedColumns.includes(column) && "border-primary text-primary",
                  )}
                  onClick={(event) => {
                    event.preventDefault();
                    setPinnedColumns((current) =>
                      current.includes(column)
                        ? current.filter((entry) => entry !== column)
                        : [...current, column],
                    );
                  }}
                >
                  <Pin className="size-3" />
                </button>
              </label>
            ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-md border">
        {DataEditor ? (
          <DataEditor
            columns={gridColumns}
            rows={filteredRows.length}
            getCellContent={getCellContent}
            getCellsForSelection
            copyHeaders
            freezeColumns={2 + pinnedColumns.length}
            rowMarkers="clickable-number"
            rowHeight={44}
            headerHeight={40}
            height={620}
            width="100%"
            smoothScrollX
            smoothScrollY
            editOnType={false}
            onHeaderClicked={(columnIndex) => {
              const column = visibleColumnKeys[columnIndex];
              if (column) {
                toggleSort(column);
              }
            }}
            onCellClicked={([col, row]) => {
              const column = visibleColumnKeys[col];
              const rowData = filteredRows[row];
              if (!rowData) {
                return;
              }

              props.onSelectRow(rowData.id);
              if (column === ACTIONS_COLUMN) {
                setDrawerOpen(true);
              }
            }}
            onCellActivated={([col, row]) => {
              const column = visibleColumnKeys[col];
              const rowData = filteredRows[row];
              if (rowData) {
                props.onSelectRow(rowData.id);
                if (column === ACTIONS_COLUMN || column === "id") {
                  setDrawerOpen(true);
                }
              }
            }}
            onColumnResize={(column, newSize) => {
              const id = column.id;
              if (!id) {
                return;
              }
              setColumnSizing((current) => ({
                ...current,
                [id]: newSize,
              }));
            }}
            onColumnMoved={(startIndex, endIndex) => {
              const next = [...visibleColumnKeys];
              const [moved] = next.splice(startIndex, 1);
              if (!moved) {
                return;
              }
              next.splice(endIndex, 0, moved);
              setColumnOrder(
                next.filter((column) => column !== "id" && column !== ACTIONS_COLUMN),
              );
            }}
          />
        ) : (
          <div className="grid h-[620px] place-items-center bg-muted/10 text-sm text-muted-foreground">
            Loading data grid...
          </div>
        )}
      </div>

      <Sheet
        open={drawerOpen}
        onOpenChange={(open) => {
          setDrawerOpen(open);
          if (!open) {
            props.onClearSelectedRow();
          }
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Row details</SheetTitle>
          </SheetHeader>
          <div className="grid gap-3 overflow-auto px-4 pb-4">
            {selectedRow ? (
              <>
                <p className="text-sm font-medium text-foreground">{selectedRow.id}</p>
                <CodeEditor
                  value={detailDraft}
                  language="json"
                  minHeight={360}
                  ariaLabel={`JSON editor for ${selectedRow.id}`}
                  readOnly
                />
                {detailError ? (
                  <ResourceNotice title="Could not render row JSON" description={detailError} />
                ) : null}
              </>
            ) : (
              <ResourceNotice
                title="Select a row"
                description="Pick a row to inspect its raw values."
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={createDrawerOpen} onOpenChange={setCreateDrawerOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>New row</SheetTitle>
          </SheetHeader>
          <div className="grid gap-4 overflow-auto px-4 pb-4">
            {props.createError ? (
              <ResourceNotice title="Could not create row" description={props.createError} />
            ) : null}
            {createDraftError ? (
              <ResourceNotice title="Invalid row JSON" description={createDraftError} />
            ) : null}
            <label className="grid gap-2 text-sm font-medium text-foreground">
              ID
              <Input
                value={createIdDraft}
                onChange={(event) => setCreateIdDraft(event.target.value)}
                placeholder="Auto-generated"
                autoComplete="off"
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              Data
              <CodeEditor
                value={createDataDraft}
                onChange={setCreateDataDraft}
                language="json"
                minHeight={360}
                ariaLabel={`Raw values editor for a new ${props.collection} row`}
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateDrawerOpen(false)}
                disabled={props.createPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void submitNewRow()}
                disabled={props.createPending || !props.onCreateRow}
              >
                <Plus className="size-4" />
                Create Row
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

const databaseSchema = {
  databaseTable: parseAsString,
  systemTable: parseAsStringLiteral(DATABASE_SYSTEM_TABLES).withDefault(DEFAULT_SYSTEM_TABLE),
  inspectedId: parseAsString,
  view: parseAsString,
  sidebar: parseAsString,
} as const;

function DatabaseRoute() {
  const [search, setParams] = useTypedSearchParams(databaseSchema);
  const revalidator = useRevalidator();
  const { systemRows: systemRowsData, tableRows: tableRowsData } = useLoaderData<typeof clientLoader>();
  const { runtime: config } = useRouteLoaderData<typeof rootClientLoader>('root')!;
  const [createError, setCreateError] = useState<string>();
  const [createPending, setCreatePending] = useState(false);
  const selectedRowId = search.inspectedId;
  const setSelectedRowId = (id: string | undefined) => setParams({ inspectedId: id ?? null });
  const selectedDatabaseTable = search.databaseTable || undefined;
  const selectedSystemTable = selectedDatabaseTable ? undefined : search.systemTable;
  const selectedTarget = selectedDatabaseTable ?? selectedSystemTable ?? DEFAULT_SYSTEM_TABLE;
  const activeViewName = search.view;
  const desiredSidebar = selectedDatabaseTable
    ? "Backend/Database"
    : "Backend/Database/System Tables";
  const systemRowsResource = { data: systemRowsData, loading: false, error: undefined as Error | undefined };
  const tableRowsResource = { data: tableRowsData, loading: false, error: undefined as Error | undefined };

  const systemRows = useMemo(
    () =>
      (systemRowsResource.data ?? []).map((row, index) => ({
        id:
          typeof row.sequence === "number"
            ? String(row.sequence)
            : typeof row.id === "string"
              ? row.id
              : typeof row.name === "string"
                ? row.name
                : `${selectedSystemTable ?? "row"}:${index}`,
        data: row,
      })),
    [selectedSystemTable, systemRowsResource.data],
  );
  const tableRows = useMemo(
    () =>
      (tableRowsResource.data ?? []).map((record) => ({
        id: record.id,
        version: record.version,
        updatedAt: record.updatedAt,
        data: record.data,
      })),
    [tableRowsResource.data],
  );
  const activeRows = selectedDatabaseTable ? tableRows : systemRows;
  const activeResource = selectedDatabaseTable ? tableRowsResource : systemRowsResource;
  const activeKind = selectedDatabaseTable ? "Collection table" : "System table";
  const emptyDescription = selectedDatabaseTable
    ? `The collection table ${selectedDatabaseTable} has no rows yet.`
    : `The system table ${selectedSystemTable} is empty or unavailable.`;
  const rowColumns = useMemo(() => {
    const keys = new Set<string>();
    for (const row of activeRows) {
      for (const key of Object.keys(row.data)) {
        keys.add(key);
      }
    }

    return Array.from(keys).sort((left, right) => left.localeCompare(right));
  }, [activeRows]);

  async function createRow(input: {
    id?: string;
    data: Record<string, unknown>;
  }) {
    if (!selectedDatabaseTable || createPending) {
      return;
    }

    setCreatePending(true);
    setCreateError(undefined);
    try {
      const createdRow = await insertDatabaseDocument(config, {
        collection: selectedDatabaseTable,
        id: input.id,
        data: input.data,
      });
      await revalidator.revalidate();
      setSelectedRowId(createdRow.id);
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setCreatePending(false);
    }
  }

  useEffect(() => {
    if (selectedDatabaseTable) {
      return;
    }

    if (search.systemTable === selectedSystemTable) {
      return;
    }

    setParams({ systemTable: selectedSystemTable });
  }, [search.systemTable, selectedDatabaseTable, selectedSystemTable]);

  useEffect(() => {
    if (search.sidebar === desiredSidebar) {
      return;
    }

    setParams({ sidebar: desiredSidebar });
  }, [desiredSidebar, search.sidebar]);

  // Clear inspectedId from URL if the selected row no longer exists in the active table.
  const selectedRowExists = !selectedRowId || activeRows.some((row) => row.id === selectedRowId);
  if (!selectedRowExists) {
    setParams({ inspectedId: null });
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <div className="grid gap-4">
        <div className="grid gap-2">
          <h2 className="text-lg font-semibold">
            {activeKind}: {selectedTarget}
          </h2>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-md border bg-muted/20 px-2 py-1">
              {activeKind}
            </span>
            <span className="rounded-md border bg-muted/20 px-2 py-1">
              {activeRows.length} rows loaded
            </span>
            <span className="rounded-md border bg-muted/20 px-2 py-1">
              {selectedDatabaseTable ? "Raw rows" : "SQL read-only"}
            </span>
          </div>
        </div>

        {activeResource.error ? (
          <ResourceNotice
            title={
              selectedDatabaseTable
                ? "Could not read this collection table"
                : "Could not read this system table"
            }
            description={
              activeResource.error instanceof Error
                ? activeResource.error.message
                : String(activeResource.error)
            }
          />
        ) : activeRows.length === 0 && !selectedDatabaseTable ? (
          <ResourceNotice
            title={
              selectedDatabaseTable
                ? "No rows in this collection table"
                : "No rows in this system table"
            }
            description={emptyDescription}
          />
        ) : (
          <DatabaseDataGrid
            collection={selectedTarget}
            target={selectedTarget}
            rows={activeRows}
            columns={rowColumns}
            selectedRowId={selectedRowId}
            activeSavedViewName={activeViewName}
            createEnabled={Boolean(selectedDatabaseTable)}
            createError={createError}
            createPending={createPending}
            onCreateRow={selectedDatabaseTable ? createRow : undefined}
            onSelectRow={setSelectedRowId}
            onClearSelectedRow={() => setSelectedRowId(undefined)}
            onSavedViewNameChange={(view) => {
              setParams({ view: view ?? null });
            }}
            onActivateSavedViewTarget={(target, viewName) => {
              setParams({
                ...(isSystemTableName(target)
                  ? { systemTable: target, databaseTable: null }
                  : { databaseTable: target, systemTable: null }),
                view: viewName ?? search.view ?? null,
              });
            }}
          />
        )}
      </div>
    </section>
  );
}

export default DatabaseRoute;
