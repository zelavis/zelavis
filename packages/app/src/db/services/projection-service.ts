import type {
  DatabaseProjectionDefinition,
  DatabaseProjectionRebuildInput,
  DatabaseProjectionRebuildResult,
  DatabaseProjectionsApi,
  DatabaseProjectionSummary,
} from "../contracts/api.js";
import {
  DatabaseConflictError,
  DatabaseDomainError,
  DatabaseNotFoundError,
} from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";

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

type ProjectionRegistrationFailure =
  | {
      kind: "missing-name";
    }
  | {
      kind: "duplicate-name";
      name: string;
    };

function validateProjectionRegistration(
  definition: DatabaseProjectionDefinition,
  builtins: ReadonlyMap<string, DatabaseProjectionDefinition>,
  registered: ReadonlyMap<string, DatabaseProjectionDefinition>,
): Result<DatabaseProjectionDefinition, ProjectionRegistrationFailure> {
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

function toProjectionRegistrationError(
  failure: ProjectionRegistrationFailure,
): DatabaseDomainError {
  if (failure.kind === "duplicate-name") {
    return new DatabaseConflictError(
      `Projection "${failure.name}" is already registered.`,
    );
  }

  return new DatabaseDomainError("A projection name is required.");
}

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
    const validation = validateProjectionRegistration(
      definition,
      this.builtins,
      this.registered,
    );

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
        throw new DatabaseNotFoundError(
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
