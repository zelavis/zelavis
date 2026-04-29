import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { useMemo, useState } from "react";
import { Activity, Braces, Database, Table2 } from "lucide-react";

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  type DatabaseTimeSeriesAggregateOperation,
  type DatabaseTimeSeriesSummary,
  type DatabaseStoredCollectionSchema,
  type DatabaseTimeSeriesPoint,
  activateDatabaseSchemaVersion,
  createDatabaseSchema,
  listDatabaseTimeSeries,
  getDatabaseHealth,
  getRuntimeConfig,
  deleteDatabaseDocument,
  createDatabaseCollection,
  listDatabaseSchemaCollections,
  listDatabaseSchemaVersions,
  insertDatabaseDocument,
  queryDatabaseTimeSeriesAggregate,
  queryDatabaseTimeSeriesRange,
  listDatabaseCollections,
  queryDatabaseDocuments,
  seedDemoDatabase,
  updateDatabaseDocument,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/database")({ component: DatabaseRoute });

function formatTimeSeriesTimestamp(value: number | string) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return String(value);
  }

  return new Date(timestamp).toLocaleString();
}

function readTimeSeriesTimestamp(value: number | string) {
  return typeof value === "number" ? value : Date.parse(value);
}

function TimeSeriesChart({
  points,
}: {
  points: readonly DatabaseTimeSeriesPoint[];
}) {
  if (points.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-dashed bg-muted/20 text-sm text-muted-foreground">
        No samples available for the current range.
      </div>
    );
  }

  const ordered = [...points].sort(
    (left, right) =>
      readTimeSeriesTimestamp(left.timestamp) -
      readTimeSeriesTimestamp(right.timestamp),
  );
  const values = ordered.map((point) => point.value);
  const timestamps = ordered.map((point) =>
    readTimeSeriesTimestamp(point.timestamp),
  );
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const minTimestamp = Math.min(...timestamps);
  const maxTimestamp = Math.max(...timestamps);
  const width = 720;
  const height = 240;
  const paddingX = 20;
  const paddingY = 18;
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingY * 2;
  const valueSpan = maxValue - minValue || 1;
  const timeSpan = maxTimestamp - minTimestamp || 1;

  const path = ordered
    .map((point, index) => {
      const x =
        paddingX +
        ((readTimeSeriesTimestamp(point.timestamp) - minTimestamp) / timeSpan) *
          plotWidth;
      const y =
        height - paddingY - ((point.value - minValue) / valueSpan) * plotHeight;

      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const area = `${path} L${width - paddingX},${height - paddingY} L${paddingX},${height - paddingY} Z`;
  const midValue = minValue + valueSpan / 2;
  const ticks = [maxValue, midValue, minValue];

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Latest
          </p>
          <p className="mt-1 text-sm font-medium">
            {ordered[ordered.length - 1]?.value}
          </p>
        </div>
        <div className="rounded-md border bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Min
          </p>
          <p className="mt-1 text-sm font-medium">{minValue}</p>
        </div>
        <div className="rounded-md border bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Max
          </p>
          <p className="mt-1 text-sm font-medium">{maxValue}</p>
        </div>
        <div className="rounded-md border bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Samples
          </p>
          <p className="mt-1 text-sm font-medium">{ordered.length}</p>
        </div>
      </div>

      <div className="rounded-md border bg-linear-to-b from-muted/10 to-transparent p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-64 w-full overflow-visible"
          role="img"
          aria-label="Time-series chart"
        >
          {ticks.map((tick) => {
            const y =
              height - paddingY - ((tick - minValue) / valueSpan) * plotHeight;

            return (
              <g key={tick}>
                <line
                  x1={paddingX}
                  x2={width - paddingX}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity="0.12"
                />
                <text
                  x={paddingX}
                  y={Math.max(12, y - 6)}
                  fontSize="11"
                  fill="currentColor"
                  opacity="0.6"
                >
                  {tick.toFixed(2).replace(/\.00$/, "")}
                </text>
              </g>
            );
          })}

          <path d={area} fill="var(--color-chart-1)" fillOpacity="0.12" />
          <path
            d={path}
            fill="none"
            stroke="var(--color-chart-1)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {ordered.map((point, index) => {
            const x =
              paddingX +
              ((readTimeSeriesTimestamp(point.timestamp) - minTimestamp) /
                timeSpan) *
                plotWidth;
            const y =
              height -
              paddingY -
              ((point.value - minValue) / valueSpan) * plotHeight;

            return (
              <g key={`${String(point.timestamp)}:${index}`}>
                <circle
                  cx={x}
                  cy={y}
                  r="4"
                  fill="var(--background)"
                  stroke="var(--color-chart-1)"
                  strokeWidth="2"
                />
                <title>
                  {`${formatTimeSeriesTimestamp(point.timestamp)} · ${point.value}`}
                </title>
              </g>
            );
          })}
        </svg>

        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{formatTimeSeriesTimestamp(ordered[0].timestamp)}</span>
          <span>
            {formatTimeSeriesTimestamp(ordered[ordered.length - 1].timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}

function DatabaseRoute() {
  const [selectedCollection, setSelectedCollection] = useState<string>();
  const [selectedSeriesName, setSelectedSeriesName] = useState<string>();
  const [collectionName, setCollectionName] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [documentJson, setDocumentJson] = useState(
    '{\n  "name": "Draft item"\n}',
  );
  const [schemaVersion, setSchemaVersion] = useState("1");
  const [schemaJson, setSchemaJson] = useState(
    '{\n  "type": "object",\n  "additionalProperties": false,\n  "required": ["name"],\n  "properties": {\n    "name": { "type": "string", "minLength": 1 }\n  }\n}',
  );
  const [editingDocumentId, setEditingDocumentId] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rangeLimit, setRangeLimit] = useState("25");
  const [rangeOrder, setRangeOrder] = useState<"asc" | "desc">("desc");
  const [rangeRequest, setRangeRequest] = useState({
    start: "",
    end: "",
    limit: "25",
    order: "desc" as "asc" | "desc",
  });
  const [aggregateStart, setAggregateStart] = useState("");
  const [aggregateEnd, setAggregateEnd] = useState("");
  const [aggregateOp, setAggregateOp] =
    useState<DatabaseTimeSeriesAggregateOperation>("avg");
  const [aggregateRequest, setAggregateRequest] = useState({
    start: "",
    end: "",
    op: "avg" as DatabaseTimeSeriesAggregateOperation,
  });
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
  const schemaCollections = useRuntimeResource(
    async () => (config ? listDatabaseSchemaCollections(config) : []),
    [config],
  );
  const schemaVersions = useRuntimeResource(
    async () =>
      config && selected ? listDatabaseSchemaVersions(config, selected) : [],
    [config, selected],
  );
  const timeseries = useRuntimeResource(
    async () => (config ? listDatabaseTimeSeries(config) : []),
    [config],
  );
  const selectedSeries = useMemo(
    () => selectedSeriesName ?? timeseries.data?.[0]?.name,
    [selectedSeriesName, timeseries.data],
  );
  const rangePoints = useRuntimeResource(
    async () =>
      config && selectedSeries
        ? queryDatabaseTimeSeriesRange(config, {
            series: selectedSeries,
            start: rangeRequest.start || undefined,
            end: rangeRequest.end || undefined,
            limit:
              rangeRequest.limit.trim().length > 0
                ? Number(rangeRequest.limit)
                : undefined,
            order: rangeRequest.order,
          })
        : [],
    [
      config,
      selectedSeries,
      rangeRequest.start,
      rangeRequest.end,
      rangeRequest.limit,
      rangeRequest.order,
    ],
  );
  const aggregateValue = useRuntimeResource(
    async () =>
      config && selectedSeries
        ? queryDatabaseTimeSeriesAggregate(config, {
            series: selectedSeries,
            op: aggregateRequest.op,
            start: aggregateRequest.start || undefined,
            end: aggregateRequest.end || undefined,
          })
        : undefined,
    [
      config,
      selectedSeries,
      aggregateRequest.op,
      aggregateRequest.start,
      aggregateRequest.end,
    ],
  );
  const databaseHealth = health.data;
  const collectionRows = collections.data ?? [];
  const documentRows = documents.data ?? [];
  const schemaCollectionRows = schemaCollections.data ?? [];
  const schemaVersionRows = schemaVersions.data ?? [];
  const seriesRows = timeseries.data ?? [];
  const editingDocument = documentRows.find(
    (document) => document.id === editingDocumentId,
  );
  const activeSchemaSummary = schemaCollectionRows.find(
    (collection) => collection.collection === selected,
  );
  const activeSeriesSummary = seriesRows.find(
    (series) => series.name === selectedSeries,
  );

  async function runAction(action: () => Promise<void>) {
    setSaving(true);
    setActionError(undefined);
    setActionMessage(undefined);

    try {
      await action();
      collections.reload();
      documents.reload();
      schemaCollections.reload();
      schemaVersions.reload();
      timeseries.reload();
      rangePoints.reload();
      aggregateValue.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function handleRunRange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      rangeLimit.trim().length > 0 &&
      !Number.isInteger(Number(rangeLimit.trim()))
    ) {
      setActionError("Range limit must be a whole number.");
      return;
    }

    setActionError(undefined);
    setRangeRequest({
      start: rangeStart.trim(),
      end: rangeEnd.trim(),
      limit: rangeLimit.trim(),
      order: rangeOrder,
    });
  }

  function handleRunAggregate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(undefined);
    setAggregateRequest({
      start: aggregateStart.trim(),
      end: aggregateEnd.trim(),
      op: aggregateOp,
    });
  }

  async function handleCreateCollection(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!config || !collectionName.trim()) {
      return;
    }

    await runAction(async () => {
      const collection = await createDatabaseCollection(config, {
        name: collectionName.trim(),
      });
      setSelectedCollection(collection.name);
      setCollectionName("");
      setActionMessage(`Created ${collection.name}`);
    });
  }

  async function handleInsertDocument(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !selected) {
      return;
    }

    await runAction(async () => {
      const document = await insertDatabaseDocument(config, {
        collection: selected,
        id: documentId.trim(),
        data: JSON.parse(documentJson) as Record<string, unknown>,
      });
      setDocumentId("");
      setActionMessage(`Inserted ${document.id}`);
    });
  }

  async function handleEditDocument(documentIdToEdit: string) {
    const document = documentRows.find((item) => item.id === documentIdToEdit);
    if (!document) {
      return;
    }

    setEditingDocumentId(document.id);
    setDocumentId(document.id);
    setDocumentJson(JSON.stringify(document.data, null, 2));
  }

  async function handleUpdateDocument(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !selected || !editingDocumentId) {
      return;
    }

    await runAction(async () => {
      const document = await updateDatabaseDocument(config, {
        collection: selected,
        id: editingDocumentId,
        data: JSON.parse(documentJson) as Record<string, unknown>,
      });
      setActionMessage(`Updated ${document.id}`);
      setEditingDocumentId(undefined);
      setDocumentId("");
      setDocumentJson('{\n  "name": "Draft item"\n}');
    });
  }

  async function handleDeleteDocument(documentIdToDelete: string) {
    if (!config || !selected) {
      return;
    }

    await runAction(async () => {
      await deleteDatabaseDocument(config, {
        collection: selected,
        id: documentIdToDelete,
      });
      if (editingDocumentId === documentIdToDelete) {
        setEditingDocumentId(undefined);
        setDocumentId("");
        setDocumentJson('{\n  "name": "Draft item"\n}');
      }
      setActionMessage(`Deleted ${documentIdToDelete}`);
    });
  }

  async function handleSeedDemo() {
    if (!config) {
      return;
    }

    await runAction(async () => {
      await seedDemoDatabase(config);
      setSelectedCollection("products");
      setActionMessage("Seeded demo products");
    });
  }

  async function handleCreateSchema(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !selected) {
      return;
    }

    await runAction(async () => {
      const created = await createDatabaseSchema(config, {
        collection: selected,
        version: Number(schemaVersion),
        document: JSON.parse(schemaJson) as Record<string, unknown>,
        activate: schemaVersionRows.length === 0,
      });
      setActionMessage(`Registered schema v${created.version} for ${selected}`);
    });
  }

  async function handleActivateSchema(schema: DatabaseStoredCollectionSchema) {
    if (!config) {
      return;
    }

    await runAction(async () => {
      await activateDatabaseSchemaVersion(config, {
        collection: schema.collection,
        version: schema.version,
      });
      setActionMessage(
        `Activated schema v${schema.version} for ${schema.collection}`,
      );
    });
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Database"
        title="Multi-model database"
        description="Document storage first, SQL capability preserved for adapters and integrations."
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!config || saving}
            onClick={handleSeedDemo}
          >
            Seed Demo
          </Button>
        }
      />

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Documents"
          value={
            databaseHealth?.capabilities.documents ? "enabled" : "checking"
          }
          detail={`${collectionRows.length} collections visible`}
          icon={Braces}
        />
        <StatCard
          label="SQL"
          value={databaseHealth?.capabilities.sql ? "enabled" : "capability"}
          detail="available when the integration supports it"
          icon={Table2}
        />
        <StatCard
          label="Driver"
          value={databaseHealth?.driver ?? "checking"}
          detail={`tenant ${databaseHealth?.defaultTenantId ?? "default"}`}
          icon={Database}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(280px,0.45fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Collections</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <form className="flex gap-2" onSubmit={handleCreateCollection}>
              <input
                value={collectionName}
                onChange={(event) => setCollectionName(event.target.value)}
                placeholder="collection name"
                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              />
              <Button
                type="submit"
                size="sm"
                disabled={!config || saving || !collectionName.trim()}
              >
                Create
              </Button>
            </form>

            {actionMessage ? (
              <ResourceNotice title="Done" description={actionMessage} />
            ) : null}
            {actionError ? (
              <ResourceNotice title="Action failed" description={actionError} />
            ) : null}

            <div className="overflow-hidden rounded-md border">
              {collectionRows.map((collection) => (
                <button
                  key={`${collection.tenantId}:${collection.name}`}
                  type="button"
                  onClick={() => setSelectedCollection(collection.name)}
                  className="block w-full border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium">
                      {collection.name}
                    </span>
                    <StatusBadge
                      state={
                        selected === collection.name ? "ready" : "available"
                      }
                    />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {collection.documentCount} documents · {collection.tenantId}
                  </p>
                </button>
              ))}
              {collectionRows.length === 0 ? (
                <div className="p-4">
                  <ResourceNotice
                    title={
                      collections.loading
                        ? "Loading collections"
                        : "No collections yet"
                    }
                    description={
                      collections.error
                        ? "The database collections endpoint is not reachable from this dashboard session."
                        : "Create a collection through the database API to browse documents here."
                    }
                  />
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>{selected ?? "Documents"}</span>
              {selected ? <Badge variant="outline">limit 25</Badge> : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <form
              className="grid gap-3"
              onSubmit={
                editingDocument ? handleUpdateDocument : handleInsertDocument
              }
            >
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  value={documentId}
                  onChange={(event) => setDocumentId(event.target.value)}
                  placeholder="optional document id"
                  className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                  disabled={!selected || Boolean(editingDocument)}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!config || !selected || saving}
                >
                  {editingDocument ? "Update" : "Insert"}
                </Button>
              </div>
              <textarea
                value={documentJson}
                onChange={(event) => setDocumentJson(event.target.value)}
                className="min-h-28 resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm"
                spellCheck={false}
                disabled={!selected}
              />
              {editingDocument ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingDocumentId(undefined);
                    setDocumentId("");
                    setDocumentJson('{\n  "name": "Draft item"\n}');
                  }}
                >
                  Cancel Edit
                </Button>
              ) : null}
            </form>

            <div className="overflow-hidden rounded-md border">
              {documentRows.map((document) => (
                <DataRow
                  key={document.id}
                  label={document.id}
                  detail={JSON.stringify(document.data)}
                  meta={
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">v{document.version}</Badge>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleEditDocument(document.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleDeleteDocument(document.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  }
                />
              ))}
              {documentRows.length === 0 ? (
                <div className="p-4">
                  <ResourceNotice
                    title={
                      documents.loading && selected
                        ? "Loading documents"
                        : "No documents selected"
                    }
                    description={
                      selected
                        ? "This collection is empty or the query endpoint returned no documents."
                        : "Select a collection to query documents."
                    }
                  />
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(300px,0.45fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>Time-series definitions</span>
              <Badge variant="outline">{seriesRows.length} series</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <div className="overflow-hidden rounded-md border">
              {seriesRows.map((series: DatabaseTimeSeriesSummary) => (
                <button
                  key={series.name}
                  type="button"
                  onClick={() => setSelectedSeriesName(series.name)}
                  className="block w-full border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium">
                      {series.name}
                    </span>
                    <StatusBadge
                      state={
                        selectedSeries === series.name ? "ready" : "available"
                      }
                    />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {series.description ?? "No description"}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {series.version !== undefined ? (
                      <Badge variant="secondary">
                        v{String(series.version)}
                      </Badge>
                    ) : null}
                    {series.projection ? (
                      <Badge variant="outline">{series.projection}</Badge>
                    ) : null}
                  </div>
                </button>
              ))}
              {seriesRows.length === 0 ? (
                <div className="p-4">
                  <ResourceNotice
                    title={
                      timeseries.loading
                        ? "Loading time-series"
                        : "No time-series definitions"
                    }
                    description={
                      timeseries.error
                        ? "The time-series endpoint is not reachable from this dashboard session."
                        : "Register series definitions in the runtime to inspect derived samples here."
                    }
                  />
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>{selectedSeries ?? "Time-series inspector"}</span>
              {selectedSeries ? (
                <Badge variant="outline">
                  {activeSeriesSummary?.projection ?? "mapped from events"}
                </Badge>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6 p-4">
            {selectedSeries ? (
              <>
                <section className="grid gap-3 rounded-md border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Range query</h3>
                      <p className="text-sm text-muted-foreground">
                        Inspect recent mapped samples for the selected series.
                      </p>
                    </div>
                    <Badge variant="secondary">
                      {rangePoints.data?.length ?? 0} points
                    </Badge>
                  </div>

                  <form
                    className="grid gap-3 md:grid-cols-4"
                    onSubmit={handleRunRange}
                  >
                    <input
                      value={rangeStart}
                      onChange={(event) => setRangeStart(event.target.value)}
                      placeholder="start timestamp"
                      className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                    />
                    <input
                      value={rangeEnd}
                      onChange={(event) => setRangeEnd(event.target.value)}
                      placeholder="end timestamp"
                      className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                    />
                    <input
                      value={rangeLimit}
                      onChange={(event) => setRangeLimit(event.target.value)}
                      inputMode="numeric"
                      placeholder="limit"
                      className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <select
                        value={rangeOrder}
                        onChange={(event) =>
                          setRangeOrder(
                            event.target.value === "asc" ? "asc" : "desc",
                          )
                        }
                        className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                      >
                        <option value="desc">Newest first</option>
                        <option value="asc">Oldest first</option>
                      </select>
                      <Button type="submit" size="sm" disabled={!config}>
                        Load
                      </Button>
                    </div>
                  </form>

                  <TimeSeriesChart points={rangePoints.data ?? []} />

                  <div className="overflow-hidden rounded-md border">
                    {rangePoints.data?.map((point, index) => (
                      <DataRow
                        key={`${String(point.timestamp)}:${index}`}
                        label={formatTimeSeriesTimestamp(point.timestamp)}
                        detail={JSON.stringify({
                          value: point.value,
                          tags: point.tags,
                          fields: point.fields,
                        })}
                        meta={<Badge variant="secondary">{point.value}</Badge>}
                      />
                    ))}
                    {!rangePoints.loading &&
                    (rangePoints.data?.length ?? 0) === 0 ? (
                      <div className="p-4">
                        <ResourceNotice
                          title="No samples returned"
                          description="Adjust the range filters or add more matching events to inspect this series."
                        />
                      </div>
                    ) : null}
                    {rangePoints.error ? (
                      <div className="p-4">
                        <ResourceNotice
                          title="Range query failed"
                          description={rangePoints.error.message}
                        />
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="grid gap-3 rounded-md border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Aggregate query</h3>
                      <p className="text-sm text-muted-foreground">
                        Run a simple aggregate over the selected series.
                      </p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                      <Activity className="size-4 text-muted-foreground" />
                      <span className="font-medium">
                        {aggregateValue.data === undefined
                          ? "—"
                          : String(aggregateValue.data)}
                      </span>
                    </div>
                  </div>

                  <form
                    className="grid gap-3 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                    onSubmit={handleRunAggregate}
                  >
                    <select
                      value={aggregateOp}
                      onChange={(event) =>
                        setAggregateOp(
                          event.target
                            .value as DatabaseTimeSeriesAggregateOperation,
                        )
                      }
                      className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      <option value="avg">avg</option>
                      <option value="sum">sum</option>
                      <option value="min">min</option>
                      <option value="max">max</option>
                      <option value="count">count</option>
                    </select>
                    <input
                      value={aggregateStart}
                      onChange={(event) =>
                        setAggregateStart(event.target.value)
                      }
                      placeholder="start timestamp"
                      className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                    />
                    <input
                      value={aggregateEnd}
                      onChange={(event) => setAggregateEnd(event.target.value)}
                      placeholder="end timestamp"
                      className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                    />
                    <Button type="submit" size="sm" disabled={!config}>
                      Run
                    </Button>
                  </form>

                  {aggregateValue.error ? (
                    <ResourceNotice
                      title="Aggregate query failed"
                      description={aggregateValue.error.message}
                    />
                  ) : null}
                </section>
              </>
            ) : (
              <ResourceNotice
                title="No series selected"
                description="Choose a registered time-series definition to inspect recent samples and aggregates."
              />
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(320px,0.5fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>Schema registry</span>
              {selected ? (
                <Badge variant="outline">
                  {activeSchemaSummary?.activeVersion
                    ? `active v${activeSchemaSummary.activeVersion}`
                    : "no active schema"}
                </Badge>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <form className="grid gap-3" onSubmit={handleCreateSchema}>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  value={schemaVersion}
                  onChange={(event) => setSchemaVersion(event.target.value)}
                  inputMode="numeric"
                  placeholder="schema version"
                  className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
                  disabled={!selected}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    !config ||
                    !selected ||
                    saving ||
                    !Number.isInteger(Number(schemaVersion))
                  }
                >
                  Register
                </Button>
              </div>
              <textarea
                value={schemaJson}
                onChange={(event) => setSchemaJson(event.target.value)}
                className="min-h-40 resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm"
                spellCheck={false}
                disabled={!selected}
              />
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {selected ? `${selected} schema versions` : "Schema versions"}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <div className="overflow-hidden rounded-md border">
              {schemaVersionRows.map((schema) => (
                <DataRow
                  key={`${schema.collection}:${schema.version}`}
                  label={`v${schema.version}`}
                  detail={JSON.stringify(schema.document)}
                  meta={
                    <div className="flex items-center gap-2">
                      <Badge variant={schema.active ? "default" : "secondary"}>
                        {schema.active ? "active" : "inactive"}
                      </Badge>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={schema.active}
                        onClick={() => void handleActivateSchema(schema)}
                      >
                        Activate
                      </Button>
                    </div>
                  }
                />
              ))}
              {schemaVersionRows.length === 0 ? (
                <div className="p-4">
                  <ResourceNotice
                    title={selected ? "No schemas yet" : "Select a collection"}
                    description={
                      selected
                        ? "Register a collection schema to enforce write-time validation and track active versions."
                        : "Choose a collection to view and manage schema versions."
                    }
                  />
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </section>
    </section>
  );
}
