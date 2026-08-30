export type ZelavisSystemStoreValue =
  | null
  | boolean
  | number
  | string
  | readonly ZelavisSystemStoreValue[]
  | { readonly [key: string]: ZelavisSystemStoreValue };

export interface ZelavisSystemStoreRecord {
  namespace: string;
  key: string;
  value: ZelavisSystemStoreValue;
  updatedAt: string;
}

export interface ZelavisSystemStore {
  get(
    namespace: string,
    key: string,
  ):
    | Promise<ZelavisSystemStoreRecord | undefined>
    | ZelavisSystemStoreRecord
    | undefined;
  set(
    namespace: string,
    key: string,
    value: ZelavisSystemStoreValue,
  ): Promise<ZelavisSystemStoreRecord> | ZelavisSystemStoreRecord;
  setIfAbsent(
    namespace: string,
    key: string,
    value: ZelavisSystemStoreValue,
  ):
    | Promise<{ created: boolean; record: ZelavisSystemStoreRecord }>
    | { created: boolean; record: ZelavisSystemStoreRecord };
  compareAndSet(
    namespace: string,
    key: string,
    expectedUpdatedAt: string,
    value: ZelavisSystemStoreValue,
  ):
    | Promise<ZelavisSystemStoreRecord | undefined>
    | ZelavisSystemStoreRecord
    | undefined;
  compareAndDelete(
    namespace: string,
    key: string,
    expectedUpdatedAt: string,
  ): Promise<boolean> | boolean;
  delete(namespace: string, key: string): Promise<boolean> | boolean;
  list(
    namespace: string,
  ):
    | Promise<readonly ZelavisSystemStoreRecord[]>
    | readonly ZelavisSystemStoreRecord[];
  /**
   * Releases resources the store holds, such as a local database handle.
   *
   * Optional and idempotent, so embeddable and custom stores stay valid without
   * implementing it. Without this a repeatedly constructed embedded runtime
   * retains SQLite handles until the process exits.
   */
  close?(): Promise<void> | void;
}

function normalizePart(value: string, label: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new TypeError(`System Store ${label} must be a non-empty string.`);
  }

  return normalized;
}

function cloneValue(value: ZelavisSystemStoreValue): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(value)) as ZelavisSystemStoreValue;
}

function cloneRecord(record: ZelavisSystemStoreRecord): ZelavisSystemStoreRecord {
  return {
    ...record,
    value: cloneValue(record.value),
  };
}

function timestampAfter(previous: string): string {
  const previousTime = Date.parse(previous);
  return new Date(
    Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0),
  ).toISOString();
}

export function createMemorySystemStore(): ZelavisSystemStore {
  const records = new Map<string, ZelavisSystemStoreRecord>();
  const recordId = (namespace: string, key: string) => `${namespace}\u0000${key}`;

  return {
    get(namespace, key) {
      const record = records.get(
        recordId(
          normalizePart(namespace, "namespace"),
          normalizePart(key, "key"),
        ),
      );
      return record ? cloneRecord(record) : undefined;
    },
    set(namespace, key, value) {
      const normalizedNamespace = normalizePart(namespace, "namespace");
      const normalizedKey = normalizePart(key, "key");
      const existing = records.get(recordId(normalizedNamespace, normalizedKey));
      const record: ZelavisSystemStoreRecord = {
        namespace: normalizedNamespace,
        key: normalizedKey,
        value: cloneValue(value),
        updatedAt: existing
          ? timestampAfter(existing.updatedAt)
          : new Date().toISOString(),
      };
      records.set(recordId(normalizedNamespace, normalizedKey), record);
      return cloneRecord(record);
    },
    setIfAbsent(namespace, key, value) {
      const normalizedNamespace = normalizePart(namespace, "namespace");
      const normalizedKey = normalizePart(key, "key");
      const id = recordId(normalizedNamespace, normalizedKey);
      const existing = records.get(id);
      if (existing) return { created: false, record: cloneRecord(existing) };
      const record: ZelavisSystemStoreRecord = {
        namespace: normalizedNamespace,
        key: normalizedKey,
        value: cloneValue(value),
        updatedAt: new Date().toISOString(),
      };
      records.set(id, record);
      return { created: true, record: cloneRecord(record) };
    },
    compareAndSet(namespace, key, expectedUpdatedAt, value) {
      const normalizedNamespace = normalizePart(namespace, "namespace");
      const normalizedKey = normalizePart(key, "key");
      const id = recordId(normalizedNamespace, normalizedKey);
      const existing = records.get(id);
      if (!existing || existing.updatedAt !== expectedUpdatedAt) return undefined;
      const record: ZelavisSystemStoreRecord = {
        namespace: normalizedNamespace,
        key: normalizedKey,
        value: cloneValue(value),
        updatedAt: timestampAfter(existing.updatedAt),
      };
      records.set(id, record);
      return cloneRecord(record);
    },
    compareAndDelete(namespace, key, expectedUpdatedAt) {
      const normalizedNamespace = normalizePart(namespace, "namespace");
      const normalizedKey = normalizePart(key, "key");
      const id = recordId(normalizedNamespace, normalizedKey);
      const existing = records.get(id);
      if (!existing || existing.updatedAt !== expectedUpdatedAt) return false;
      return records.delete(id);
    },
    delete(namespace, key) {
      return records.delete(
        recordId(
          normalizePart(namespace, "namespace"),
          normalizePart(key, "key"),
        ),
      );
    },
    list(namespace) {
      const normalizedNamespace = normalizePart(namespace, "namespace");
      return [...records.values()]
        .filter((record) => record.namespace === normalizedNamespace)
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(cloneRecord);
    },
  };
}
