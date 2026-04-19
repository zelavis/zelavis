import type {
  DatabaseAdapter,
  DatabaseDocumentAdapter,
} from "../contracts/adapter.js";
import type {
  CreateCollectionInput,
  DatabaseCollection,
  DatabaseDocument,
  DatabaseDocumentFilter,
  DatabaseDocumentSort,
  DeleteDocumentInput,
  FindDocumentByIdInput,
  FindDocumentsInput,
  InsertDocumentInput,
  ListCollectionsInput,
  UpdateDocumentInput,
} from "../contracts/documents.js";
import type { DatabaseJson, DatabaseJsonObject } from "../contracts/json.js";
import { defineDatabaseAdapter } from "../core/define-database-adapter.js";

interface StoredCollection {
  meta: DatabaseCollection;
  documents: Map<string, DatabaseDocument>;
}

type TenantScoped<TInput extends { tenantId?: string }> = Omit<TInput, "tenantId"> & {
  tenantId: string;
};

function generateId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneJson<T extends DatabaseJson>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneDocument<TData extends DatabaseJsonObject>(
  document: DatabaseDocument<TData>,
): DatabaseDocument<TData> {
  return {
    ...document,
    data: cloneJson(document.data),
    createdAt: new Date(document.createdAt),
    updatedAt: new Date(document.updatedAt),
  };
}

function collectionKey(tenantId: string, name: string): string {
  return `${tenantId}:${name}`;
}

function readPath(data: DatabaseJsonObject, path: string): DatabaseJson | undefined {
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current: unknown = data;

  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current as DatabaseJson | undefined;
}

function compareValues(left: DatabaseJson | undefined, right: DatabaseJson | undefined): number {
  if (left === right) {
    return 0;
  }

  if (left === undefined) {
    return -1;
  }

  if (right === undefined) {
    return 1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }

  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  return leftText < rightText ? -1 : 1;
}

function matchesFilter(document: DatabaseDocument, filter: DatabaseDocumentFilter): boolean {
  const op = filter.op ?? "eq";
  const actual = readPath(document.data, filter.path);

  if (op === "in") {
    return Array.isArray(filter.value) && filter.value.some((item) => compareValues(actual, item) === 0);
  }

  if (Array.isArray(filter.value)) {
    return false;
  }

  const comparison = compareValues(actual, filter.value);

  if (op === "eq") return comparison === 0;
  if (op === "ne") return comparison !== 0;
  if (op === "gt") return comparison > 0;
  if (op === "gte") return comparison >= 0;
  if (op === "lt") return comparison < 0;
  if (op === "lte") return comparison <= 0;

  return false;
}

function sortDocuments(
  documents: DatabaseDocument[],
  orderBy: readonly DatabaseDocumentSort[],
): DatabaseDocument[] {
  if (orderBy.length === 0) {
    return documents;
  }

  return [...documents].sort((left, right) => {
    for (const order of orderBy) {
      const direction = order.direction ?? "asc";
      const result = compareValues(readPath(left.data, order.path), readPath(right.data, order.path));
      if (result !== 0) {
        return direction === "asc" ? result : -result;
      }
    }

    return 0;
  });
}

export function createInMemoryDatabaseAdapter(): DatabaseAdapter {
  const collections = new Map<string, StoredCollection>();

  function getCollection(tenantId: string, name: string): StoredCollection {
    const collection = collections.get(collectionKey(tenantId, name));
    if (!collection) {
      throw new Error(`Collection "${name}" does not exist for tenant "${tenantId}".`);
    }

    return collection;
  }

  const documents: DatabaseDocumentAdapter = {
    async createCollection(input) {
      const key = collectionKey(input.tenantId, input.name);
      if (collections.has(key)) {
        throw new Error(`Collection "${input.name}" already exists for tenant "${input.tenantId}".`);
      }

      const meta: DatabaseCollection = {
        name: input.name,
        tenantId: input.tenantId,
        createdAt: new Date(),
        documentCount: 0,
        metadata: input.metadata,
      };

      collections.set(key, {
        meta,
        documents: new Map(),
      });

      return { ...meta, createdAt: new Date(meta.createdAt) };
    },

    async listCollections(input) {
      return [...collections.values()]
        .filter((collection) => collection.meta.tenantId === input.tenantId)
        .map((collection) => ({
          ...collection.meta,
          createdAt: new Date(collection.meta.createdAt),
        }));
    },

    async collectionExists(input) {
      return collections.has(collectionKey(input.tenantId, input.name));
    },

    async insertDocument<TData extends DatabaseJsonObject>(
      input: TenantScoped<InsertDocumentInput<TData>>,
    ) {
      const collection = getCollection(input.tenantId, input.collection);
      const id = input.id || generateId();
      if (collection.documents.has(id)) {
        throw new Error(`Document "${id}" already exists in collection "${input.collection}".`);
      }

      const now = new Date();
      const document: DatabaseDocument<TData> = {
        id,
        tenantId: input.tenantId,
        collection: input.collection,
        data: cloneJson(input.data),
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      collection.documents.set(id, document);
      collection.meta.documentCount = collection.documents.size;
      return cloneDocument(document);
    },

    async findDocumentById(input) {
      const collection = getCollection(input.tenantId, input.collection);
      const document = collection.documents.get(input.id);
      return document ? cloneDocument(document) : null;
    },

    async findDocuments(input) {
      const collection = getCollection(input.tenantId, input.collection);
      const filtered = [...collection.documents.values()].filter((document) =>
        input.where.every((filter) => matchesFilter(document, filter)),
      );
      const sorted = sortDocuments(filtered, input.orderBy);
      return sorted.slice(input.offset, input.offset + input.limit).map((document) => cloneDocument(document));
    },

    async updateDocument<TData extends DatabaseJsonObject>(
      input: TenantScoped<UpdateDocumentInput<TData>> & { mode: "merge" | "replace" },
    ) {
      const collection = getCollection(input.tenantId, input.collection);
      const current = collection.documents.get(input.id);
      if (!current) {
        throw new Error(`Document "${input.id}" does not exist in collection "${input.collection}".`);
      }

      const nextData =
        input.mode === "replace"
          ? cloneJson(input.data as TData)
          : {
              ...cloneJson(current.data),
              ...cloneJson(input.data as DatabaseJsonObject),
            };
      const next: DatabaseDocument<TData> = {
        ...(current as DatabaseDocument<TData>),
        data: nextData as TData,
        updatedAt: new Date(),
        version: current.version + 1,
      };

      collection.documents.set(input.id, next);
      return cloneDocument(next);
    },

    async deleteDocument(input) {
      const collection = getCollection(input.tenantId, input.collection);
      const deleted = collection.documents.delete(input.id);
      collection.meta.documentCount = collection.documents.size;
      return deleted;
    },
  };

  return defineDatabaseAdapter({
    name: "in-memory",
    capabilities: {
      documents: true,
      sql: false,
      transactions: false,
      tenantRouting: true,
    },
    documents,
  });
}
