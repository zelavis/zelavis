import { DatabaseNotFoundError, DatabaseValidationError, } from "../core/errors.js";
function cloneSummary(summary) {
    return {
        name: summary.name,
        description: summary.description,
        ...(summary.version === undefined ? {} : { version: summary.version }),
        projection: summary.projection,
    };
}
function toSummary(definition) {
    return {
        name: definition.name,
        description: definition.description,
        ...(definition.version === undefined
            ? {}
            : { version: definition.version }),
        projection: definition.projection,
    };
}
function cloneDefinition(definition) {
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
function definitionVersion(definition) {
    return definition.version ?? 1;
}
function clonePoint(point) {
    return {
        timestamp: point.timestamp instanceof Date
            ? new Date(point.timestamp)
            : point.timestamp,
        value: point.value,
        tags: point.tags ? { ...point.tags } : undefined,
        fields: point.fields
            ? JSON.parse(JSON.stringify(point.fields))
            : undefined,
    };
}
function toTimestampValue(value) {
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
function readBoundary(value) {
    return value === undefined ? null : toTimestampValue(value);
}
function normalizePoint(series, point) {
    if (!Number.isFinite(toTimestampValue(point.timestamp))) {
        throw new Error(`Time-series "${series}" produced an invalid timestamp.`);
    }
    if (!Number.isFinite(point.value)) {
        throw new Error(`Time-series "${series}" produced a non-finite value.`);
    }
    return clonePoint(point);
}
function matchesSource(definition, event) {
    const collections = definition.source?.collections;
    const eventTypes = definition.source?.eventTypes;
    if (collections &&
        collections.length > 0 &&
        !collections.includes(event.collection)) {
        return false;
    }
    if (eventTypes && eventTypes.length > 0 && !eventTypes.includes(event.type)) {
        return false;
    }
    return true;
}
function filterPoints(points, input = {}) {
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
function sortPoints(points, order = "asc") {
    return [...points].sort((left, right) => {
        const result = toTimestampValue(left.timestamp) - toTimestampValue(right.timestamp);
        return order === "asc" ? result : -result;
    });
}
async function readAllEvents(events, afterSequence = 0, collection) {
    const result = [];
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
export class TimeSeriesService {
    projections;
    events;
    storage;
    defaultTenantId;
    definitions = new Map();
    constructor(projections, events, storage, defaultTenantId) {
        this.projections = projections;
        this.events = events;
        this.storage = storage;
        this.defaultTenantId = defaultTenantId;
    }
    async ensureProjectionExists(name) {
        const projections = await this.projections.list();
        const projection = projections.find((candidate) => candidate.name === name);
        if (!projection) {
            throw new DatabaseNotFoundError(`Unknown projection "${name}" for time-series definition.`);
        }
        return projection;
    }
    async derivePoints(definition, afterSequence = 0) {
        if (!definition.map) {
            throw new DatabaseValidationError(`Time-series "${definition.name}" does not define an event mapper yet.`);
        }
        const context = {
            series: definition.name,
        };
        const collection = definition.source?.collections?.length === 1
            ? definition.source.collections[0]
            : undefined;
        const events = await readAllEvents(this.events, afterSequence, collection);
        const points = [];
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
    async syncStoredSeries(definition) {
        if (!this.storage) {
            return null;
        }
        if (!definition.map) {
            throw new DatabaseValidationError(`Time-series "${definition.name}" does not define an event mapper yet.`);
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
        }
        else {
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
    async define(definition) {
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
    async list() {
        return [...this.definitions.values()]
            .map((definition) => toSummary(definition))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((summary) => cloneSummary(summary));
    }
    get(name) {
        const definition = this.definitions.get(name);
        if (!definition) {
            throw new Error(`Time-series "${name}" is not defined.`);
        }
        return {
            range: async (input = {}) => {
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
                const points = (await this.derivePoints(definition)).points.map((entry) => entry.point);
                const filtered = filterPoints(points, input);
                const sorted = sortPoints(filtered, input.order ?? "asc");
                const limited = input.limit === undefined ? sorted : sorted.slice(0, input.limit);
                return limited.map((point) => clonePoint(point));
            },
            aggregate: async (input) => {
                const version = await this.syncStoredSeries(definition);
                if (this.storage && version !== null) {
                    return this.storage.aggregate({
                        tenantId: this.defaultTenantId,
                        series: definition.name,
                        version,
                        ...input,
                    });
                }
                const values = filterPoints((await this.derivePoints(definition)).points.map((entry) => entry.point), input).map((point) => point.value);
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
