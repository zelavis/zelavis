import {
  readFrontendManifest,
  toServiceAppDefinition,
} from "./core/service/frontend.js";
import {
  validatePluginPackageManifest,
  resolvePackageExportsEntry,
  type ZelavisPackageManifest,
} from "./core/service/manifest.js";
import {
  createPluginExecutionContext,
  activePluginStorage,
} from "./core/service/context.js";
import type {
  ZelavisAnyRuntimeServiceInput,
  ZelavisRuntimeService,
} from "./core/runtime/contracts.js";
import type { BundleStore } from "./bundle-store.js";
import type { DomainBindingStore } from "./domain-binding.js";
import { synthesizeServiceAppService } from "./service-app.js";
import type {
  ZelavisServiceAppDefinition,
  ZelavisServiceAppDomainPolicy,
  ZelavisServiceAppMode,
  ZelavisServiceAppShellDefinition,
  ZelavisServiceAppShellRenderContext,
  ZelavisServiceAppShellResult,
  ZelavisServiceCapability,
  ZelavisServicePageAsset,
  ZelavisServiceCatalogCompatibility,
  ZelavisServiceCatalogEntry,
  ZelavisServiceCatalogLinks,
  ZelavisServiceCatalogReviewStatus,
  ZelavisServiceCatalogSource,
  ZelavisServiceKind,
  ZelavisServiceMarketplaceMetadata,
  ZelavisServiceMenuDefinition,
  ZelavisServiceMenuPageDefinition,
  ZelavisServiceScope,
} from "./core/service/definition.js";

export {
  defineServiceCatalog,
  defineServiceCatalogEntry,
} from "./core/index.js";
export {
  validatePluginPackageManifest,
  resolvePackageExportsEntry,
} from "./core/service/manifest.js";
export {
  createPluginExecutionContext,
  activePluginStorage,
} from "./core/service/context.js";
export type {
  ZelavisPackageManifest,
  ZelavisManifestConfig,
} from "./core/service/manifest.js";
export type {
  PluginExecutionContext,
  ZelavisCommandDefinition,
} from "./core/service/context.js";

export type {
  ZelavisServiceAppDefinition,
  ZelavisServiceAppDomainPolicy,
  ZelavisServiceAppMode,
  ZelavisServiceAppShellDefinition,
  ZelavisServiceAppShellRenderContext,
  ZelavisServiceAppShellResult,
  ZelavisServiceCapability,
  ZelavisServiceCatalogCompatibility,
  ZelavisServiceCatalogEntry,
  ZelavisServiceCatalogLinks,
  ZelavisServiceCatalogReviewStatus,
  ZelavisServiceCatalogSource,
  ZelavisServiceKind,
  ZelavisServiceMarketplaceMetadata,
  ZelavisServiceMenuDefinition,
  ZelavisServiceMenuPageDefinition,
  ZelavisServiceScope,
};

/** Host execution family supported by a Project recipe and runtime driver. */
export type ZelavisProjectRuntimeKind = string;

/**
 * Project-specific recipe metadata locked when a Project is created.
 *
 * Services with `kind: "app"` are Project recipes. This field carries their
 * Project-specific runtime compatibility metadata. A `plugin` extends the
 * Platform without being something a Project can be created from, so it never
 * becomes a create-project option.
 */
export interface ZelavisProjectRecipeDefinition {
  readonly runtimeKinds: readonly ZelavisProjectRuntimeKind[];
}

export interface ZelavisServiceRegistryEntry<TContext = unknown> {
  service: ZelavisRuntimeService<any> & {
    scope?: ZelavisServiceScope;
    version?: string;
    app?: ZelavisServiceAppDefinition;
    marketplace?: ZelavisServiceMarketplaceMetadata;
    project?: ZelavisProjectRecipeDefinition;
    capabilities?: readonly ZelavisServiceCapability[];
    /**
     * Pages this service ships itself, keyed by bundle-relative path. Served
     * through the same service page asset route as a bundle-store page, so a
     * service that arrives inside the Platform reaches the dashboard the same
     * way an installed one does.
     */
    pageAssets?: Readonly<Record<string, ZelavisServicePageAsset>>;
    runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[];
    setup?: (
      context: TContext,
    ) =>
      | void
      | { runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[] }
      | Promise<void | { runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[] }>;
  };
  specifier?: string;
  status: "installed" | "available";
  source?: "official" | "community";
  order?: number;
  manifest?: ZelavisPackageManifest;
}

