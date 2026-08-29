/**
 * BundleStore — read-side abstraction for service app assets.
 *
 * The dispatcher needs to serve static files belonging to a service's `app`
 * field. The service doesn't care where those bytes live; the host doesn't
 * want to bake in a single storage backend. `BundleStore` is the seam.
 *
 * Two implementations ship by default:
 *
 * - `SharedBundleStore` (this file) — single underlying `ZelavisFileStorage`,
 *   project and service identity encoded into the key prefix. The simpler
 *   default; fine for multi-tenant deployments at the small-and-mid scale.
 * - (future) `IsolatedBundleStore` — one storage backend per project.
 *   Opt-in for tenants with physical-isolation or compliance requirements.
 *
 * Callers should accept the interface, not a concrete implementation, so
 * either model is swappable at deploy time.
 */

import type {
  ZelavisFileStorage,
  ZelavisFileStorageObject,
} from "./index.js";

/**
 * Identity of a bundle within the system. `projectId` is left optional so
 * the same shape works for both shared and isolated stores — shared stores
 * fold `projectId` into the key prefix; isolated stores use it to pick a
 * physical backend.
 *
 * For `scope: "system"` services, `projectId` is left undefined; the shared
 * store maps that to a `system/` prefix.
 */
export interface BundleScope {
  /** Project owner of this bundle. Undefined for system-scope services. */
  projectId?: string;
  /** Service name as declared in package.json `name`. */
  serviceName: string;
  /** Bundle identifier as declared in `app.bundle`. Defaults to `"dist"`. */
  bundle: string;
}

/**
 * A single asset read out of a bundle. Mirrors `ZelavisFileStorageObject` but
 * pares it down to the fields the asset-serving handler actually needs.
 */
export interface BundleAsset {
  /** Path within the bundle (relative to the bundle root). */
  path: string;
  body: Uint8Array;
  size?: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
}

export interface BundleStore {
  /**
   * Read a single asset from the bundle. Returns `undefined` when the path
   * is not found — implementations must not throw on missing assets, since
   * the dispatcher relies on `undefined` to drive SPA fallback / 404.
   */
  read(scope: BundleScope, path: string): Promise<BundleAsset | undefined>;

  /**
   * List asset paths under an optional prefix. Optional because not every
   * caller needs it; the dispatcher only uses it for MPA directory probing
   * and debug tooling.
   */
  list?(
    scope: BundleScope,
    prefix?: string,
  ): Promise<readonly string[]>;

  /**
   * Remove every bundle asset owned by a Project. Must be idempotent.
   * A Platform configured with a Project runtime refuses to complete Project
   * deletion when its BundleStore does not implement this capability.
   */
  deleteProject?(projectId: string): Promise<number>;
}

export interface CreateSharedBundleStoreOptions {
  /**
   * Storage backend to wrap. Required.
   */
  storage: ZelavisFileStorage;
  /**
   * Top-level prefix under which bundle keys live, so bundles don't collide
   * with other consumers of the same `ZelavisFileStorage`. Default `"apps"`.
   */
  prefix?: string;
  /**
   * Key for system-scope bundles (where `BundleScope.projectId` is
   * undefined). Default `"system"`. Set to a project-id sentinel if you
   * want system bundles to share the project key-space.
   */
  systemKey?: string;
}

function normalizeBundleSegments(
  value: string,
  label: string,
  options: { allowEmpty?: boolean; allowLeadingSlash?: boolean } = {},
): string[] {
  if (value.includes("\0") || value.includes("\\")) {
    throw new TypeError(`${label} contains an invalid path character.`);
  }
  const normalized = options.allowLeadingSlash
    ? value.replace(/^\/+/, "")
    : value;
  const segments = normalized.split("/");
  if (options.allowEmpty && normalized === "") return [];
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError(`${label} must be a safe relative path.`);
  }
  return segments;
}

function normalizeBundleOwner(value: string, label: string): string {
  const segments = normalizeBundleSegments(value.trim(), label);
  if (segments.length !== 1) {
    throw new TypeError(`${label} must contain exactly one path segment.`);
  }
  return segments[0]!;
}

function normalizeServiceName(value: string): string {
  const segments = normalizeBundleSegments(value.trim(), "Bundle service name");
  if (
    segments.length !== 2 ||
    (!segments[0]!.startsWith("@") && segments[0] !== "zelavis")
  ) {
    throw new TypeError(
      "Bundle service name must use an @scope/name or zelavis/name identity.",
    );
  }
  return segments.join("/");
}

