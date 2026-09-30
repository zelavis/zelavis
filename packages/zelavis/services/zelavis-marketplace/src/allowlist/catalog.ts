import type { AllowlistService } from "./types.js";

/**
 * What the marketplace lists for one allow-listed service.
 *
 * Metadata only, in the shape the service registry's catalogue uses: nothing
 * here is code, and nothing is installed by listing it.
 */
export interface AllowlistCatalogEntry {
  readonly service: {
    readonly name: string;
    readonly kind: AllowlistService["kind"];
    readonly version: string;
    readonly service: Readonly<Record<string, never>>;
    readonly api: Readonly<Record<string, never>>;
    readonly marketplace: {
      readonly title: string;
      readonly summary?: string;
      readonly categories?: readonly string[];
      readonly tags?: readonly string[];
    };
    readonly project?: { readonly runtimeKinds: readonly string[] };
  };
  /** The exact source to install; never a range or a tag. */
  readonly specifier: string;
  readonly status: "available";
  readonly source: "official" | "community";
  readonly order: number;
}

export function allowlistCatalogEntries(
  services: readonly AllowlistService[],
  firstOrder = 100,
): readonly AllowlistCatalogEntry[] {
  return services.map((entry, index) => ({
    service: {
      name: entry.name,
      kind: entry.kind,
      version: entry.latest,
      service: {},
      api: {},
      marketplace: {
        title: entry.title,
        ...(entry.summary ? { summary: entry.summary } : {}),
        ...(entry.categories ? { categories: entry.categories } : {}),
        ...(entry.tags ? { tags: entry.tags } : {}),
      },
      ...(entry.kind === "app" && entry.runtimeKinds
        ? { project: { runtimeKinds: entry.runtimeKinds } }
        : {}),
    },
    specifier: `npm:${entry.name}@${entry.latest}`,
    status: "available" as const,
    source: entry.maintainer === "zelavis" ? ("official" as const) : ("community" as const),
    order: firstOrder + index,
  }));
}
