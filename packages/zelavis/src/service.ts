import {
  defineService,
  isChildServiceAllowed,
  type ZelavisAnyRuntimeServiceInput,
  type ZelavisRuntimeService,
  type ZelavisServiceDefinition,
  type ZelavisServiceLoadOptions,
  type ZelavisServiceMenuDefinition,
  type ZelavisServiceRegistryEntry,
  type ZelavisServiceRegistryModuleEntry,
  type ZelavisServiceRegistryStateEntry,
  type ZelavisServiceSetupContext,
} from "./core/index.js";
import type { BundleStore } from "./bundle-store.js";
import type { DomainBindingStore } from "./domain-binding.js";
import { synthesizeServiceAppService } from "./service-app.js";

export {
  ZELAVIS_SERVICE_V1,
  defineServiceCatalog,
  defineServiceCatalogEntry,
  defineService,
  isChildServiceAllowed,
} from "./core/index.js";
export type {
  ZelavisServiceAppDefinition,
  ZelavisServiceAppDomainPolicy,
  ZelavisServiceAppMode,
  ZelavisServiceAppShellDefinition,
  ZelavisServiceAppShellRenderContext,
  ZelavisServiceAppShellResult,
  ZelavisServiceCapability,
  ZelavisServiceContractVersion,
  ZelavisServiceCatalogCompatibility,
  ZelavisServiceCatalogEntry,
  ZelavisServiceCatalogLinks,
  ZelavisServiceCatalogReviewStatus,
  ZelavisServiceCatalogSource,
  ZelavisServiceDefinition,
  ZelavisServiceKind,
  ZelavisServiceLoadOptions,
  ZelavisServiceMarketplaceMetadata,
  ZelavisServiceMenuDefinition,
  ZelavisServiceMenuPageDefinition,
  ZelavisServiceModule,
  ZelavisServiceRegistryEntry,
  ZelavisServiceRegistryModuleEntry,
  ZelavisServiceRegistryStateEntry,
  ZelavisServiceRegistryStore,
  ZelavisServiceScope,
  ZelavisServiceSetupApiContext,
  ZelavisServiceSetupContext,
  ZelavisServiceSetupCoreContext,
  ZelavisServiceSetupPlatformContext,
  ZelavisServiceSetupResult,
  ZelavisServiceV1Definition,
} from "./core/index.js";
export function createServiceRegistry<TContext = unknown>(
  entries: readonly ZelavisServiceRegistryEntry<TContext>[],
): readonly Readonly<ZelavisServiceRegistryEntry<TContext>>[] {
  const seen = new Set<string>();

  return Object.freeze(
    entries.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new TypeError("A service registry entry object is required.");
      }

      const service = defineService(entry.service);

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
        service,
      });
    }),
  );
}

export function resolveServiceModule<TContext = unknown>(
  module: unknown,
): Readonly<ZelavisServiceDefinition<TContext>> {
  if (!module || typeof module !== "object") {
    throw new TypeError("A service module object is required.");
  }

  if ("name" in module) {
    return defineService(module as ZelavisServiceDefinition<TContext>);
  }

  if ("service" in module && module.service !== undefined) {
    return defineService(module.service as ZelavisServiceDefinition<TContext>);
  }

  if ("default" in module && module.default !== undefined) {
    return defineService(module.default as ZelavisServiceDefinition<TContext>);
  }

  throw new TypeError(
    "Service modules must export a service definition either directly, as `service`, or as `default`.",
  );
}

export async function loadService<TContext = unknown>(
  specifier: string,
  options: ZelavisServiceLoadOptions = {},
): Promise<Readonly<ZelavisServiceDefinition<TContext>>> {
  if (!specifier || typeof specifier !== "string") {
    throw new TypeError("A service module specifier string is required.");
  }

  const importer =
    options.importer ??
    ((moduleSpecifier: string) => import(moduleSpecifier));

  return resolveServiceModule<TContext>(await importer(specifier));
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

      return {
        service: await loadService<TContext>(entry.specifier, options),
        specifier: entry.specifier,
        status: entry.status ?? "installed",
        source: entry.source,
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
  /**
   * Bundle store the service-app synthesizer reads from. When omitted,
   * services that declare an `app` field are still mounted but their
   * synthesized routes fall back to a 404 — i.e. the host has not
   * configured static-asset serving. Provide a store (typically a
   * {@link createSharedBundleStore} backed by `platform.resources.files`)
   * for the routes to actually serve content.
   */
  bundleStore?: BundleStore;
  /**
   * Project ownership context for synthesized app services. The
   * `BundleStore` uses this to key into per-tenant asset namespaces. For
   * system-host activation (no multi-tenancy), leave undefined.
   */
  projectId?: string;
  /**
   * Domain-binding store. When set, extension-scoped service apps get
   * host-bound routing only for verified bindings owned by their
   * project or service. System services are unaffected.
   */
  domainBindings?: DomainBindingStore;
  /**
   * Service names that extension-scoped services may not provide through
   * runtimeServices. Static system services can still compose them.
   */
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
  const addServices = (services: readonly ZelavisAnyRuntimeServiceInput[]) => {
    activatedServices.push(...services);
  };
  const assertCanAddRuntimeService = (
    owner: Readonly<ZelavisServiceDefinition<TContext>>,
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
  const shouldMountService = (service: ZelavisServiceDefinition<TContext>) =>
    service.basePath !== undefined ||
    service.service !== undefined ||
    Object.values(service.api ?? {}).some((routes) => routes.length > 0);

  for (const entry of installedServices) {
    if (entry.service.extends) {
      continue;
    }

    const children = installedServices
      .filter((installed) => isChildServiceAllowed(entry, installed))
      .map((installed) => installed.service);

    if (shouldMountService(entry.service)) {
      assertCanAddRuntimeService(
        entry.service,
        entry.service as unknown as ZelavisAnyRuntimeServiceInput,
      );
      addService(entry.service as unknown as ZelavisAnyRuntimeServiceInput);
    }

    // Synthesize an asset-serving service for services that declare an
    // `app`. The synthesizer decides the effective mount internally
    // based on (scope, verified hosts): system services keep their
    // declared mount; extension services with verified host bindings
    // serve their declared mount restricted to those hosts; extension
    // services without verified hosts get the path-namespaced
    // `/apps/<service-name>` mount on the shared host.
    if (entry.service.app && options.bundleStore) {
      const appService = await synthesizeServiceAppService({
        service: entry.service as Readonly<ZelavisServiceDefinition<unknown>>,
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
      service: entry.service as Readonly<ZelavisServiceDefinition<ZelavisServiceSetupContext>>,
      registry: registry as readonly Readonly<
        ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>
      >[],
      children,
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