export interface ZelavisServiceRegistryModuleEntry {
  specifier: string;
  status?: "installed" | "available";
  source?: "official" | "community";
  order?: number;
  manifest?: ZelavisPackageManifest;
}

export interface ZelavisServiceRegistryStateEntry {
  name: string;
  specifier?: string;
  status?: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

export interface ZelavisServiceRegistryStore {
  read:
    | (() =>
        | Promise<readonly ZelavisServiceRegistryStateEntry[] | undefined>
        | readonly ZelavisServiceRegistryStateEntry[]
        | undefined)
    | (() => Promise<readonly ZelavisServiceRegistryStateEntry[] | undefined>);
  write: (
    entries: readonly ZelavisServiceRegistryStateEntry[],
  ) =>
    | Promise<readonly ZelavisServiceRegistryStateEntry[]>
    | readonly ZelavisServiceRegistryStateEntry[];
}

export interface ZelavisServiceLoadOptions {
  importer?: (specifier: string) => Promise<unknown>;
  manifest?: ZelavisPackageManifest;
  manifestResolver?: ZelavisServiceManifestResolver;
}

/**
 * Resolves a package manifest for a service specifier.
 *
 * The runtime core never scans a filesystem for plugins. Hosts that can do so
 * (the Node adapter, developer tooling) install a resolver explicitly.
 */
export type ZelavisServiceManifestResolver = (
  specifier: string,
) => Promise<ZelavisPackageManifest | undefined>;



export interface ZelavisServiceSetupApiContext {
  prefix: string;
  version: string;
  basePath: string;
}

export interface ZelavisServiceSetupPlatformContext {
  presets: readonly string[];
  resources: {
    keyValueStore: boolean;
    fileStorage: boolean;
  };
  metadata: Readonly<Record<string, unknown>>;
}

export interface ZelavisServiceSetupCoreContext {
  database?: unknown;
}

export interface ZelavisServiceSetupContext {
  service: Readonly<ZelavisRuntimeService<any>>;
  registry: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[];
  rootPath: string;
  api: ZelavisServiceSetupApiContext;
  platform: ZelavisServiceSetupPlatformContext;
  core: ZelavisServiceSetupCoreContext;
  runtimeServices: readonly ZelavisAnyRuntimeServiceInput[];
  addService: (service: ZelavisAnyRuntimeServiceInput) => void;
  addServices: (services: readonly ZelavisAnyRuntimeServiceInput[]) => void;
}

export function createServiceRegistry<TContext = unknown>(
  entries: readonly ZelavisServiceRegistryEntry<TContext>[],
): readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[] {
  const seen = new Set<string>();

  return Object.freeze(
    entries.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new TypeError("A service registry entry object is required.");
      }

      const service = entry.service;
      if (!service || typeof service !== "object" || !("name" in service) || typeof service.name !== "string" || !service.name.trim()) {
        throw new TypeError("Service registry entry must have a service with a string name.");
      }

      if (seen.has(service.name)) {
        throw new TypeError(
          `Service registry entries must use unique names. Duplicate: ${service.name}`,
        );
      }

      seen.add(service.name);

      if (entry.status !== "installed" && entry.status !== "available") {
        throw new TypeError(
          'Service registry entries must use status "installed" or "available".',
        );
      }

      if (
        entry.source !== undefined &&
        entry.source !== "official" &&
        entry.source !== "community"
      ) {
        throw new TypeError(
          'Service registry entries must use source "official" or "community" when provided.',
        );
      }

      if (
        entry.order !== undefined &&
        (!Number.isInteger(entry.order) || entry.order < 0)
      ) {
        throw new TypeError(
          "Service registry entry order must be a non-negative integer when provided.",
        );
      }

      return Object.freeze({
        ...entry,
        service: Object.freeze({ ...service }),
      });
    }),
  );
}

