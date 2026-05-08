import { createFileRoute } from "@tanstack/react-router";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, Database, Search, Table2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  PageHeader,
  ResourceNotice,
  StatCard,
} from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  getDatabaseHealth,
  getRuntimeConfig,
  listDatabaseCollections,
  queryDatabaseDocuments,
  updateDatabaseDocument,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/database")({ component: DatabaseRoute });

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
    version: number;
    updatedAt: string;
    data: Record<string, unknown>;
  }>;
  columns: string[];
  selectedDocumentId?: string;
  onSelectDocument: (id: string) => void;
  onSaveDocument: (id: string, rawJson: string) => Promise<void>;
}) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const [detailDraft, setDetailDraft] = useState("");
  const [detailError, setDetailError] = useState<string>();
  const [savingDetail, setSavingDetail] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
      {
        accessorKey: "version",
        header: "Version",
        cell: ({ row }) => `v${row.original.version}`,
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ row }) => new Date(row.original.updatedAt).toLocaleString(),
      },
    ],
    [props.columns, props.onSelectDocument],
  );

  const table = useReactTable({
    data: tableData,
    columns,
    state: {
      globalFilter,
      columnVisibility,
      sorting,
    },
    globalFilterFn: (row, _columnId, filterValue) =>
      row.original.searchText.includes(String(filterValue).toLowerCase()),
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
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
      return;
    }

    setDetailDraft(JSON.stringify(selectedDocument.data, null, 2));
    setDetailError(undefined);
  }, [selectedDocument]);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_360px]">
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
                </label>
              ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-md border">
          <div className="grid grid-cols-[180px_repeat(auto-fit,minmax(160px,1fr))] border-b bg-muted/20 text-left text-sm text-muted-foreground">
            {table.getFlatHeaders().map((header, index) => (
              <button
                key={header.id}
                type="button"
                className={cn(
                  "px-4 py-3 text-left font-medium",
                  header.column.getCanSort() && "cursor-pointer select-none hover:text-foreground",
                  index === 0 && "sticky left-0 z-10 bg-muted/20",
                )}
                onClick={header.column.getToggleSortingHandler()}
              >
                <span className="inline-flex items-center gap-2">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {header.column.getIsSorted() === "asc"
                    ? "↑"
                    : header.column.getIsSorted() === "desc"
                      ? "↓"
                      : null}
                </span>
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
                    {row.getVisibleCells().map((cell, index) => (
                      <div
                        key={cell.id}
                        className={cn(
                          "px-4 py-3",
                          index === 0 && "sticky left-0 bg-background",
                        )}
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

      <Card>
        <CardHeader>
          <CardTitle>Row details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4">
          {selectedDocument ? (
            <>
              <p className="text-sm font-medium text-foreground">{selectedDocument.id}</p>
              <p className="text-xs text-muted-foreground">
                v{selectedDocument.version} · {new Date(selectedDocument.updatedAt).toLocaleString()}
              </p>
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
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={async () => {
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
            </>
          ) : (
            <ResourceNotice
              title="Select a row"
              description="Core > Database now stays a raw browser. Pick a row to inspect or patch the JSON directly."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DatabaseRoute() {
  const [selectedCollection, setSelectedCollection] = useState<string>();
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const health = useRuntimeResource(
    async () => (config ? getDatabaseHealth(config) : undefined),
    [config],
  );
  const collections = useRuntimeResource(
    async () => (config ? listDatabaseCollections(config) : []),
    [config],
  );
  const selected = useMemo(
    () => selectedCollection ?? collections.data?.[0]?.name,
    [collections.data, selectedCollection],
  );
  const documents = useRuntimeResource(
    async () =>
      config && selected ? queryDatabaseDocuments(config, selected) : [],
    [config, selected],
  );

  const documentRows = documents.data ?? [];
  const collectionRows = collections.data ?? [];
  const databaseHealth = health.data;

  const documentColumns = useMemo(() => {
    const keys = new Set<string>();
    for (const document of documentRows) {
      for (const key of Object.keys(document.data)) {
        keys.add(key);
      }
    }

    return Array.from(keys).sort((left, right) => left.localeCompare(right));
  }, [documentRows]);

  useEffect(() => {
    if (documentRows.length === 0) {
      setSelectedDocumentId(undefined);
      return;
    }

    if (
      !selectedDocumentId ||
      !documentRows.some((document) => document.id === selectedDocumentId)
    ) {
      setSelectedDocumentId(documentRows[0]?.id);
    }
  }, [documentRows, selectedDocumentId]);

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Database"
        title="Core Database"
        description="This page is now intentionally blunt: a raw collection browser for advanced users. Content modeling and collection editing live under Content."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Collections"
          value={String(collectionRows.length)}
          detail="Low-level collections visible to the runtime"
          icon={Database}
        />
        <StatCard
          label="Rows"
          value={String(documentRows.length)}
          detail={selected ? `${selected} currently loaded` : "Choose a collection"}
          icon={Table2}
        />
        <StatCard
          label="Driver"
          value={databaseHealth?.driver ?? "checking"}
          detail={`tenant ${databaseHealth?.defaultTenantId ?? "default"}`}
          icon={Database}
        />
      </section>

      {actionMessage ? <ResourceNotice title="Done" description={actionMessage} /> : null}
      {actionError ? <ResourceNotice title="Action failed" description={actionError} /> : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle>Raw collections</CardTitle>
            <p className="text-sm text-muted-foreground">
              Use Content Studio for content-type creation, schema editing, and friendly field building.
            </p>
          </div>
          <div className="flex min-w-[16rem] flex-col gap-2 sm:min-w-[20rem]">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Collection
            </label>
            <select
              value={selected ?? ""}
              onChange={(event) => setSelectedCollection(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {(collectionRows ?? []).map((collection) => (
                <option key={collection.name} value={collection.name}>
                  {collection.name}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {!selected ? (
            <ResourceNotice
              title="No collections yet"
              description="Create a content type under Content Studio first, then inspect the raw collection here."
            />
          ) : documentRows.length === 0 ? (
            <ResourceNotice
              title="No rows in this collection"
              description={`The collection ${selected} exists but does not have any rows yet.`}
            />
          ) : (
            <RawDocumentsExplorer
              collection={selected}
              rows={documentRows}
              columns={documentColumns}
              selectedDocumentId={selectedDocumentId}
              onSelectDocument={setSelectedDocumentId}
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
