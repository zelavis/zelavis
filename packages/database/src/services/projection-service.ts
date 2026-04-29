import type {
  DatabaseProjectionDefinition,
  DatabaseProjectionRebuildInput,
  DatabaseProjectionRebuildResult,
  DatabaseProjectionsApi,
  DatabaseProjectionSummary,
} from "../contracts/api.js";

function cloneStrings(values?: readonly string[]): string[] | undefined {
  return values ? [...values] : undefined;
}

function summarizeProjection(
  definition: DatabaseProjectionDefinition,
  builtin: boolean,
): DatabaseProjectionSummary {
  return {
    name: definition.name,
    builtin,
    description: definition.description,
    sourceCollections: cloneStrings(definition.source?.collections),
    sourceEventTypes: cloneStrings(definition.source?.eventTypes),
  };
}

function matchesCollections(
  summary: DatabaseProjectionSummary,
  collections?: readonly string[],
): boolean {
  if (!collections || collections.length === 0) {
    return true;
  }

  if (!summary.sourceCollections || summary.sourceCollections.length === 0) {
    return true;
  }

  return summary.sourceCollections.some((collection) =>
    collections.includes(collection),
  );
}

export const BUILTIN_DOCUMENT_PROJECTION_NAME = "documents";

export function createBuiltinDocumentProjectionDefinition(): DatabaseProjectionDefinition {
  return {
    name: BUILTIN_DOCUMENT_PROJECTION_NAME,
    description:
      "Built-in projection that materializes collection and document reads from the event log.",
    source: {
      eventTypes: [
        "collection.created",
        "document.upserted",
        "document.deleted",
      ],
    },
  };
}

export class ProjectionService implements DatabaseProjectionsApi {
  private readonly builtins = new Map<string, DatabaseProjectionDefinition>();
  private readonly registered = new Map<string, DatabaseProjectionDefinition>();

  constructor(builtins: readonly DatabaseProjectionDefinition[] = []) {
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

  async register(definition: DatabaseProjectionDefinition): Promise<void> {
    if (!definition.name || definition.name.length === 0) {
      throw new Error("A projection name is required.");
    }

    if (
      this.builtins.has(definition.name) ||
      this.registered.has(definition.name)
    ) {
      throw new Error(`Projection "${definition.name}" is already registered.`);
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

  async list(): Promise<DatabaseProjectionSummary[]> {
    const builtins = [...this.builtins.values()].map((definition) =>
      summarizeProjection(definition, true),
    );
    const registered = [...this.registered.values()].map((definition) =>
      summarizeProjection(definition, false),
    );

    return [...builtins, ...registered].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async rebuild(
    input: DatabaseProjectionRebuildInput = {},
  ): Promise<DatabaseProjectionRebuildResult> {
    const summaries = await this.list();

    if (input.names && input.names.length > 0) {
      const missing = input.names.filter(
        (name) => !summaries.some((summary) => summary.name === name),
      );

      if (missing.length > 0) {
        throw new Error(
          `Cannot rebuild unknown projections: ${missing.join(", ")}.`,
        );
      }
    }

    const rebuilt = summaries
      .filter((summary) =>
        input.names && input.names.length > 0
          ? input.names.includes(summary.name)
          : true,
      )
      .filter((summary) => matchesCollections(summary, input.collections))
      .map((summary) => summary.name);

    return { rebuilt };
  }
}
