/**
 * The marketplace allow-list, wired into a local host.
 *
 * The allow-list itself (format, signature, sources, replay protection, the
 * install gate) is the marketplace's, in `@zelavis/marketplace/allowlist`. This
 * file is the host's part: where the trusted keys and cached list are kept, what
 * gets refreshed when, and how the result is offered to the registry and to the
 * package installer. It loads the marketplace module from where the bundled
 * package lies, the same way the Platform loads its other bundled services.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ZelavisMarketplaceControl,
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "../index.js";
import type { ZelavisSystemStore } from "../system-store.js";
import { resolveBundledServiceDirectory } from "./_local-runtime.js";

/** A signing key an installation trusts to issue the allow-list. */
export interface MarketplaceTrustedKey {
  readonly keyId: string;
  /** Ed25519 public key, base64 of its SPKI DER encoding. */
  readonly publicKey: string;
}

export interface MarketplaceOptions {
  /**
   * Where the signed allow-list is fetched from, tried in order. Any one being
   * reachable is enough, because a signed list is as trustworthy from a mirror
   * as from the primary. Also read from `ZELAVIS_ALLOWLIST_SOURCES` (comma
   * separated). Defaults to the official sources; with none, only the list shipped
   * with the release is used.
   */
  readonly sources?: readonly string[];
  /** Keys trusted to sign the allow-list, in addition to the official ones. */
  readonly keys?: readonly MarketplaceTrustedKey[];
  /**
   * A checkout of the officially maintained services (`zelavis-services`). When
   * set, an official service that is not installed is offered from this folder
   * instead of from npm. For development: it names packages in the operator's
   * own checkout, and is never a way to install anything from elsewhere. Also
   * read from `ZELAVIS_OFFICIAL_SERVICES_DIR`.
   */
  readonly officialServicesDirectory?: string;
  /**
   * `false` removes the allow-list gate, so package acquisition follows only the
   * explicit `sources` policy. Advanced; the default is to install only what the
   * allow-list vouches for.
   */
  readonly allowlist?: false;
  /** Injected for tests. */
  readonly fetch?: typeof fetch;
}

/**
 * Keys the Zelavis project signs the official allow-list with. A list
 * signed by anything else is refused. The private half lives with the release
 * manager, never in the repository (`pnpm allowlist keygen`).
 */
export const OFFICIAL_ALLOWLIST_KEYS: readonly MarketplaceTrustedKey[] = Object.freeze([
  { keyId: "zelavis-2026-ob9tdmcx", publicKey: "MCowBQYDK2VwAyEAa+A2zNe05gATIhJiDu3hLTttsockNl4v2YNUob9tdmc=" },
]);

/**
 * Where the official signed list is published, tried in order. Each holds the
 * same signed file, so any one being up is enough. More can be added per
 * installation through `sources` or `ZELAVIS_ALLOWLIST_SOURCES`.
 */
export const OFFICIAL_ALLOWLIST_SOURCES: readonly string[] = Object.freeze([
  "https://zelavis.com/allowlist.json",
  "https://raw.githubusercontent.com/zelavis/allowlist/main/allowlist.json",
]);

interface MarketplaceModule {
  parseAllowlist(value: unknown): unknown;
  createAllowlistClient(options: {
    sources: readonly string[];
    resolveKey: (keyId: string) => CryptoKey | undefined;
    cache?: { read(): Promise<unknown>; write(value: unknown): Promise<void> };
    bundled?: unknown;
    fetch?: typeof fetch;
  }): MarketplaceAllowlistClient;
  createAllowlistGate(client: MarketplaceAllowlistClient): MarketplaceAllowlistGate;
  allowlistCatalogEntries(services: readonly unknown[], firstOrder?: number): readonly unknown[];
}

export interface MarketplaceAllowlistView {
  readonly allowlist: {
    readonly sequence: number;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly services: readonly { readonly name: string }[];
  };
  readonly origin: "remote" | "cache" | "bundled";
  readonly source?: string;
  readonly fetchedAt?: string;
  readonly status: "fresh" | "stale" | "expired";
}

export interface MarketplaceAllowlistClient {
  refresh(): Promise<{
    updated: boolean;
    attempts: readonly { source: string; outcome: string; detail?: string }[];
    view: MarketplaceAllowlistView | undefined;
  }>;
  current(): Promise<MarketplaceAllowlistView | undefined>;
}

export interface MarketplaceAllowlistGate {
  authorize(input: { name: string; version: string }): Promise<unknown>;
  verifyAcquired(input: { name: string; version: string; integrity: string }): Promise<void>;
}

