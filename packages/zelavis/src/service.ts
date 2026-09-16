import type { ZelavisServiceStore } from "./platform/service-store.js";
import {
  readFrontendManifest,
  toServiceAppDefinition,
} from "./core/service/frontend.js";
import {
  validatePluginPackageManifest,
  resolvePackageExportsEntry,
  validatePluginNamespace,
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
  packageDir?: string;
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
  packageDir?: string;
  configuration?: unknown;
  scope?: ZelavisServiceScope;
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
  /**
   * Durable storage scoped to this service.
   *
   * Present when the host has a System Store. Its namespace is fixed to the
   * service that received it, so a plugin cannot reach another one's records.
   */
  store?: ZelavisServiceStore;
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
  const namespaces = new Map<string, string>();

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

      if (service.namespace !== undefined) {
        const namespace = validatePluginNamespace(service.namespace);
        const owner = namespaces.get(namespace);
        if (owner) {
          throw new TypeError(`Plugin namespace "${namespace}" is already owned by "${owner}"; "${service.name}" cannot claim it.`);
        }
        namespaces.set(namespace, service.name);
      }

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
  if (typeof module === "function" && manifest) {
    return Object.freeze({
      name: manifest.name,
      namespace: manifest.zelavis?.namespace,
      kind: manifest.zelavis?.kind ?? "plugin",
      version: manifest.version,
      packageDir: (manifest as any)?.packageDir,
      api: {},
      service: {},
      marketplace: (manifest.zelavis as any)?.marketplace,
      project: (manifest.zelavis as any)?.project,
      capabilities: (manifest.zelavis?.capabilities as any) ?? [],
      setup: module as any,
      ...frontendServiceFields(manifest),
    }) as any;
  }

  if (!module || typeof module !== "object") {
    throw new TypeError("A service module object is required.");
  }

  const raw = module as Record<string, unknown>;

  if (!("name" in raw) && "default" in raw && raw.default !== undefined) {
    return resolveServiceModule(raw.default, manifest);
  }

  if (("name" in raw && typeof raw.name === "string") || manifest) {
    const name =
      "name" in raw && typeof raw.name === "string" ? raw.name : manifest!.name;
    const setupFn =
      typeof raw.setup === "function"
        ? (raw.setup as any)
        : typeof (raw as any).default === "function"
          ? (raw as any).default
          : undefined;

    return Object.freeze({
      name,
      namespace: manifest?.zelavis?.namespace ?? (raw.namespace as string | undefined),
      basePath: typeof raw.basePath === "string" ? raw.basePath : undefined,
      packageDir: (raw.packageDir as string | undefined) ?? (manifest as any)?.packageDir,
      api: (raw.api as Record<string, any>) ?? {},
      service: raw.service ?? raw,
      menu: raw.menu as any,
      menus: raw.menus as any,
      services: raw.services as any,
      authenticators: raw.authenticators as any,
      kind: (raw.kind as string) ?? manifest?.zelavis?.kind ?? "plugin",
      version: (raw.version as string) ?? manifest?.version,
      marketplace: (raw.marketplace as any) ?? (manifest?.zelavis as any)?.marketplace,
      project: (raw.project as any) ?? (manifest?.zelavis as any)?.project,
      capabilities: ((raw.capabilities ?? manifest?.zelavis?.capabilities) as any) ?? [],
      app: raw.app as any,
      setup: setupFn,
      runtimeServices: raw.runtimeServices as any,
      ...(manifest ? frontendServiceFields(manifest) : {}),
    }) as any;
  }

  if ("service" in raw && raw.service !== undefined) {
    return resolveServiceModule(raw.service, manifest);
  }

  if ("default" in raw && raw.default !== undefined) {
    return resolveServiceModule(raw.default, manifest);
  }

  throw new TypeError(
    "Service modules must export a service definition either directly, as `service`, or as `default`.",
  );
}

// The portable context store is synchronous. Serialize package evaluation so
// concurrent loads cannot register into another package's active context.
let pluginEvaluation: Promise<unknown> = Promise.resolve();