/**
 * Projects a frontend manifest onto the service fields that serve it.
 *
 * A static frontend is files, not code: it reuses the existing service `app`
 * definition so bundles, SPA and MPA resolution, and the shell all behave the
 * same as any other app-serving service, rather than growing a second file
 * server beside them.
 *
 * A static frontend is files, so it projects onto the existing service app
 * definition — bundles, SPA and MPA resolution, the shell.
 *
 * A server frontend is a process, so it has no app definition at all. It runs
 * as an owned Project: the Project runtime spawns its declared command on an
 * allocated port, and the Gateway routes its owner's public traffic to it once
 * it is listening. Nothing here needs to describe that, which is why this
 * returns nothing rather than synthesizing something that would serve files it
 * does not have.
 */
function frontendServiceFields(
  manifest: ZelavisPackageManifest,
): { app?: ZelavisServiceAppDefinition } {
  const frontend = readFrontendManifest(manifest);
  if (!frontend) return {};

  if (frontend.runtime === "server") {
    return {};
  }

  return { app: toServiceAppDefinition(frontend) };
}

export function resolveServiceModule<TContext = unknown>(
  module: unknown,
  manifest?: ZelavisPackageManifest,
): Readonly<ZelavisServiceRegistryEntry<TContext>["service"]> {
  if (!module || typeof module !== "object") {
    throw new TypeError("A service module object is required.");
  }

  const raw = module as Record<string, unknown>;

  if ("name" in raw && typeof raw.name === "string") {
    return Object.freeze({
      name: raw.name,
      basePath: typeof raw.basePath === "string" ? raw.basePath : undefined,
      api: (raw.api as Record<string, any>) ?? {},
      service: raw.service ?? raw,
      menu: raw.menu as any,
      menus: raw.menus as any,
      services: raw.services as any,
      authenticators: raw.authenticators as any,
      kind: (raw.kind as string) ?? manifest?.zelavis?.kind,
      version: (raw.version as string) ?? manifest?.version,
      marketplace: raw.marketplace as any,
      project: raw.project as any,
      capabilities: raw.capabilities as any,
      app: raw.app as any,
      setup: typeof raw.setup === "function" ? (raw.setup as any) : undefined,
      runtimeServices: raw.runtimeServices as any,
    }) as any;
  }

  if ("service" in raw && raw.service !== undefined) {
    return resolveServiceModule(raw.service, manifest);
  }

  if ("default" in raw && raw.default !== undefined) {
    return resolveServiceModule(raw.default, manifest);
  }

  if (manifest) {
    return Object.freeze({
      name: manifest.name,
      kind: manifest.zelavis?.kind,
      version: manifest.version,
      api: {},
      service: raw,
      ...frontendServiceFields(manifest),
    }) as any;
  }

  throw new TypeError(
    "Service modules must export a service definition either directly, as `service`, or as `default`.",
  );
}

export async function loadPluginPackage(options: {
  manifest: unknown;
  importer?: (entry: string) => Promise<unknown>;
}): Promise<Readonly<ZelavisServiceRegistryEntry<any>["service"]>> {
  const manifest = validatePluginPackageManifest(options.manifest);
  const entrypoint = resolvePackageExportsEntry(manifest.exports);
  const context = createPluginExecutionContext(manifest);

  const importer =
    options.importer ??
    ((specifier: string) => import(specifier));

  const moduleResult = await activePluginStorage.run(context, async () => {
    return importer(entrypoint);
  });

  const resolvedService = (
    moduleResult && typeof moduleResult === "object" && "name" in moduleResult
      ? moduleResult
      : (moduleResult as any)?.default && typeof (moduleResult as any).default === "object" && "name" in (moduleResult as any).default
        ? (moduleResult as any).default
        : undefined
  ) as
    | (ZelavisRuntimeService<any> &
        Pick<
          ZelavisServiceRegistryEntry<any>["service"],
          "capabilities" | "marketplace" | "pageAssets"
        >)
    | undefined;

  const runtimeService: ZelavisServiceRegistryEntry<any>["service"] = {
    name: manifest.name,
    version: manifest.version,
    kind: manifest.zelavis?.kind ?? "plugin",
    // Declared on the module, not through an SDK call: these describe what the
    // service *is*, and a plugin that failed to load should not be registered
    // with a half-built identity.
    capabilities: resolvedService?.capabilities,
    marketplace: resolvedService?.marketplace,
    pageAssets: resolvedService?.pageAssets,
    basePath: resolvedService?.basePath,
    api: {
      v1: [
        ...(resolvedService?.api?.v1 ?? []),
        ...context.routes,
      ],
    },
    menu: context.menus[0] ?? resolvedService?.menu,
    menus: context.menus.length > 0 ? context.menus : resolvedService?.menus,
    services: [
      ...(resolvedService?.services ?? []),
      ...context.services,
    ],
    authenticators: [
      ...(resolvedService?.authenticators ?? []),
      ...context.authenticators,
    ],
    service: resolvedService?.service ?? moduleResult,
  };

  return Object.freeze(runtimeService);
}

