import type {
  DatabaseEventsApi,
  DatabaseProjectionSummary,
  DatabaseProjectionsApi,
  DatabaseTimeSeriesAggregateInput,
  DatabaseTimeSeriesApi,
  DatabaseTimeSeriesDefinition,
  DatabaseTimeSeriesDefinitionVersion,
  DatabaseTimeSeriesHandle,
  DatabaseTimeSeriesMapperContext,
  DatabaseTimeSeriesPoint,
  DatabaseTimeSeriesRangeInput,
  DatabaseTimeSeriesSummary,
} from "../contracts/api.js";
import type {
  DatabaseTimeSeriesStorageDriver,
  DatabaseTimeSeriesStoredPoint,
} from "../contracts/driver.js";
import type { DatabaseEvent } from "../contracts/events.js";
import type { DatabaseJson } from "../contracts/json.js";
import {
  DatabaseNotFoundError,
  DatabaseValidationError,
} from "../core/errors.js";

function cloneSummary(
  summary: DatabaseTimeSeriesSummary,
): DatabaseTimeSeriesSummary {
  return {
    name: summary.name,
    description: summary.description,
    ...(summary.version === undefined ? {} : { version: summary.version }),
    projection: summary.projection,
  };
}

function toSummary(
  definition: DatabaseTimeSeriesDefinition,
): DatabaseTimeSeriesSummary {
  return {
    name: definition.name,
    description: definition.description,
    ...(definition.version === undefined
      ? {}
      : { version: definition.version }),
    projection: definition.projection,
  };
}

function cloneDefinition(
  definition: DatabaseTimeSeriesDefinition,
): DatabaseTimeSeriesDefinition {
  return {
    name: definition.name,
    description: definition.description,
    version: definition.version,
    source: definition.source
      ? {
          collections: definition.source.collections
            ? [...definition.source.collections]
            : undefined,
          eventTypes: definition.source.eventTypes
            ? [...definition.source.eventTypes]
            : undefined,
        }
      : undefined,
    projection: definition.projection,
    map: definition.map,
  };
}

function definitionVersion(
  definition: DatabaseTimeSeriesDefinition,
): DatabaseTimeSeriesDefinitionVersion {
  return definition.version ?? 1;
}

function clonePoint(point: DatabaseTimeSeriesPoint): DatabaseTimeSeriesPoint {
  return {
    timestamp:
      point.timestamp instanceof Date
        ? new Date(point.timestamp)
        : point.timestamp,
    value: point.value,
    tags: point.tags ? { ...point.tags } : undefined,
    fields: point.fields
      ? (JSON.parse(JSON.stringify(point.fields)) as Record<
          string,
          DatabaseJson
        >)
      : undefined,
  };
}

