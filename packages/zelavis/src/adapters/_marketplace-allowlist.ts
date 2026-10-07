import { Effect } from "effect";
import { evaluate, present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { normalizeProjectHostPackages } from "../project-host-packages.js";
/**
 * The marketplace allow-list, wired into a local host.
 *
 * The allow-list itself (format, sources, replay protection, the
 * install gate) is the marketplace's, in `@zelavis/marketplace/allowlist`. This
 * file is the host's part: where the cached list is kept, what
 * gets refreshed when, and how the result is offered to the registry and to the
 * package installer. It loads the marketplace module from where the bundled
 * package lies, the same way the Platform loads its other bundled services.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ZelavisMarketplaceControl,
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "../index.js";
import type { ZelavisSystemStore } from "../system-store.js";
import { resolveBundledServiceDirectory } from "./_local-runtime.js";

export interface MarketplaceOptions {
  /**
   * Where the allow-list is fetched from, tried in order, each trusted as much
   * as its https origin. Also read from `ZELAVIS_ALLOWLIST_SOURCES` (comma
   * separated). Defaults to https://zelavis.com/allowlist.json; with none, only
   * the list shipped with the release is used.
   */
  readonly sources?: readonly string[];
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
 * Where the official list is published. More can be added per installation
 * through `sources` or `ZELAVIS_ALLOWLIST_SOURCES`.
 */
export const OFFICIAL_ALLOWLIST_SOURCES: readonly string[] = Object.freeze([
  "https://zelavis.com/allowlist.json",
]);

interface MarketplaceModule {
  parseAllowlist(value: unknown): unknown;
  createAllowlistClient(options: {
    sources: readonly string[];
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
  /**
   * Writes the list this Platform holds into a Project's data folder, where that
   * Project's own marketplace reads it. The Platform is the Project's parent
   * authority and the folder is the Project's own, so the file is the Platform's
   * word, parsed again on every read.
   */
  handDown(projectDataDirectory: string): Promise<void>;
}

/** The file a Platform hands its allow-list to a Project in. */
export const HANDED_DOWN_ALLOWLIST_FILE = "allowlist.json";

function writeHandedDown(directory: string, value: unknown): Promise<void> {
  const file = join(directory, HANDED_DOWN_ALLOWLIST_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  return present(Effect.gen(function* () {
    yield* integrationValue(writeFile(temporary, JSON.stringify(value), { mode: 0o600 }));
    yield* integrationValue(rename(temporary, file));
  }).pipe(
    // A Project that is gone, or a folder that cannot be written, must not stop
    // the Platform from refreshing its own list. It keeps the one it has.
    Effect.catch(() => integrationValue(rm(temporary, { force: true })).pipe(Effect.orElseSucceed(() => undefined))),
  ));
}

const CACHE_NAMESPACE = "marketplace-allowlist";
const CACHE_KEY = "cache";
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000;

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
  hostPackages?: readonly string[];
  directory: string;
}

function readLocalPackage(directory: string): Promise<LocalOfficialService | undefined> {
  return present(Effect.gen(function* (): Effect.fn.Return<LocalOfficialService | undefined, IntegrationFailure> {
  const file = join(directory, "package.json");
  if (!existsSync(file)) return undefined;
  type Manifest = {
    name?: unknown;
    version?: unknown;
    zelavis?: {
      kind?: unknown;
      marketplace?: { title?: unknown; summary?: unknown; categories?: unknown; tags?: unknown };
      project?: { runtimeKinds?: unknown; runtime?: unknown; hostPackages?: unknown };
    };
  };
  const parsed = yield* integrationValue(readFile(file, "utf8")).pipe(
    Effect.flatMap((text) => evaluate((): Manifest => JSON.parse(text))),
    Effect.map((value) => ({ value })),
    Effect.orElseSucceed(() => undefined),
  );
  if (!parsed) return undefined;
  const manifest = parsed.value;
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
  const hostPackages = normalizeProjectHostPackages(manifest.zelavis?.project?.hostPackages);
  return {
    name: manifest.name,
    kind,
    version: manifest.version,
    title: typeof marketplace?.title === "string" ? marketplace.title : manifest.name,
    ...(typeof marketplace?.summary === "string" ? { summary: marketplace.summary } : {}),
    ...(categories ? { categories } : {}),
    ...(tags ? { tags } : {}),
    ...(runtimeKinds ? { runtimeKinds } : {}),
    ...(hostPackages ? { hostPackages } : {}),
    ...(typeof manifest.zelavis?.project?.runtime === "string" ? { providesRuntime: true } : {}),
    directory: resolve(directory),
  };
  }));
}

/** The officially maintained services in a `zelavis-services` checkout: each one, and each one's `plugins/*`. */
export function discoverLocalOfficialServices(root: string): Promise<readonly LocalOfficialService[]> {
    return present(Effect.gen(function* (): Effect.fn.Return<readonly LocalOfficialService[], IntegrationFailure> {
  if (!existsSync(root)) return [];
  const found: LocalOfficialService[] = [];
  for (const entry of (yield* integrationValue(readdir(root, { withFileTypes: true })))) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const directory = join(root, entry.name);
    const top = (yield* integrationValue(readLocalPackage(directory)));
    if (top) found.push(top);
    const nested = join(directory, "plugins");
    if (!existsSync(nested)) continue;
    for (const child of (yield* integrationValue(readdir(nested, { withFileTypes: true })))) {
      if (!child.isDirectory()) continue;
      const service = (yield* integrationValue(readLocalPackage(join(nested, child.name))));
      if (service) found.push(service);
    }
  }
  return (yield* integrationValue(found.sort((left, right) => left.name.localeCompare(right.name))));
}));
  }

function loadMarketplaceModule(): Promise<MarketplaceModule | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<MarketplaceModule | undefined, IntegrationFailure> {
  const directory = resolveBundledServiceDirectory("@zelavis/marketplace");
  const entry = directory && join(directory, "dist", "allowlist", "index.js");
  if (!entry || !existsSync(entry)) return undefined;
  return ((yield* integrationValue(import(pathToFileURL(entry).href)))) as MarketplaceModule;
}));
  }