/**
 * Builds the service for a frontend package.
 *
 * A static frontend is files with no JavaScript entry, so the plugin-loading
 * path — which resolves and executes an ESM export — cannot apply to it. It is
 * synthesized from the manifest alone instead.
 */
function loadFrontendPackage(
  manifest: ZelavisPackageManifest,
): Readonly<ZelavisServiceRegistryEntry<any>["service"]> {
  return Object.freeze({
    name: manifest.name,
    kind: "frontend",
    version: manifest.version,
    api: {},
    service: {},
    ...frontendServiceFields(manifest),
  }) as any;
}

export async function loadService<TContext = unknown>(
  specifier: string,
  options: ZelavisServiceLoadOptions = {},
): Promise<Readonly<ZelavisServiceRegistryEntry<TContext>["service"]>> {
  if (!specifier || typeof specifier !== "string") {
    throw new TypeError("A service module specifier string is required.");
  }

  if (options.manifest) {
    if (options.manifest.zelavis?.kind === "frontend") {
      return loadFrontendPackage(options.manifest) as any;
    }
    return loadPluginPackage({
      manifest: options.manifest,
      importer: options.importer,
    }) as any;
  }

  // The core never touches a filesystem. A host that can resolve a manifest
  // for this specifier installs a resolver explicitly.
  const resolver = options.manifestResolver;
  const manifest = resolver ? await resolver(specifier) : undefined;

  if (manifest) {
    if (manifest.zelavis?.kind === "frontend") {
      return loadFrontendPackage(manifest) as any;
    }
    return loadPluginPackage({
      manifest,
      importer: options.importer,
    }) as any;
  }

  const importer =
    options.importer ??
    ((moduleSpecifier: string) => import(moduleSpecifier));

  const mod = await importer(specifier);
  return resolveServiceModule<TContext>(mod);
}

export async function loadServiceRegistry<TContext = unknown>(
  entries: readonly ZelavisServiceRegistryModuleEntry[],
  options: ZelavisServiceLoadOptions = {},
): Promise<readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[]> {
  const resolvedEntries = await Promise.all(
    entries.map(async (entry) => {
      if (!entry || typeof entry !== "object") {
        throw new TypeError("A service registry module entry object is required.");
      }

      if (!entry.specifier || typeof entry.specifier !== "string") {
        throw new TypeError(
          "Service registry module entries must include a string specifier.",
        );
      }

      const service = await loadService<TContext>(entry.specifier, {
        ...options,
        manifest: entry.manifest ?? options.manifest,
      });

      return {
        service,
        specifier: entry.specifier,
        status: entry.status ?? "installed",
        source: entry.source,
        manifest: entry.manifest,
        ...(entry.order !== undefined ? { order: entry.order } : {}),
      };
    }),
  );

  return createServiceRegistry(resolvedEntries);
}

export function removeServiceFromRegistry<TContext = unknown>(
  registry: readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[],
  serviceName: string,
): readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[] {
  if (!serviceName || typeof serviceName !== "string") {
    throw new TypeError("A service name string is required.");
  }

  return Object.freeze(
    registry.filter((entry) => entry.service.name !== serviceName),
  );
}

export function serializeServiceRegistryState<TContext = unknown>(
  registry: readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[],
): readonly ZelavisServiceRegistryStateEntry[] {
  return Object.freeze(
    registry.map((entry) =>
      Object.freeze({
        name: entry.service.name,
        ...(entry.specifier ? { specifier: entry.specifier } : {}),
        status: entry.status,
        ...(entry.source ? { source: entry.source } : {}),
        ...(entry.order !== undefined ? { order: entry.order } : {}),
      }),
    ),
  );
}