/**
 * Encode a bundle scope + asset path into a storage key.
 *
 * Layout: `<prefix>/<projectId | systemKey>/<serviceName>/<bundle>/<path>`
 *
 * Exposed (not just internal) so tooling can read/write the same layout
 * outside the runtime — e.g. an installer that pushes a built bundle into
 * blob storage before the service is activated.
 */
export function buildBundleStorageKey(
  scope: BundleScope,
  assetPath: string,
  options: { prefix?: string; systemKey?: string } = {},
): string {
  const prefix = normalizeBundleSegments(
    options.prefix ?? "apps",
    "Bundle prefix",
  ).join("/");
  const systemKey = normalizeBundleOwner(
    options.systemKey ?? "system",
    "Bundle system key",
  );
  const owner = normalizeBundleOwner(scope.projectId ?? systemKey, "Bundle owner");
  const serviceName = normalizeServiceName(scope.serviceName);
  const bundle = normalizeBundleOwner(scope.bundle, "Bundle identifier");
  const normalizedAsset = normalizeBundleSegments(assetPath, "Bundle asset path", {
    allowEmpty: true,
    allowLeadingSlash: true,
  }).join("/");
  return `${prefix}/${owner}/${serviceName}/${bundle}/${normalizedAsset}`;
}

/**
 * Create a `BundleStore` backed by a single `ZelavisFileStorage`. All bundles
 * across all projects share the same underlying storage; identity is
 * encoded into the key prefix.
 */
export function createSharedBundleStore(
  options: CreateSharedBundleStoreOptions,
): BundleStore {
  const { storage, prefix, systemKey } = options;
  const storagePrefix = normalizeBundleSegments(
    prefix ?? "apps",
    "Bundle prefix",
  ).join("/");

  if (!storage || typeof storage.get !== "function") {
    throw new TypeError(
      "createSharedBundleStore requires a ZelavisFileStorage with a `get` method.",
    );
  }

  return {
    async read(scope, path) {
      const key = buildBundleStorageKey(scope, path, { prefix, systemKey });
      const object = (await storage.get(key)) as
        | ZelavisFileStorageObject
        | undefined;
      if (!object) {
        return undefined;
      }
      return {
        path,
        body: object.body,
        size: object.size,
        contentType: object.contentType,
        cacheControl: object.cacheControl,
        contentDisposition: object.contentDisposition,
      };
    },
    async list(scope, listPrefix) {
      if (typeof storage.list !== "function") {
        return [];
      }
      const baseKey = buildBundleStorageKey(scope, listPrefix ?? "", {
        prefix,
        systemKey,
      });
      const entries = await storage.list(baseKey);
      const prefixLen = buildBundleStorageKey(scope, "", {
        prefix,
        systemKey,
      }).length;
      return entries.map((entry) => entry.path.slice(prefixLen));
    },
    async deleteProject(projectId) {
      const normalizedProjectId = normalizeBundleOwner(projectId, "Project id");
      if (typeof storage.list !== "function") {
        throw new Error(
          "Shared bundle storage cannot delete Project assets because its file storage does not support listing.",
        );
      }
      const entries = await storage.list(
        `${storagePrefix}/${normalizedProjectId}/`,
      );
      let deleted = 0;
      for (const entry of entries) {
        if (await storage.delete(entry.path)) {
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

/**
 * Lightweight in-memory `BundleStore` — useful for tests and for system
 * services that want to bundle their assets directly into source.
 */
export function createInMemoryBundleStore(
  assets: ReadonlyMap<string, Uint8Array | { body: Uint8Array; contentType?: string; cacheControl?: string }>,
): BundleStore {
  const keyFor = (scope: BundleScope, path: string) =>
    buildBundleStorageKey(scope, path, { prefix: "memory" }).slice("memory/".length);

  return {
    async read(scope, path) {
      const entry = assets.get(keyFor(scope, path));
      if (!entry) {
        return undefined;
      }
      if (entry instanceof Uint8Array) {
        return { path, body: entry, size: entry.byteLength };
      }
      return {
        path,
        body: entry.body,
        size: entry.body.byteLength,
        contentType: entry.contentType,
        cacheControl: entry.cacheControl,
      };
    },
    async list(scope, prefix) {
      const base = keyFor(scope, prefix ?? "");
      const baseNoPrefix = `${scope.projectId ?? "system"}/${scope.serviceName}/${scope.bundle}/`;
      const out: string[] = [];
      for (const key of assets.keys()) {
        if (key.startsWith(base)) {
          out.push(key.slice(baseNoPrefix.length));
        }
      }
      return out;
    },
  };
}