function toTimestampValue(value: number | string | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return value;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid time-series timestamp "${value}".`);
  }

  return parsed;
}

function readBoundary(
  value: number | string | Date | undefined,
): number | null {
  return value === undefined ? null : toTimestampValue(value);
}

function normalizePoint(
  series: string,
  point: DatabaseTimeSeriesPoint,
): DatabaseTimeSeriesPoint {
  if (!Number.isFinite(toTimestampValue(point.timestamp))) {
    throw new Error(`Time-series "${series}" produced an invalid timestamp.`);
  }

  if (!Number.isFinite(point.value)) {
    throw new Error(`Time-series "${series}" produced a non-finite value.`);
  }

  return clonePoint(point);
}

function matchesSource(
  definition: DatabaseTimeSeriesDefinition,
  event: DatabaseEvent,
): boolean {
  const collections = definition.source?.collections;
  const eventTypes = definition.source?.eventTypes;

  if (
    collections &&
    collections.length > 0 &&
    !collections.includes(event.collection)
  ) {
    return false;
  }

  if (eventTypes && eventTypes.length > 0 && !eventTypes.includes(event.type)) {
    return false;
  }

  return true;
}

function filterPoints(
  points: readonly DatabaseTimeSeriesPoint[],
  input: DatabaseTimeSeriesRangeInput | DatabaseTimeSeriesAggregateInput = {},
): DatabaseTimeSeriesPoint[] {
  const start = readBoundary(input.start);
  const end = readBoundary(input.end);

  return points.filter((point) => {
    const timestamp = toTimestampValue(point.timestamp);
    if (start !== null && timestamp < start) {
      return false;
    }
    if (end !== null && timestamp > end) {
      return false;
    }
    return true;
  });
}

function sortPoints(
  points: readonly DatabaseTimeSeriesPoint[],
  order: "asc" | "desc" = "asc",
): DatabaseTimeSeriesPoint[] {
  return [...points].sort((left, right) => {
    const result =
      toTimestampValue(left.timestamp) - toTimestampValue(right.timestamp);
    return order === "asc" ? result : -result;
  });
}

async function readAllEvents(
  events: DatabaseEventsApi,
  afterSequence = 0,
  collection?: string,
): Promise<DatabaseEvent[]> {
  const result: DatabaseEvent[] = [];
  let cursor = afterSequence;
  const limit = 500;

  while (true) {
    const page = await events.read({
      afterSequence: cursor,
      collection,
      limit,
    });
    if (page.length === 0) {
      break;
    }

    result.push(...page);
    cursor = page[page.length - 1].sequence;

    if (page.length < limit) {
      break;
    }
  }

  return result;
}

export class TimeSeriesService implements DatabaseTimeSeriesApi {
  private readonly definitions = new Map<
    string,
    DatabaseTimeSeriesDefinition
  >();

  constructor(
    private readonly projections: DatabaseProjectionsApi,
    private readonly events: DatabaseEventsApi,
    private readonly storage: DatabaseTimeSeriesStorageDriver | undefined,
    private readonly defaultTenantId: string,
  ) {}

  private async ensureProjectionExists(
    name: string,
  ): Promise<DatabaseProjectionSummary> {
    const projections = await this.projections.list();
    const projection = projections.find((candidate) => candidate.name === name);

    if (!projection) {
      throw new DatabaseNotFoundError(
        `Unknown projection "${name}" for time-series definition.`,
      );
    }

    return projection;
  }

  private async derivePoints(
    definition: DatabaseTimeSeriesDefinition,
    afterSequence = 0,
  ): Promise<{
    lastSequence: number;
    points: DatabaseTimeSeriesStoredPoint[];
  }> {
    if (!definition.map) {
      throw new DatabaseValidationError(
        `Time-series "${definition.name}" does not define an event mapper yet.`,
      );
    }

    const context: DatabaseTimeSeriesMapperContext = {
      series: definition.name,
    };
    const collection =
      definition.source?.collections?.length === 1
        ? definition.source.collections[0]
        : undefined;
    const events = await readAllEvents(this.events, afterSequence, collection);
    const points: DatabaseTimeSeriesStoredPoint[] = [];
    let lastSequence = afterSequence;

    for (const event of events) {
      lastSequence = event.sequence;

      if (!matchesSource(definition, event)) {
        continue;
      }

      const mapped = definition.map(event, context);
      if (!mapped) {
        continue;
      }

      const batch = Array.isArray(mapped) ? mapped : [mapped];
      for (const [pointIndex, point] of batch.entries()) {
        points.push({
          sourceSequence: event.sequence,
          pointIndex,
          point: normalizePoint(definition.name, point),
        });
      }
    }

    return { lastSequence, points };
  }

  private async syncStoredSeries(
    definition: DatabaseTimeSeriesDefinition,
  ): Promise<DatabaseTimeSeriesDefinitionVersion | null> {
    if (!this.storage) {
      return null;
    }

    if (!definition.map) {
      throw new DatabaseValidationError(
        `Time-series "${definition.name}" does not define an event mapper yet.`,
      );
    }

    const version = definitionVersion(definition);
    const state = await this.storage.getState({
      tenantId: this.defaultTenantId,
      series: definition.name,
    });

    let afterSequence = 0;
    if (!state || state.version !== String(version)) {
      await this.storage.reset({
        tenantId: this.defaultTenantId,
        series: definition.name,
        version,
      });
    } else {
      afterSequence = state.lastSequence;
    }

    const batch = await this.derivePoints(definition, afterSequence);
    await this.storage.append({
      tenantId: this.defaultTenantId,
      series: definition.name,
      version,
      lastSequence: batch.lastSequence,
      points: batch.points,
    });

    return version;
  }

  async define(definition: DatabaseTimeSeriesDefinition): Promise<void> {
    if (!definition.name || definition.name.length === 0) {
      throw new Error("A time-series name is required.");
    }

    if (this.definitions.has(definition.name)) {
      throw new Error(`Time-series "${definition.name}" is already defined.`);
    }

    if (definition.projection) {
      await this.ensureProjectionExists(definition.projection);
    }

    this.definitions.set(definition.name, cloneDefinition(definition));
  }

  async list(): Promise<DatabaseTimeSeriesSummary[]> {
    return [...this.definitions.values()]
      .map((definition) => toSummary(definition))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((summary) => cloneSummary(summary));
  }

  get(name: string): DatabaseTimeSeriesHandle {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`Time-series "${name}" is not defined.`);
    }

    return {
      range: async (input: DatabaseTimeSeriesRangeInput = {}) => {
        const version = await this.syncStoredSeries(definition);

        if (this.storage && version !== null) {
          const points = await this.storage.range({
            tenantId: this.defaultTenantId,
            series: definition.name,
            version,
            ...input,
          });

          return points.map((point) => clonePoint(point));
        }

        const points = (await this.derivePoints(definition)).points.map(
          (entry) => entry.point,
        );
        const filtered = filterPoints(points, input);
        const sorted = sortPoints(filtered, input.order ?? "asc");
        const limited =
          input.limit === undefined ? sorted : sorted.slice(0, input.limit);

        return limited.map((point) => clonePoint(point));
      },
      aggregate: async (input: DatabaseTimeSeriesAggregateInput) => {
        const version = await this.syncStoredSeries(definition);

        if (this.storage && version !== null) {
          return this.storage.aggregate({
            tenantId: this.defaultTenantId,
            series: definition.name,
            version,
            ...input,
          });
        }

        const values = filterPoints(
          (await this.derivePoints(definition)).points.map(
            (entry) => entry.point,
          ),
          input,
        ).map((point) => point.value);

        if (input.op === "count") {
          return values.length;
        }

        if (values.length === 0) {
          return 0;
        }

        if (input.op === "sum") {
          return values.reduce((sum, value) => sum + value, 0);
        }

        if (input.op === "avg") {
          return values.reduce((sum, value) => sum + value, 0) / values.length;
        }

        if (input.op === "min") {
          return Math.min(...values);
        }

        return Math.max(...values);
      },
    };
  }
}