export interface LocalMarketplace {
  readonly client: MarketplaceAllowlistClient;
  /** `undefined` when the allow-list gate is switched off. */
  readonly gate: MarketplaceAllowlistGate | undefined;
  /** What the marketplace offers that the registry does not already have. */
  readonly catalog: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
  /** Folders whose contents count as host-managed code (the dev checkout). */
  readonly managedDirectories: readonly string[];
  /** What an operator sees and can refresh, through the Platform's own routes. */
  readonly control: ZelavisMarketplaceControl;
  /** Where the checkout copy of each official service lies, by package name. */
  readonly localPackages: ReadonlyMap<string, string>;
  /**
   * Whether a recipe may provide the runtime its Projects run under: the held
   * allow-list says so, or it is a package in the operator's own checkout.
   * Independent of how fresh the list is, so an outage never stops a Project.
   */
  runtimeTrusted(name: string): Promise<boolean>;
}

const CACHE_NAMESPACE = "marketplace-allowlist";
const CACHE_KEY = "cache";
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function importKeys(keys: readonly MarketplaceTrustedKey[]): Promise<Map<string, CryptoKey>> {
  const imported = new Map<string, CryptoKey>();
  for (const key of keys) {
    imported.set(
      key.keyId,
      await crypto.subtle.importKey("spki", decodeBase64(key.publicKey), "Ed25519", false, ["verify"]),
    );
  }
  return imported;
}

interface LocalOfficialService {
  /** The package declares the runtime its Projects run under. */
  providesRuntime?: boolean;
  name: string;
  kind: "app" | "plugin" | "frontend";
  version: string;
  title: string;
  summary?: string;
  categories?: readonly string[];
  tags?: readonly string[];
  runtimeKinds?: readonly string[];
  directory: string;
}

async function readLocalPackage(directory: string): Promise<LocalOfficialService | undefined> {
  const file = join(directory, "package.json");
  if (!existsSync(file)) return undefined;
  let manifest: {
    name?: unknown;
    version?: unknown;
    zelavis?: {
      kind?: unknown;
      marketplace?: { title?: unknown; summary?: unknown; categories?: unknown; tags?: unknown };
      project?: { runtimeKinds?: unknown; runtime?: unknown };
    };
  };
  try {
    manifest = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  const kind = manifest.zelavis?.kind;
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string" ||
      (kind !== "app" && kind !== "plugin" && kind !== "frontend")) {
    return undefined;
  }
  const marketplace = manifest.zelavis?.marketplace;
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
  const categories = strings(marketplace?.categories);
  const tags = strings(marketplace?.tags);
  const runtimeKinds = strings(manifest.zelavis?.project?.runtimeKinds);
  return {
    name: manifest.name,
    kind,
    version: manifest.version,
    title: typeof marketplace?.title === "string" ? marketplace.title : manifest.name,
    ...(typeof marketplace?.summary === "string" ? { summary: marketplace.summary } : {}),
    ...(categories ? { categories } : {}),
    ...(tags ? { tags } : {}),
    ...(runtimeKinds ? { runtimeKinds } : {}),
    ...(typeof manifest.zelavis?.project?.runtime === "string" ? { providesRuntime: true } : {}),
    directory: resolve(directory),
  };
}

