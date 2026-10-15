/** Content Studio's pure helpers: how a collection becomes a content type row, and what a type is called. */
export interface ContentPreferences { pinnedTypes?: readonly string[]; labels?: Readonly<Record<string, string>> }

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

export const INTERNAL_COLLECTIONS = new Set(["zelavis_system"]);

export function slugifyContentTypeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function getContentTypeLabel(name: string, preferences: ContentPreferences | undefined): string {
  const label = preferences?.labels?.[name]?.trim();
  return label && label.length > 0 ? label : name;
}

/** Order by code point, the one order every host agrees on. */
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function buildContentTypeRows(
  collections: readonly { name: string; surface?: string; documentCount: number; tenantId: string }[],
  schemaCollections: readonly { collection: string; activeVersion?: number | null; versions?: number[] }[],
  preferences: ContentPreferences | undefined
): ContentTypeRow[] {
  const schemas = new Map(schemaCollections.map(entry => [entry.collection, entry] as const));
  const pinned = new Map((preferences?.pinnedTypes ?? []).map((name, index) => [name, index] as const));
  return collections
    .filter(collection => !INTERNAL_COLLECTIONS.has(collection.name) && collection.surface === "content-studio")
    .map(collection => ({
      name: collection.name,
      label: getContentTypeLabel(collection.name, preferences),
      documentCount: collection.documentCount,
      tenantId: collection.tenantId,
      activeVersion: schemas.get(collection.name)?.activeVersion ?? null,
      versions: schemas.get(collection.name)?.versions ?? [],
      pinned: pinned.has(collection.name),
      pinnedIndex: pinned.get(collection.name) ?? Number.MAX_SAFE_INTEGER
    }))
    .sort((left, right) => left.pinned !== right.pinned ? (left.pinned ? -1 : 1) : left.pinned && left.pinnedIndex !== right.pinnedIndex ? left.pinnedIndex - right.pinnedIndex : compare(left.label, right.label));
}

/** The pinned order after moving `source` onto `target`'s place. */
export function reorderPinned(pinned: readonly string[], source: string, target: string): string[] | undefined {
  const from = pinned.indexOf(source);
  const to = pinned.indexOf(target);
  if (from === -1 || to === -1 || source === target) return undefined;
  const next = [...pinned];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
