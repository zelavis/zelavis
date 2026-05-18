import type {
  DashboardContentPreferences,
  DatabaseCollection,
  DatabaseSchemaCollectionSummary,
} from "#/lib/runtime-api";

export interface ContentTypeRow {
  name: string;
  label: string;
  documentCount: number;
  tenantId: string;
  activeVersion: number | null;
  versions: number[];
  pinned: boolean;
  pinnedIndex: number;
}

export function slugifyContentTypeLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getContentTypeLabel(
  name: string,
  preferences: DashboardContentPreferences | undefined,
): string {
  const label = preferences?.labels?.[name]?.trim();
  return label && label.length > 0 ? label : name;
}

export function buildContentTypeRows(
  collections: readonly DatabaseCollection[],
  schemaCollections: readonly DatabaseSchemaCollectionSummary[],
  preferences: DashboardContentPreferences | undefined,
): ContentTypeRow[] {
  const schemaMap = new Map(
    schemaCollections.map((entry) => [entry.collection, entry] as const),
  );
  const pinnedTypes = preferences?.pinnedTypes ?? [];
  const pinnedIndexByName = new Map(
    pinnedTypes.map((name, index) => [name, index] as const),
  );

  return collections
    .map((collection) => ({
      name: collection.name,
      label: getContentTypeLabel(collection.name, preferences),
      documentCount: collection.documentCount,
      tenantId: collection.tenantId,
      activeVersion: schemaMap.get(collection.name)?.activeVersion ?? null,
      versions: schemaMap.get(collection.name)?.versions ?? [],
      pinned: pinnedIndexByName.has(collection.name),
      pinnedIndex: pinnedIndexByName.get(collection.name) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }

      if (left.pinned && right.pinned && left.pinnedIndex !== right.pinnedIndex) {
        return left.pinnedIndex - right.pinnedIndex;
      }

      return left.label.localeCompare(right.label);
    });
}