/** The officially maintained services in a `zelavis-services` checkout: each one, and each one's `plugins/*`. */
export async function discoverLocalOfficialServices(root: string): Promise<readonly LocalOfficialService[]> {
  if (!existsSync(root)) return [];
  const found: LocalOfficialService[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const directory = join(root, entry.name);
    const top = await readLocalPackage(directory);
    if (top) found.push(top);
    const nested = join(directory, "plugins");
    if (!existsSync(nested)) continue;
    for (const child of await readdir(nested, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const service = await readLocalPackage(join(nested, child.name));
      if (service) found.push(service);
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadMarketplaceModule(): Promise<MarketplaceModule | undefined> {
  const directory = resolveBundledServiceDirectory("@zelavis/marketplace");
  const entry = directory && join(directory, "dist", "allowlist", "index.js");
  if (!entry || !existsSync(entry)) return undefined;
  return (await import(pathToFileURL(entry).href)) as MarketplaceModule;
}

async function readSnapshot(module: MarketplaceModule): Promise<unknown | undefined> {
  const directory = resolveBundledServiceDirectory("@zelavis/marketplace");
  const file = directory && join(directory, "allowlist.snapshot.json");
  if (!file || !existsSync(file)) return undefined;
  return module.parseAllowlist(JSON.parse(await readFile(file, "utf8")));
}

/**
 * Builds a local host's view of the marketplace: the allow-list client and its
 * gate, and the catalogue entries to offer. Never fetches on this path (a slow
 * or unreachable source must not delay composition); a refresh is started in
 * the background and the newer list applies from the next start.
 */
export async function createLocalMarketplace(input: {
  readonly options: MarketplaceOptions | undefined;
  readonly systemStore: ZelavisSystemStore | undefined;
  /** Packages the registry already offers, which the marketplace does not repeat. */
  readonly bundledNames: ReadonlySet<string>;
  /**
   * A Project's marketplace offers what may be installed into that Project, from
   * the list shipped with the release. It does not fetch: every Project polling
   * the sources would be a fleet-sized load on them, and the Platform is the one
   * that refreshes.
   */
  readonly role?: "platform" | "project";
}): Promise<LocalMarketplace | undefined> {
  const options = input.options ?? {};
  const module = await loadMarketplaceModule();
  if (!module) return undefined;

  const sources = options.sources ??
    (input.role === "project" ? [] : process.env.ZELAVIS_ALLOWLIST_SOURCES?.split(",").map((value) => value.trim()).filter(Boolean) ??
      OFFICIAL_ALLOWLIST_SOURCES);
  const keys = await importKeys([...OFFICIAL_ALLOWLIST_KEYS, ...(options.keys ?? [])]);
  const store = input.systemStore;
  const client = module.createAllowlistClient({
    sources,
    resolveKey: (keyId) => keys.get(keyId),
    ...(store
      ? {
          cache: {
            async read() {
              return (await store.get(CACHE_NAMESPACE, CACHE_KEY))?.value;
            },
            async write(value) {
              await store.set(CACHE_NAMESPACE, CACHE_KEY, value as never);
            },
          },
        }
      : {}),
    bundled: await readSnapshot(module),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  if (sources.length > 0) {
    void client.refresh().catch(() => undefined);
    setInterval(() => void client.refresh().catch(() => undefined), REFRESH_INTERVAL_MS).unref?.();
  }

  const view = await client.current();
  const listed = ((view?.allowlist as { services?: readonly unknown[] } | undefined)?.services ?? []) as readonly {
    name: string;
  }[];
  const remote = module
    .allowlistCatalogEntries(listed.filter((entry) => !input.bundledNames.has(entry.name)), 100) as unknown as readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];

  // Development: an official service in the operator's own checkout stands in
  // for its npm copy, so it can be tried without publishing anything.
  const directory = options.officialServicesDirectory ?? process.env.ZELAVIS_OFFICIAL_SERVICES_DIR;
  const local = directory ? await discoverLocalOfficialServices(resolve(directory)) : [];
  const localNames = new Set(local.map((entry) => entry.name));
  const localCatalog = local
    .filter((entry) => !input.bundledNames.has(entry.name))
    .map((entry, index) => ({
      service: {
        name: entry.name,
        kind: entry.kind,
        version: entry.version,
        service: {},
        api: {},
        marketplace: {
          title: entry.title,
          ...(entry.summary ? { summary: entry.summary } : {}),
          ...(entry.categories ? { categories: entry.categories } : {}),
          ...(entry.tags ? { tags: entry.tags } : {}),
        },
        ...(entry.kind === "app" && entry.runtimeKinds ? { project: { runtimeKinds: entry.runtimeKinds } } : {}),
      },
      specifier: entry.directory,
      status: "available" as const,
      source: "community" as const,
      // Packages in the operator's checkout of `zelavis-services` are ours.
      maintainer: "zelavis",
      order: 50 + index,
    })) as unknown as readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];

  const summarize = (current: MarketplaceAllowlistView | undefined) =>
    current
      ? {
          list: {
            sequence: current.allowlist.sequence,
            issuedAt: current.allowlist.issuedAt,
            expiresAt: current.allowlist.expiresAt,
            origin: current.origin,
            ...(current.fetchedAt ? { fetchedAt: current.fetchedAt } : {}),
            status: current.status,
            services: current.allowlist.services.length,
          },
        }
      : {};
  const gate = options.allowlist === false ? undefined : module.createAllowlistGate(client);

  const localRuntimes = new Set(local.filter((entry) => entry.providesRuntime).map((entry) => entry.name));
  return {
    client,
    gate,
    localPackages: new Map(local.map((entry) => [entry.name, entry.directory])),
    async runtimeTrusted(name) {
      if (localRuntimes.has(name)) return true;
      const held = await client.current();
      const services = (held?.allowlist.services ?? []) as readonly { name: string; projectRuntime?: boolean }[];
      return services.some((entry) => entry.name === name && entry.projectRuntime === true);
    },
    control: {
      gated: gate !== undefined,
      sources: sources.length,
      status: async () => summarize(await client.current()),
      async refresh() {
        const report = await client.refresh();
        return { updated: report.updated, attempts: report.attempts, ...summarize(report.view) };
      },
    },
    catalog: [
      ...localCatalog,
      ...remote.filter((entry) => !localNames.has((entry as { service: { name: string } }).service.name)),
    ],
    managedDirectories: directory ? [resolve(directory)] : [],
  };
}
