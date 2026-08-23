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
  delete(namespace: string, key: string): Promise<boolean> | boolean;
  list(
    namespace: string,
  ):
    | Promise<readonly ZelavisSystemStoreRecord[]>
    | readonly ZelavisSystemStoreRecord[];
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
      const record: ZelavisSystemStoreRecord = {
        namespace: normalizedNamespace,
        key: normalizedKey,
        value: cloneValue(value),
        updatedAt: new Date().toISOString(),
      };
      records.set(recordId(normalizedNamespace, normalizedKey), record);
      return cloneRecord(record);
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
