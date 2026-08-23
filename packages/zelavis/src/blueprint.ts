export type ZelavisBlueprintKind =
  | "zelavis-app"
  | "wordpress"
  | "laravel"
  | "drupal"
  | "static-site"
  | "generic";

export type ZelavisBlueprintRuntime = "javascript" | "php" | "static" | "custom";

export interface ZelavisBlueprintService {
  package: string;
  version: string;
  required?: boolean;
}

export interface ZelavisBlueprintManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  kind: ZelavisBlueprintKind;
  description: string;
  source: "official" | "community" | "local";
  status: "development" | "stable";
  runtime: {
    type: ZelavisBlueprintRuntime;
    engines?: readonly ("node" | "bun" | "deno")[];
  };
  services?: readonly ZelavisBlueprintService[];
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ZelavisBlueprintEntry {
  manifest: ZelavisBlueprintManifest;
  directory?: string;
  origin: "shipped" | "cache" | "custom";
}

export interface ZelavisBlueprintRegistry {
  list(): readonly ZelavisBlueprintEntry[];
  get(id: string, version?: string): ZelavisBlueprintEntry | undefined;
}

const blueprintKinds = new Set<ZelavisBlueprintKind>([
  "zelavis-app",
  "wordpress",
  "laravel",
  "drupal",
  "static-site",
  "generic",
]);
const blueprintRuntimes = new Set<ZelavisBlueprintRuntime>([
  "javascript",
  "php",
  "static",
  "custom",
]);
const javascriptEngines = new Set(["node", "bun", "deno"] as const);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Blueprint ${field} must be a non-empty string.`);
  }

  return value.trim();
}

export function parseBlueprintManifest(input: unknown): ZelavisBlueprintManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Blueprint manifest must be an object.");
  }

  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new TypeError("Blueprint schemaVersion must be 1.");
  }
  if (!blueprintKinds.has(value.kind as ZelavisBlueprintKind)) {
    throw new TypeError("Blueprint kind is not supported.");
  }
  if (value.source !== "official" && value.source !== "community" && value.source !== "local") {
    throw new TypeError("Blueprint source is not supported.");
  }
  if (value.status !== "development" && value.status !== "stable") {
    throw new TypeError("Blueprint status is not supported.");
  }
  if (!value.runtime || typeof value.runtime !== "object" || Array.isArray(value.runtime)) {
    throw new TypeError("Blueprint runtime must be an object.");
  }

  const runtime = value.runtime as Record<string, unknown>;
  if (!blueprintRuntimes.has(runtime.type as ZelavisBlueprintRuntime)) {
    throw new TypeError("Blueprint runtime type is not supported.");
  }

  const engines = runtime.engines === undefined
    ? undefined
    : Array.isArray(runtime.engines)
      ? runtime.engines.map((engine) => {
          if (!javascriptEngines.has(engine as "node" | "bun" | "deno")) {
            throw new TypeError("Blueprint runtime engine is not supported.");
          }
          return engine as "node" | "bun" | "deno";
        })
      : (() => {
          throw new TypeError("Blueprint runtime engines must be an array.");
        })();

  const services: ZelavisBlueprintService[] | undefined = value.services === undefined
    ? undefined
    : Array.isArray(value.services)
      ? value.services.map((service) => {
          if (!service || typeof service !== "object" || Array.isArray(service)) {
            throw new TypeError("Blueprint services must be objects.");
          }
          const definition = service as Record<string, unknown>;
          return {
            package: requiredString(definition.package, "service package"),
            version: requiredString(definition.version, "service version"),
            ...(definition.required === undefined
              ? {}
              : typeof definition.required === "boolean"
                ? { required: definition.required }
                : (() => {
                    throw new TypeError("Blueprint service required must be boolean.");
                  })()),
          };
        })
      : (() => {
          throw new TypeError("Blueprint services must be an array.");
        })();

  const metadata = value.metadata === undefined
    ? undefined
    : value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? Object.fromEntries(
          Object.entries(value.metadata).map(([key, metadataValue]) => {
            if (
              typeof metadataValue !== "string" &&
              typeof metadataValue !== "number" &&
              typeof metadataValue !== "boolean"
            ) {
              throw new TypeError("Blueprint metadata values must be scalar.");
            }
            return [key, metadataValue];
          }),
        )
      : (() => {
          throw new TypeError("Blueprint metadata must be an object.");
        })();

  return Object.freeze({
    schemaVersion: 1,
    id: requiredString(value.id, "id"),
    name: requiredString(value.name, "name"),
    version: requiredString(value.version, "version"),
    kind: value.kind as ZelavisBlueprintKind,
    description: requiredString(value.description, "description"),
    source: value.source,
    status: value.status,
    runtime: Object.freeze({
      type: runtime.type as ZelavisBlueprintRuntime,
      ...(engines ? { engines: Object.freeze(engines) } : {}),
    }),
    ...(services
      ? { services: Object.freeze(services.map((service) => Object.freeze(service))) }
      : {}),
    ...(metadata ? { metadata: Object.freeze(metadata) } : {}),
  });
}

export function createBlueprintRegistry(
  entries: readonly ZelavisBlueprintEntry[] = [],
): ZelavisBlueprintRegistry {
  const normalized = entries
    .map((entry) => Object.freeze({
      ...entry,
      manifest: parseBlueprintManifest(entry.manifest),
    }))
    .sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name) ||
      right.manifest.version.localeCompare(left.manifest.version),
    );
  const identities = new Set<string>();

  for (const entry of normalized) {
    const identity = `${entry.manifest.id}@${entry.manifest.version}`;
    if (identities.has(identity)) {
      throw new TypeError(`Duplicate blueprint ${identity}.`);
    }
    identities.add(identity);
  }

  const registry: ZelavisBlueprintRegistry = {
    list: () => normalized,
    get(id: string, version?: string) {
      const normalizedId = id.trim();
      return normalized.find((entry) =>
        entry.manifest.id === normalizedId &&
        (version === undefined || entry.manifest.version === version),
      );
    },
  };

  return Object.freeze(registry);
}