export async function loadPluginPackage(options: {
  manifest: unknown;
  specifier?: string;
  importer?: (entry: string) => Promise<unknown>;
  packageDir?: string;
  /** Host configuration passed to the package's per-load SDK registration hook. */
  configuration?: unknown;
  /** Trust is granted by the host, never by a package export. */
  scope?: ZelavisServiceScope;
}): Promise<Readonly<ZelavisServiceRegistryEntry<any>["service"]>> {
  const manifest = validatePluginPackageManifest(options.manifest);
  const rawEntrypoint = resolvePackageExportsEntry(manifest.exports);
  const context = createPluginExecutionContext(manifest);

  const initialPackageDir =
    options.packageDir ??
    (manifest as any)?.packageDir;

  const entrypoint =
    initialPackageDir && rawEntrypoint.startsWith(".")
      ? (initialPackageDir.endsWith("/")
          ? `${initialPackageDir}${rawEntrypoint.replace(/^\.\//, "")}`
          : `${initialPackageDir}/${rawEntrypoint.replace(/^\.\//, "")}`)
      : rawEntrypoint;

  const importer =
    options.importer ??
    ((specifier: string) => import(specifier));

  const evaluation = pluginEvaluation.then(() => activePluginStorage.run(context, async () => {
    const module = await importer(entrypoint);
    if (module && typeof module === "object" && "register" in module) {
      if (typeof module.register !== "function") {
        throw new TypeError("A package register export must be a function.");
      }
      await module.register(options.configuration);
    }
    return module;
  }));
  pluginEvaluation = evaluation.then(() => undefined, () => undefined);
  const moduleResult = await evaluation;

  const rawExport =
    moduleResult && typeof moduleResult === "object" && "default" in moduleResult
      ? (moduleResult as any).default
      : moduleResult;

  const exportObj =
    rawExport && typeof rawExport === "object"
      ? (rawExport as Record<string, any>)
      : moduleResult && typeof moduleResult === "object"
        ? (moduleResult as Record<string, any>)
        : undefined;

  const setupFunction =
    typeof rawExport === "function"
      ? rawExport
      : typeof exportObj?.setup === "function"
        ? exportObj.setup
        : typeof (moduleResult as any)?.setup === "function"
          ? (moduleResult as any).setup
          : undefined;

  if (exportObj?.menu !== undefined || exportObj?.menus !== undefined) {
    throw new TypeError(
      `Package "${manifest.name}" must register menus with zelavis.plugins.ui.menus.create() from zelavis/sdk, not exported menu or menus fields.`,
    );
  }
  if (exportObj?.namespace !== undefined && exportObj.namespace !== manifest.zelavis?.namespace) {
    throw new TypeError(`Package "${manifest.name}" cannot override its manifest namespace.`);
  }

  for (const field of ["name", "namespace", "version", "kind", "basePath", "scope", "capabilities", "marketplace", "project", "packageDir"]) {
    if (exportObj?.[field] !== undefined) {
      throw new TypeError(`Package "${manifest.name}" must declare ${field} through its manifest or host loading options, not a module export.`);
    }
  }
  if (exportObj?.api !== undefined) {
    throw new TypeError(`Package "${manifest.name}" must register APIs through zelavis.createAPI or zelavis.operations.create, not an api export.`);
  }
  const packageDir = initialPackageDir;

  const project = manifest.zelavis?.project as ZelavisProjectRecipeDefinition | undefined;
  const capabilities = manifest.zelavis?.capabilities ?? [];
  const marketplace = manifest.zelavis?.marketplace;
  const frontendFields = frontendServiceFields(manifest);
  const frontendApp = frontendFields.app
    ? { ...frontendFields.app, ...context.frontend }
    : undefined;

  const runtimeService: ZelavisServiceRegistryEntry<any>["service"] = {
    name: manifest.name,
    namespace: manifest.zelavis?.namespace,
    version: manifest.version,
    kind: manifest.zelavis?.kind ?? "plugin",
    packageDir,
    capabilities,
    marketplace,
    basePath: manifest.zelavis?.namespace ? `/plugins/${manifest.zelavis.namespace}` : undefined,
    api: { v1: [...context.routes] },
    menu: context.menus[0],
    menus: context.menus.length > 0 ? context.menus : undefined,
    services: [
      ...(exportObj?.services ?? []),
      ...context.services,
    ],
    authenticators: [
      ...(exportObj?.authenticators ?? []),
      ...context.authenticators,
    ],
    service: exportObj?.service ?? (typeof rawExport === "object" ? rawExport : moduleResult),
    ...(context.setup || setupFunction ? { setup: context.setup ?? setupFunction } : {}),
    ...(exportObj?.runtimeServices
      ? { runtimeServices: exportObj.runtimeServices }
      : {}),
    ...(frontendApp ? { app: frontendApp } : exportObj?.app ? { app: exportObj.app } : {}),
    ...(project ? { project } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
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
    if (options.manifest.zelavis?.kind === "frontend" && (options.manifest.exports === undefined || readFrontendManifest(options.manifest)?.runtime === "server")) {
      return loadFrontendPackage(options.manifest) as any;
    }
    return loadPluginPackage({
      manifest: options.manifest,
      configuration: options.configuration,
      scope: options.scope,
      importer: options.importer,
      packageDir: options.packageDir ?? (options.manifest as any)?.packageDir,
    }) as any;
  }

  // The core never touches a filesystem. A host that can resolve a manifest
  // for this specifier installs a resolver explicitly.
  const resolver = options.manifestResolver;
  const manifest = resolver ? await resolver(specifier) : undefined;

  if (manifest) {
    if (manifest.zelavis?.kind === "frontend" && (manifest.exports === undefined || readFrontendManifest(manifest)?.runtime === "server")) {
      return loadFrontendPackage(manifest) as any;
    }
    return loadPluginPackage({
      manifest,
      specifier,
      configuration: options.configuration,
      scope: options.scope,
      importer: options.importer,
      packageDir: options.packageDir ?? (manifest as any)?.packageDir,
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
        packageDir: entry.packageDir ?? (entry.manifest as any)?.packageDir ?? options.packageDir,
      });

      return {
        service,
        specifier: entry.specifier,
        status: entry.status ?? "installed",
        source: entry.source,
        manifest: entry.manifest,
        packageDir: entry.packageDir ?? service.packageDir,
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
  /** Builds the durable store a named service is given. */
  serviceStore?: (serviceName: string) => ZelavisServiceStore;
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
    // A menu is a contribution too. A plugin whose routes are added during
    // setup has none of the fields above on itself, so its menu was dropped
    // and its pages were unreachable while everything looked installed.
    service.menu !== undefined ||
    Boolean(service.menus?.length) ||
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
      // Built per service so the namespace is decided here, from the name the
      // registry knows, rather than by a plugin naming one for itself.
      core: {
        ...((context as unknown as ZelavisServiceSetupContext).core ?? {}),
        ...(options.serviceStore
          ? { store: options.serviceStore(entry.service.name) }
          : {}),
      },
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
