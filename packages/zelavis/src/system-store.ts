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

export interface ZelavisSystemStoreNamespace {
  namespace: string;
  recordCount: number;
}

export interface ZelavisSystemStorePage {
  records: readonly ZelavisSystemStoreRecord[];
  next?: string;
}

export interface ZelavisSystemStore {
  /** Logical tables in the Platform store, independent of the physical engine. */
  namespaces(): Promise<readonly ZelavisSystemStoreNamespace[]> | readonly ZelavisSystemStoreNamespace[];
  page(namespace: string, options: { limit: number; after?: string }):
    Promise<ZelavisSystemStorePage> | ZelavisSystemStorePage;
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
    /** When supplied, compare the observed value atomically too (ABA protection). */
    expectedValue?: ZelavisSystemStoreValue,
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
    namespaces() {
      const counts = new Map<string, number>();
      for (const record of records.values()) counts.set(record.namespace, (counts.get(record.namespace) ?? 0) + 1);
      return [...counts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([namespace, recordCount]) => ({ namespace, recordCount }));
    },
    page(namespace, { limit, after }) {
      const name = normalizePart(namespace, "namespace");
      const rows = [...records.values()].filter(record => record.namespace === name &&
        (after === undefined || record.key > after)).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
        .slice(0, limit + 1);
      return { records: rows.slice(0, limit).map(cloneRecord),
        ...(rows.length > limit ? { next: rows[limit - 1]!.key } : {}) };
    },
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
    compareAndSet(namespace, key, expectedUpdatedAt, value, expectedValue) {
      const normalizedNamespace = normalizePart(namespace, "namespace");
      const normalizedKey = normalizePart(key, "key");
      const id = recordId(normalizedNamespace, normalizedKey);
      const existing = records.get(id);
      if (!existing || existing.updatedAt !== expectedUpdatedAt ||
          (expectedValue !== undefined && JSON.stringify(existing.value) !== JSON.stringify(expectedValue))) return undefined;
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
