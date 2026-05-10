import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnPinningState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, Pin, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { PageHeader, ResourceNotice } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "#/components/ui/sheet";
import {
  getRuntimeConfig,
  listDatabaseCollections,
  queryDatabaseSystemTable,
  queryDatabaseDocuments,
  updateDatabaseDocument,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/database")({
  validateSearch: (search) => ({
    ...(typeof search.sidebar === "string" ? { sidebar: search.sidebar } : {}),
    ...(typeof search.table === "string" ? { table: search.table } : {}),
    ...(typeof search.systemTable === "string"
      ? { systemTable: search.systemTable }
      : {}),
    ...(typeof search.view === "string" ? { view: search.view } : {}),
  }),
  component: DatabaseRoute,
});

function renderRawCellValue(value: unknown) {
  if (value === undefined) {
    return "—";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function RawDocumentsExplorer(props: {
  collection: string;
  rows: Array<{
    id: string;
    version?: number;
    updatedAt?: string;
    data: Record<string, unknown>;
  }>;
  columns: string[];
  target:
    | {
        kind: "table";
        table: string;
      }
    | {
        kind: "systemTable";
        systemTable: string;
      };
  readOnly?: boolean;
  showDocumentMeta?: boolean;
  selectedDocumentId?: string;
  activeSavedViewName?: string;
  onSelectDocument: (id: string) => void;
  onSaveDocument?: (id: string, rawJson: string) => Promise<void>;
  onSavedViewNameChange?: (name?: string) => void;
  onActivateSavedViewTarget?: (
    target:
      | {
          kind: "table";
          table: string;
        }
      | {
          kind: "systemTable";
          systemTable: string;
        },
    viewName?: string,
  ) => void;
}) {
  type SavedDatabaseView = {
    name: string;
    target:
      | {
          kind: "table";
          table: string;
        }
      | {
          kind: "systemTable";
          systemTable: string;
        };
    columnVisibility: VisibilityState;
    columnPinning: ColumnPinningState;
    columnSizing: Record<string, number>;
    sorting: SortingState;
    globalFilter: string;
  };
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({
    left: ["id"],
  });
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailDraft, setDetailDraft] = useState("");
  const [detailError, setDetailError] = useState<string>();
  const [savingDetail, setSavingDetail] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedDatabaseView[]>([]);
  const [viewNameDraft, setViewNameDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const storageKey = `zelavis:database-grid:${props.collection}`;
  const viewsStorageKey = "zelavis:database-grid-views";

  const tableData = useMemo(
    () =>
      props.rows.map((row) => ({
        ...row,
        searchText: `${row.id} ${props.columns
          .map((column) => renderRawCellValue(row.data[column]))
          .join(" ")}`.toLowerCase(),
      })),
    [props.columns, props.rows],
  );

  const columns = useMemo<ColumnDef<(typeof tableData)[number]>[]>(
    () => [
      {
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => props.onSelectDocument(row.original.id)}
            className="font-mono text-xs text-foreground underline-offset-4 hover:underline"
          >
            {row.original.id}
          </button>
        ),
        enableHiding: false,
      },
      ...props.columns.map(
        (column): ColumnDef<(typeof tableData)[number]> => ({
          id: column,
          header: column,
          accessorFn: (row) => renderRawCellValue(row.data[column]),
          cell: ({ getValue }) => (
            <span className="line-clamp-2 text-muted-foreground">
              {String(getValue() ?? "—")}
            </span>
          ),
        }),
      ),
      ...(props.showDocumentMeta === false
        ? []
        : [
            {
              accessorKey: "version",
              header: "Version",
              cell: ({ row }: { row: { original: (typeof tableData)[number] } }) =>
                row.original.version === undefined ? "—" : `v${row.original.version}`,
            },
            {
              accessorKey: "updatedAt",
              header: "Updated",
              cell: ({ row }: { row: { original: (typeof tableData)[number] } }) =>
                row.original.updatedAt
                  ? new Date(row.original.updatedAt).toLocaleString()
                  : "—",
            },
          ]),
    ],
    [props.columns, props.onSelectDocument, props.showDocumentMeta],
  );

  const table = useReactTable({
    data: tableData,
    columns,
    state: {
      globalFilter,
      columnVisibility,
      sorting,
      columnPinning,
      columnSizing,
    },
    globalFilterFn: (row, _columnId, filterValue) =>
      row.original.searchText.includes(String(filterValue).toLowerCase()),
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    onColumnPinningChange: setColumnPinning,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: "onChange",
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 18,
      },
    },
  });

  const visibleRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 8,
  });

  const selectedDocument = props.rows.find(
    (document) => document.id === props.selectedDocumentId,
  );

  useEffect(() => {
    if (!selectedDocument) {
      setDetailDraft("");
      setDetailError(undefined);
      setDrawerOpen(false);
      return;
    }

    setDetailDraft(JSON.stringify(selectedDocument.data, null, 2));
    setDetailError(undefined);
    setDrawerOpen(true);
  }, [selectedDocument]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        columnVisibility?: VisibilityState;
        columnPinning?: ColumnPinningState;
        columnSizing?: Record<string, number>;
        globalFilter?: string;
      };

      if (parsed.columnVisibility) {
        setColumnVisibility(parsed.columnVisibility);
      }
      if (parsed.columnPinning) {
        setColumnPinning(parsed.columnPinning);
      }
      if (parsed.columnSizing) {
        setColumnSizing(parsed.columnSizing);
      }
      if (typeof parsed.globalFilter === "string") {
        setGlobalFilter(parsed.globalFilter);
      }
    } catch {
      // Ignore corrupt persisted grid preferences.
    }
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const raw = window.localStorage.getItem(viewsStorageKey);
      if (!raw) {
        setSavedViews([]);
        return;
      }

      const parsed = JSON.parse(raw) as SavedDatabaseView[];
      setSavedViews(Array.isArray(parsed) ? parsed : []);
    } catch {
      setSavedViews([]);
    }
  }, [viewsStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        columnVisibility,
        columnPinning,
        columnSizing,
        globalFilter,
      }),
    );
  }, [columnPinning, columnSizing, columnVisibility, globalFilter, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(viewsStorageKey, JSON.stringify(savedViews));
  }, [savedViews, viewsStorageKey]);

  function saveCurrentView() {
    const trimmedName = viewNameDraft.trim();
    if (!trimmedName) {
      return;
    }

    const nextView: SavedDatabaseView = {
      name: trimmedName,
      target: props.target,
      columnVisibility,
      columnPinning,
      columnSizing,
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
    setColumnPinning(view.columnPinning);
    setColumnSizing(view.columnSizing);
    setSorting(view.sorting);
    setGlobalFilter(view.globalFilter);
  }

  function applySavedView(name: string) {
    props.onSavedViewNameChange?.(name || undefined);
    const view = savedViews.find((entry) => entry.name === name);
    if (!view) {
      return;
    }

    const currentTargetKey =
      props.target.kind === "table"
        ? `table:${props.target.table}`
        : `system:${props.target.systemTable}`;
    const viewTargetKey =
      view.target.kind === "table"
        ? `table:${view.target.table}`
        : `system:${view.target.systemTable}`;

    if (currentTargetKey !== viewTargetKey) {
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
    if (!view) {
      return;
    }

    const currentTargetKey =
      props.target.kind === "table"
        ? `table:${props.target.table}`
        : `system:${props.target.systemTable}`;
    const viewTargetKey =
      view.target.kind === "table"
        ? `table:${view.target.table}`
        : `system:${view.target.systemTable}`;

    if (currentTargetKey !== viewTargetKey) {
      return;
    }

    loadSavedViewIntoState(view);
  }, [props.activeSavedViewName, props.target, savedViews]);

  const currentResultCount = table.getRowModel().rows.length;
  const totalRowCount = tableData.length;
  const currentViewTargetLabel =
    props.target.kind === "table" ? props.target.table : props.target.systemTable;

  return (
    <div className="grid gap-4">
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
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount() || 1}
              </span>
              <span className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">
                {currentResultCount}/{totalRowCount} rows
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <ChevronRight className="size-4" />
              </Button>
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
                  {view.target.kind === "table"
                    ? `(${view.target.table})`
                    : `(${view.target.systemTable})`}
                </option>
              ))}
            </select>
            <Input
              value={viewNameDraft}
              onChange={(event) => setViewNameDraft(event.target.value)}
              placeholder="Save current as..."
              aria-label="Database view name"
            />
            <Button type="button" size="sm" variant="outline" onClick={saveCurrentView}>
              Save View
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!props.activeSavedViewName}
              onClick={() => deleteSavedView(props.activeSavedViewName ?? "")}
            >
              Delete View
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-md border bg-background px-2 py-1">
              {props.readOnly ? "Read-only system table" : "Writable logical table"}
            </span>
            <span className="rounded-md border bg-background px-2 py-1">
              View target: {currentViewTargetLabel}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {table
              .getAllLeafColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <label
                  key={column.id}
                  className="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground"
                >
                  <input
                    type="checkbox"
                    checked={column.getIsVisible()}
                    onChange={column.getToggleVisibilityHandler()}
                  />
                  {String(column.columnDef.header)}
                  {column.id !== "id" ? (
                    <button
                      type="button"
                      className={cn(
                        "rounded-sm border px-1 py-0.5 text-[10px]",
                        column.getIsPinned() && "border-primary text-primary",
                      )}
                      onClick={(event) => {
                        event.preventDefault();
                        column.pin(column.getIsPinned() ? false : "left");
                      }}
                    >
                      <Pin className="size-3" />
                    </button>
                  ) : null}
                </label>
              ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-md border">
          <div className="grid grid-cols-[180px_repeat(auto-fit,minmax(160px,1fr))] border-b bg-muted/20 text-left text-sm text-muted-foreground">
            {table.getFlatHeaders().map((header) => (
              <button
                key={header.id}
                type="button"
                className={cn(
                  "relative px-4 py-3 text-left font-medium",
                  header.column.getCanSort() && "cursor-pointer select-none hover:text-foreground",
                  header.column.getIsPinned() &&
                    "sticky z-10 bg-muted/20 shadow-[1px_0_0_0_var(--border)]",
                )}
                onClick={header.column.getToggleSortingHandler()}
                style={{
                  width: header.getSize(),
                  minWidth: header.getSize(),
                  left: header.column.getIsPinned()
                    ? `${header.column.getStart("left")}px`
                    : undefined,
                }}
              >
                <span className="inline-flex items-center gap-2">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {header.column.getIsSorted() === "asc"
                    ? "↑"
                    : header.column.getIsSorted() === "desc"
                      ? "↓"
                      : null}
                </span>
                {header.column.getCanResize() ? (
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none bg-transparent hover:bg-border"
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      header.column.resetSize();
                    }}
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                  />
                ) : null}
              </button>
            ))}
          </div>
          <div ref={scrollRef} className="max-h-[38rem] overflow-auto">
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = visibleRows[virtualRow.index];
                if (!row) {
                  return null;
                }

                return (
                  <div
                    key={row.id}
                    className={cn(
                      "grid grid-cols-[180px_repeat(auto-fit,minmax(160px,1fr))] border-b text-sm",
                      props.selectedDocumentId === row.original.id && "bg-accent/30",
                    )}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        key={cell.id}
                        className={cn(
                          "px-4 py-3",
                          cell.column.getIsPinned() &&
                            "sticky z-10 bg-background shadow-[1px_0_0_0_var(--border)]",
                        )}
                        style={{
                          width: cell.column.getSize(),
                          minWidth: cell.column.getSize(),
                          left: cell.column.getIsPinned()
                            ? `${cell.column.getStart("left")}px`
                            : undefined,
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Row details</SheetTitle>
          </SheetHeader>
          <div className="grid gap-3 overflow-auto px-4 pb-4">
            {selectedDocument ? (
              <>
                <p className="text-sm font-medium text-foreground">{selectedDocument.id}</p>
                {props.showDocumentMeta === false ? null : (
                  <p className="text-xs text-muted-foreground">
                    {selectedDocument.version === undefined ? "—" : `v${selectedDocument.version}`} ·{" "}
                    {selectedDocument.updatedAt
                      ? new Date(selectedDocument.updatedAt).toLocaleString()
                      : "—"}
                  </p>
                )}
                <textarea
                  value={detailDraft}
                  onChange={(event) => setDetailDraft(event.target.value)}
                  rows={18}
                  className="min-h-72 rounded-md border bg-muted/20 p-4 font-mono text-xs leading-6 text-muted-foreground"
                  spellCheck={false}
                />
                {detailError ? (
                  <ResourceNotice title="Save failed" description={detailError} />
                ) : null}
                {props.readOnly ? null : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={async () => {
                        if (!props.onSaveDocument) {
                          return;
                        }
                        setSavingDetail(true);
                        setDetailError(undefined);
                        try {
                          await props.onSaveDocument(selectedDocument.id, detailDraft);
                        } catch (error) {
                          setDetailError(error instanceof Error ? error.message : String(error));
                        } finally {
                          setSavingDetail(false);
                        }
                      }}
                      disabled={savingDetail}
                    >
                      Save Row
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDetailDraft(JSON.stringify(selectedDocument.data, null, 2))
                      }
                    >
                      Reset
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <ResourceNotice
                title="Select a row"
                description="Pick a row to inspect or patch its JSON."
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DatabaseRoute() {
  const navigate = useNavigate({ from: "/database" });
  const search = Route.useSearch();
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const collections = useRuntimeResource(
    async () => (config ? listDatabaseCollections(config) : []),
    [config],
  );
  const selected = useMemo(
    () => search.table ?? collections.data?.[0]?.name,
    [collections.data, search.table],
  );
  const selectedSystemTable = search.systemTable as
    | "_collections"
    | "_documents"
    | "_events"
    | "_schemas"
    | "_time_series_checkpoints"
    | "_time_series_points"
    | undefined;
  const activeViewName = search.view;
  const desiredSidebar =
    selectedSystemTable !== undefined
      ? "Core/Database/System Tables"
      : "Core/Database";
  const documents = useRuntimeResource(
    async () => (config && selected ? queryDatabaseDocuments(config, selected) : []),
    [config, selected],
  );
  const systemRowsResource = useRuntimeResource(
    async () =>
      config && selectedSystemTable
        ? queryDatabaseSystemTable(config, selectedSystemTable, { limit: 100 })
        : [],
    [config, selectedSystemTable],
  );

  const documentRows = documents.data ?? [];
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
  const documentColumns = useMemo(() => {
    const keys = new Set<string>();
    for (const document of selectedSystemTable ? systemRows : documentRows) {
      for (const key of Object.keys(document.data)) {
        keys.add(key);
      }
    }

    return Array.from(keys).sort((left, right) => left.localeCompare(right));
  }, [documentRows, selectedSystemTable, systemRows]);

  useEffect(() => {
    if (selectedSystemTable || !selected || search.table === selected) {
      return;
    }

    void navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        table: selected,
        systemTable: undefined,
      }),
    });
  }, [navigate, search.table, selected, selectedSystemTable]);

  useEffect(() => {
    if (search.sidebar === desiredSidebar) {
      return;
    }

    void navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        sidebar: desiredSidebar,
      }),
    });
  }, [desiredSidebar, navigate, search.sidebar]);

  useEffect(() => {
    const activeRows = selectedSystemTable ? systemRows : documentRows;
    if (activeRows.length === 0) {
      setSelectedDocumentId(undefined);
      return;
    }

    if (
      !selectedDocumentId ||
      !activeRows.some((document) => document.id === selectedDocumentId)
    ) {
      setSelectedDocumentId(activeRows[0]?.id);
    }
  }, [documentRows, selectedDocumentId, selectedSystemTable, systemRows]);

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader eyebrow="Database" title="Core Database" />

      {actionMessage ? <ResourceNotice title="Done" description={actionMessage} /> : null}
      {actionError ? <ResourceNotice title="Action failed" description={actionError} /> : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="grid gap-2">
            <CardTitle>
              {selectedSystemTable
                ? `System Table: ${selectedSystemTable}`
                : selected
                  ? `Collection: ${selected}`
                  : "Tables"}
            </CardTitle>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border bg-muted/20 px-2 py-1">
                {selectedSystemTable ? "System table" : "Logical table"}
              </span>
              <span className="rounded-md border bg-muted/20 px-2 py-1">
                {selectedSystemTable ? systemRows.length : documentRows.length} rows loaded
              </span>
              <span className="rounded-md border bg-muted/20 px-2 py-1">
                {selectedSystemTable ? "SQL read-only" : "Document service"}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {selectedSystemTable ? (
            systemRowsResource.error ? (
              <ResourceNotice
                title="Could not read this system table"
                description={
                  systemRowsResource.error instanceof Error
                    ? systemRowsResource.error.message
                    : String(systemRowsResource.error)
                }
              />
            ) : systemRows.length === 0 ? (
              <ResourceNotice
                title="No rows in this system table"
                description={`The system table ${selectedSystemTable} is empty or unavailable.`}
              />
            ) : (
              <RawDocumentsExplorer
                collection={selectedSystemTable}
                target={{
                  kind: "systemTable",
                  systemTable: selectedSystemTable,
                }}
                rows={systemRows}
                columns={documentColumns}
                readOnly
                showDocumentMeta={false}
                selectedDocumentId={selectedDocumentId}
                activeSavedViewName={activeViewName}
                onSelectDocument={setSelectedDocumentId}
                onSavedViewNameChange={(view) => {
                  void navigate({
                    replace: true,
                    search: (previous) => ({
                      ...previous,
                      view,
                    }),
                  });
                }}
                onActivateSavedViewTarget={(target, viewName) => {
                  void navigate({
                    replace: true,
                    search: (previous) => ({
                      ...previous,
                      table: target.kind === "table" ? target.table : undefined,
                      systemTable:
                        target.kind === "systemTable" ? target.systemTable : undefined,
                      view: viewName ?? previous.view,
                    }),
                  });
                }}
              />
            )
          ) : !selected ? (
            <ResourceNotice
              title="No collections yet"
              description="No collections available."
            />
          ) : documentRows.length === 0 ? (
            <ResourceNotice
              title="No rows in this collection"
              description={`The collection ${selected} does not have any rows yet.`}
            />
          ) : (
              <RawDocumentsExplorer
                collection={selected}
                target={{
                  kind: "table",
                  table: selected,
                }}
                rows={documentRows}
                columns={documentColumns}
                showDocumentMeta
                selectedDocumentId={selectedDocumentId}
                activeSavedViewName={activeViewName}
                onSelectDocument={setSelectedDocumentId}
                onSavedViewNameChange={(view) => {
                  void navigate({
                    replace: true,
                    search: (previous) => ({
                      ...previous,
                      view,
                    }),
                  });
                }}
                onActivateSavedViewTarget={(target, viewName) => {
                  void navigate({
                    replace: true,
                    search: (previous) => ({
                      ...previous,
                      table: target.kind === "table" ? target.table : undefined,
                      systemTable:
                        target.kind === "systemTable" ? target.systemTable : undefined,
                      view: viewName ?? previous.view,
                    }),
                  });
                }}
                onSaveDocument={async (id, rawJson) => {
                if (!config || !selected) {
                  return;
                }

                try {
                  await updateDatabaseDocument(config, {
                    collection: selected,
                    id,
                    data: JSON.parse(rawJson) as Record<string, unknown>,
                  });
                  await documents.reload();
                  setActionError(undefined);
                  setActionMessage(`Updated ${id} in ${selected}.`);
                } catch (error) {
                  setActionMessage(undefined);
                  setActionError(error instanceof Error ? error.message : String(error));
                  throw error;
                }
              }}
            />
          )}
        </CardContent>
      </Card>
    </section>
  );
}
