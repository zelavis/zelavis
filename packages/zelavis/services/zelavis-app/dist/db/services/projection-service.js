import { DatabaseConflictError, DatabaseDomainError, DatabaseNotFoundError, } from "../core/errors.js";
import { err, ok } from "../core/result.js";
function cloneStrings(values) {
    return values ? [...values] : undefined;
}
function summarizeProjection(definition, builtin) {
    return {
        name: definition.name,
        builtin,
        description: definition.description,
        sourceCollections: cloneStrings(definition.source?.collections),
        sourceEventTypes: cloneStrings(definition.source?.eventTypes),
    };
}
function matchesCollections(summary, collections) {
    if (!collections || collections.length === 0) {
        return true;
    }
    if (!summary.sourceCollections || summary.sourceCollections.length === 0) {
        return true;
    }
    return summary.sourceCollections.some((collection) => collections.includes(collection));
}
export const BUILTIN_DOCUMENT_PROJECTION_NAME = "documents";
function validateProjectionRegistration(definition, builtins, registered) {
    if (!definition.name || definition.name.length === 0) {
        return err({
            kind: "missing-name",
        });
    }
    if (builtins.has(definition.name) || registered.has(definition.name)) {
        return err({
            kind: "duplicate-name",
            name: definition.name,
        });
    }
    return ok(definition);
}
function toProjectionRegistrationError(failure) {
    if (failure.kind === "duplicate-name") {
        return new DatabaseConflictError(`Projection "${failure.name}" is already registered.`);
    }
    return new DatabaseDomainError("A projection name is required.");
}
export function createBuiltinDocumentProjectionDefinition() {
    return {
        name: BUILTIN_DOCUMENT_PROJECTION_NAME,
        description: "Built-in projection that materializes collection and document reads from the event log.",
        source: {
            eventTypes: [
                "collection.created",
                "document.upserted",
                "document.deleted",
            ],
        },
    };
}
export class ProjectionService {
    builtins = new Map();
    registered = new Map();
    constructor(builtins = []) {
        for (const definition of builtins) {
            if (!definition.name || definition.name.length === 0) {
                throw new Error("A projection name is required.");
            }
            this.builtins.set(definition.name, {
                ...definition,
                source: definition.source
                    ? {
                        collections: cloneStrings(definition.source.collections),
                        eventTypes: cloneStrings(definition.source.eventTypes),
                    }
                    : undefined,
            });
        }
    }
    async register(definition) {
        const validation = validateProjectionRegistration(definition, this.builtins, this.registered);
        if (!validation.ok) {
            throw toProjectionRegistrationError(validation.error);
        }
        this.registered.set(definition.name, {
            ...definition,
            source: definition.source
                ? {
                    collections: cloneStrings(definition.source.collections),
                    eventTypes: cloneStrings(definition.source.eventTypes),
                }
                : undefined,
        });
    }
    async list() {
        const builtins = [...this.builtins.values()].map((definition) => summarizeProjection(definition, true));
        const registered = [...this.registered.values()].map((definition) => summarizeProjection(definition, false));
        return [...builtins, ...registered].sort((left, right) => left.name.localeCompare(right.name));
    }
    async rebuild(input = {}) {
        const summaries = await this.list();
        if (input.names && input.names.length > 0) {
            const missing = input.names.filter((name) => !summaries.some((summary) => summary.name === name));
            if (missing.length > 0) {
                throw new DatabaseNotFoundError(`Cannot rebuild unknown projections: ${missing.join(", ")}.`);
            }
        }
        const rebuilt = summaries
            .filter((summary) => input.names && input.names.length > 0
            ? input.names.includes(summary.name)
            : true)
            .filter((summary) => matchesCollections(summary, input.collections))
            .map((summary) => summary.name);
        return { rebuilt };
    }
}