export function applyServiceRegistryState<TContext = unknown>(
  registry: readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[],
  stateEntries: readonly ZelavisServiceRegistryStateEntry[] | undefined,
): readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[] {
  if (!stateEntries || stateEntries.length === 0) {
    return registry;
  }

  const stateByName = new Map(stateEntries.map((entry) => [entry.name, entry]));

  return createServiceRegistry(
    registry.map((entry) => {
      const state = stateByName.get(entry.service.name);

      if (!state) {
        return entry;
      }

      return {
        ...entry,
        status: state.status ?? entry.status,
        source: state.source ?? entry.source,
        order: state.order ?? entry.order,
      };
    }),
  );
}

export interface ActivateServiceRegistryOptions {
  bundleStore?: BundleStore;
  projectId?: string;
  domainBindings?: DomainBindingStore;
  reservedRuntimeServiceNames?: readonly string[];
}

export async function activateServiceRegistry<
  TContext extends ZelavisServiceSetupContext = ZelavisServiceSetupContext,
>(
  registry: readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[],
  context: Omit<
    TContext,
    | "service"
    | "registry"
    | "children"
    | "runtimeServices"
    | "addService"
    | "addServices"
  >,
  options: ActivateServiceRegistryOptions = {},
): Promise<{
  registry: readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[];
  services: readonly ZelavisAnyRuntimeServiceInput[];
}> {
  const activatedServices: ZelavisAnyRuntimeServiceInput[] = [];
  const installedServices = [...registry]
    .filter((entry) => entry.status === "installed")
    .sort((left, right) => {
      const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.service.name.localeCompare(right.service.name);
    });

  const addService = (service: ZelavisAnyRuntimeServiceInput) => {
    activatedServices.push(service);
  };
  const assertCanAddRuntimeService = (
    owner: Readonly<ZelavisServiceRegistryEntry<TContext>["service"]>,
    service: ZelavisAnyRuntimeServiceInput,
  ) => {
    if (owner.scope === "system" || !options.reservedRuntimeServiceNames) {
      return;
    }

    if (!("name" in service)) {
      return;
    }

    if (options.reservedRuntimeServiceNames.includes(service.name)) {
      throw new TypeError(
        `Extension service "${owner.name}" cannot register reserved runtime service "${service.name}".`,
      );
    }
  };
  const shouldMountService = (service: ZelavisServiceRegistryEntry<TContext>["service"]) =>
    service.basePath !== undefined ||
    service.service !== undefined ||
    Boolean(service.authenticators?.length) ||
    Object.values(service.api ?? {}).some((routes) => routes.length > 0);

  for (const entry of installedServices) {
    if (shouldMountService(entry.service)) {
      assertCanAddRuntimeService(
        entry.service,
        entry.service as unknown as ZelavisAnyRuntimeServiceInput,
      );
      addService(entry.service as unknown as ZelavisAnyRuntimeServiceInput);
    }

    if (entry.service.app && options.bundleStore) {
      const appService = await synthesizeServiceAppService({
        service: entry.service as any,
        bundleStore: options.bundleStore,
        projectId: options.projectId,
        domainBindings: options.domainBindings,
      });
      if (appService) {
        addService(appService as unknown as ZelavisAnyRuntimeServiceInput);
      }
    }

    const addEntryService = (service: ZelavisAnyRuntimeServiceInput) => {
      assertCanAddRuntimeService(entry.service, service);
      addService(service);
    };
    const addEntryServices = (services: readonly ZelavisAnyRuntimeServiceInput[]) => {
      for (const service of services) {
        addEntryService(service);
      }
    };

    if (entry.service.runtimeServices?.length) {
      addEntryServices(entry.service.runtimeServices);
    }

    if (!entry.service.setup) {
      continue;
    }

    const result = await entry.service.setup({
      ...(context as TContext),
      service: entry.service as any,
      registry: registry as any,
      runtimeServices: activatedServices,
      addService: addEntryService,
      addServices: addEntryServices,
    } as TContext);

    if (result?.runtimeServices?.length) {
      addEntryServices(result.runtimeServices);
    }
  }

  return {
    registry,
    services: Object.freeze([...activatedServices]),
  };
}