function readSnapshot(module: MarketplaceModule): Promise<unknown | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<unknown | undefined, IntegrationFailure> {
  const directory = resolveBundledServiceDirectory("@zelavis/marketplace");
  const file = directory && join(directory, "allowlist.snapshot.json");
  if (!file || !existsSync(file)) return undefined;
  return (yield* integrationValue(module.parseAllowlist(JSON.parse((yield* integrationValue(readFile(file, "utf8")))))));
}));
  }

/**
 * Builds a local host's view of the marketplace: the allow-list client and its
 * gate, and the catalogue entries to offer. Never fetches on this path (a slow
 * or unreachable source must not delay composition); a refresh is started in
 * the background and the newer list applies from the next start.
 */
export function createLocalMarketplace(input: {
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
  /** This runtime's data root. A Project reads the list its Platform handed it from here. */
  readonly dataDirectory: string;
  /** The Platform's Projects folder, where a refreshed list is handed down to every Project. */
  readonly projectsDirectory?: string;
}): Promise<LocalMarketplace | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<LocalMarketplace | undefined, IntegrationFailure> {
  const options = input.options ?? {};
  const module = (yield* integrationValue(loadMarketplaceModule()));
  if (!module) return undefined;

  const sources = options.sources ??
    (input.role === "project" ? [] : process.env.ZELAVIS_ALLOWLIST_SOURCES?.split(",").map((value) => value.trim()).filter(Boolean) ??
      OFFICIAL_ALLOWLIST_SOURCES);
  const store = input.systemStore;
  const projectsDirectory = input.projectsDirectory;

  function handDownToEveryProject(value: unknown) {
    return present(Effect.gen(function* () {
    if (!projectsDirectory || !existsSync(projectsDirectory)) return;
    for (const entry of (yield* integrationValue(readdir(projectsDirectory, { withFileTypes: true }).catch(() => [])))) {
      const data = join(projectsDirectory, entry.name, ".zelavis");
      if (entry.isDirectory() && existsSync(data)) (yield* integrationValue(writeHandedDown(data, value)));
    }
  }));
  }

  // A Platform keeps the list in its System Store. A Project keeps none of its
  // own: it reads what its Platform handed it and parses it again every time,
  // so a malformed file is refused rather than believed.
  const handedDown = join(input.dataDirectory, HANDED_DOWN_ALLOWLIST_FILE);
  const cache = input.role === "project"
    ? {
        read() {
          return present(integrationValue(readFile(handedDown, "utf8")).pipe(
            Effect.flatMap((text) => evaluate((): unknown => JSON.parse(text))),
            Effect.orElseSucceed(() => undefined),
          ));
        },
        write() {
    return present(Effect.gen(function* () {}));
  },
      }
    : store
      ? {
          read() {
    return present(Effect.gen(function* () {
            return ((yield* integrationValue(store.get(CACHE_NAMESPACE, CACHE_KEY))))?.value;
          }));
  },
          write(value: unknown) {
    return present(Effect.gen(function* () {
            (yield* integrationValue(store.set(CACHE_NAMESPACE, CACHE_KEY, value as never)));
            (yield* integrationValue(handDownToEveryProject(value)));
          }));
  },
        }
      : undefined;

  const client = module.createAllowlistClient({
    sources,
    ...(cache ? { cache } : {}),
    bundled: (yield* integrationValue(readSnapshot(module))),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  if (sources.length > 0) {
    void client.refresh().catch(() => undefined);
    setInterval(() => void client.refresh().catch(() => undefined), REFRESH_INTERVAL_MS).unref?.();
  }

  const view = (yield* integrationValue(client.current()));
  const listed = ((view?.allowlist as { services?: readonly unknown[] } | undefined)?.services ?? []) as readonly {
    name: string;
  }[];
  const remote = module
    .allowlistCatalogEntries(listed.filter((entry) => !input.bundledNames.has(entry.name)), 100) as unknown as readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];

  // Development: an official service in the operator's own checkout stands in
  // for its npm copy, so it can be tried without publishing anything.
  const directory = options.officialServicesDirectory ?? process.env.ZELAVIS_OFFICIAL_SERVICES_DIR;
  const local = directory ? (yield* integrationValue(discoverLocalOfficialServices(resolve(directory)))) : [];
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
        ...(entry.kind === "app" && entry.runtimeKinds ? { project: { runtimeKinds: entry.runtimeKinds, ...(entry.hostPackages ? { hostPackages: entry.hostPackages } : {}) } } : {}),
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
    handDown(projectDataDirectory) {
    return present(Effect.gen(function* () {
      const held = (yield* integrationValue(cache?.read()));
      if (held) (yield* integrationValue(writeHandedDown(projectDataDirectory, held)));
    }));
  },
    runtimeTrusted(name) {
    return present(Effect.gen(function* () {
      if (localRuntimes.has(name)) return true;
      const held = (yield* integrationValue(client.current()));
      const services = (held?.allowlist.services ?? []) as readonly { name: string; projectRuntime?: boolean }[];
      return (yield* integrationValue(services.some((entry) => entry.name === name && entry.projectRuntime === true)));
    }));
  },
    control: {
      gated: gate !== undefined,
      sources: sources.length,
      status: () => present(Effect.gen(function* () {
    return (yield* integrationValue(summarize((yield* integrationValue(client.current())))));
  })),
      refresh() {
    return present(Effect.gen(function* () {
        const report = (yield* integrationValue(client.refresh()));
        return { updated: report.updated, attempts: report.attempts, ...summarize(report.view) };
      }));
  },
    },
    catalog: [
      ...localCatalog,
      ...remote.filter((entry) => !localNames.has((entry as { service: { name: string } }).service.name)),
    ],
    managedDirectories: directory ? [resolve(directory)] : [],
  };
}));
  }
