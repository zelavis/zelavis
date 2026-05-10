import {
  defineServerService,
  type ZelavisAnyServiceInput,
  type ZelavisServerRoute,
  type ZelavisServerService,
  type ZelavisServerServiceMenuDefinition,
} from "@zelavis/server";

export type ZelavisPluginMenuDefinition = ZelavisServerServiceMenuDefinition;

export interface ZelavisPluginDefinition<
  TContext = unknown,
  TService = unknown,
> {
  name: string;
  basePath?: string;
  api?: Record<string, readonly ZelavisServerRoute<TService>[]>;
  service?: TService;
  version?: string;
  menu?: ZelavisPluginMenuDefinition;
  services?: readonly ZelavisAnyServiceInput[];
  setup?: (
    context: TContext,
  ) =>
    | void
    | ZelavisPluginSetupResult
    | Promise<void | ZelavisPluginSetupResult>;
}

export interface ZelavisPluginRegistryEntry<TContext = unknown> {
  plugin: Readonly<ZelavisPluginDefinition<TContext>>;
  status: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

export type ZelavisPluginModule<TContext = unknown> =
  | Readonly<ZelavisPluginDefinition<TContext>>
  | {
      default?: Readonly<ZelavisPluginDefinition<TContext>>;
      plugin?: Readonly<ZelavisPluginDefinition<TContext>>;
    };

export interface ZelavisPluginLoadOptions {
  importer?: (specifier: string) => Promise<unknown>;
}

export interface ZelavisPluginRegistryModuleEntry {
  specifier: string;
  status?: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

export interface ZelavisPluginRegistryStateEntry {
  name: string;
  status?: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

export interface ZelavisPluginRegistryStore {
  read:
    | (() =>
        | Promise<readonly ZelavisPluginRegistryStateEntry[] | undefined>
        | readonly ZelavisPluginRegistryStateEntry[]
        | undefined)
    | (() => Promise<readonly ZelavisPluginRegistryStateEntry[] | undefined>);
  write: (
    entries: readonly ZelavisPluginRegistryStateEntry[],
  ) =>
    | Promise<readonly ZelavisPluginRegistryStateEntry[]>
    | readonly ZelavisPluginRegistryStateEntry[];
}

export interface ZelavisPluginSetupResult {
  services?: readonly ZelavisAnyServiceInput[];
}

export interface ZelavisPluginSetupApiContext {
  prefix: string;
  version: string;
  basePath: string;
}

export interface ZelavisPluginSetupPlatformContext {
  presets: readonly string[];
  resources: {
    keyValueStore: boolean;
    fileStorage: boolean;
  };
  metadata: Readonly<Record<string, unknown>>;
}

export interface ZelavisPluginSetupContext {
  plugin: Readonly<ZelavisPluginDefinition<ZelavisPluginSetupContext>>;
  registry: readonly Readonly<ZelavisPluginRegistryEntry<ZelavisPluginSetupContext>>[];
  rootPath: string;
  api: ZelavisPluginSetupApiContext;
  platform: ZelavisPluginSetupPlatformContext;
  services: readonly ZelavisAnyServiceInput[];
  addService: (service: ZelavisAnyServiceInput) => void;
  addServices: (services: readonly ZelavisAnyServiceInput[]) => void;
}

function freezeMenu(
  menu: ZelavisPluginMenuDefinition,
): Readonly<ZelavisPluginMenuDefinition> {
  return Object.freeze({
    ...menu,
    items: menu.items?.map(freezeMenu),
  });
}

export function createPlugin<TContext = unknown>(
  definition: ZelavisPluginDefinition<TContext>,
): Readonly<ZelavisPluginDefinition<TContext>> {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("A plugin definition object is required.");
  }

  if (!definition.name || typeof definition.name !== "string") {
    throw new TypeError("A plugin must include a string name.");
  }

  if (
    "version" in definition &&
    definition.version !== undefined &&
    typeof definition.version !== "string"
  ) {
    throw new TypeError("A plugin version must be a string when provided.");
  }

  if (definition.menu !== undefined) {
    if (!definition.menu || typeof definition.menu !== "object") {
      throw new TypeError("Plugin menu metadata must be an object.");
    }

    if (
      !definition.menu.title ||
      typeof definition.menu.title !== "string"
    ) {
      throw new TypeError("Plugin menu metadata must include a string title.");
    }

    if (
      "path" in definition.menu &&
      definition.menu.path !== undefined &&
      typeof definition.menu.path !== "string"
    ) {
      throw new TypeError(
        "Plugin menu metadata path must be a string when provided.",
      );
    }

    if (
      definition.menu.path === undefined &&
      (!definition.menu.items || definition.menu.items.length === 0)
    ) {
      throw new TypeError(
        "Plugin menu metadata must include a path or nested items.",
      );
    }
  }

  if (
    "setup" in definition &&
    definition.setup !== undefined &&
    typeof definition.setup !== "function"
  ) {
    throw new TypeError("A plugin setup field must be a function.");
  }

  if (
    "services" in definition &&
    definition.services !== undefined &&
    !Array.isArray(definition.services)
  ) {
    throw new TypeError("Plugin services must be provided as an array.");
  }

  const normalized = defineServerService({
    name: definition.name,
    basePath: definition.basePath,
    api: definition.api ?? {},
    service: definition.service as unknown,
    menu: definition.menu ? freezeMenu(definition.menu) : definition.menu,
    services: definition.services
      ? Object.freeze([...definition.services])
      : definition.services,
  }) as ZelavisServerService<unknown> & ZelavisPluginDefinition<TContext>;

  return Object.freeze({
    ...normalized,
    version: definition.version,
    setup: definition.setup,
  });
}

export function createPluginRegistry<TContext = unknown>(
  entries: readonly ZelavisPluginRegistryEntry<TContext>[],
): readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[] {
  const seen = new Set<string>();

  return Object.freeze(
    entries.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new TypeError("A plugin registry entry object is required.");
      }

      const plugin = createPlugin(entry.plugin);

      if (seen.has(plugin.name)) {
        throw new TypeError(
          `Plugin registry entries must use unique names. Duplicate: ${plugin.name}`,
        );
      }

      seen.add(plugin.name);

      if (entry.status !== "installed" && entry.status !== "available") {
        throw new TypeError(
          'Plugin registry entries must use status "installed" or "available".',
        );
      }

      if (
        entry.source !== undefined &&
        entry.source !== "official" &&
        entry.source !== "community"
      ) {
        throw new TypeError(
          'Plugin registry entries must use source "official" or "community" when provided.',
        );
      }

      if (
        entry.order !== undefined &&
        (!Number.isInteger(entry.order) || entry.order < 0)
      ) {
        throw new TypeError(
          "Plugin registry entry order must be a non-negative integer when provided.",
        );
      }

      return Object.freeze({
        ...entry,
        plugin,
      });
    }),
  );
}

export function resolvePluginModule<TContext = unknown>(
  module: unknown,
): Readonly<ZelavisPluginDefinition<TContext>> {
  if (!module || typeof module !== "object") {
    throw new TypeError("A plugin module object is required.");
  }

  if ("name" in module) {
    return createPlugin(module as ZelavisPluginDefinition<TContext>);
  }

  if ("plugin" in module && module.plugin !== undefined) {
    return createPlugin(module.plugin as ZelavisPluginDefinition<TContext>);
  }

  if ("default" in module && module.default !== undefined) {
    return createPlugin(module.default as ZelavisPluginDefinition<TContext>);
  }

  throw new TypeError(
    "Plugin modules must export a plugin definition either directly, as `plugin`, or as `default`.",
  );
}

export async function loadPlugin<TContext = unknown>(
  specifier: string,
  options: ZelavisPluginLoadOptions = {},
): Promise<Readonly<ZelavisPluginDefinition<TContext>>> {
  if (!specifier || typeof specifier !== "string") {
    throw new TypeError("A plugin module specifier string is required.");
  }

  const importer =
    options.importer ??
    ((moduleSpecifier: string) => import(moduleSpecifier));

  return resolvePluginModule<TContext>(await importer(specifier));
}

export async function loadPluginRegistry<TContext = unknown>(
  entries: readonly ZelavisPluginRegistryModuleEntry[],
  options: ZelavisPluginLoadOptions = {},
): Promise<readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[]> {
  const resolvedEntries = await Promise.all(
    entries.map(async (entry) => {
      if (!entry || typeof entry !== "object") {
        throw new TypeError("A plugin registry module entry object is required.");
      }

      if (!entry.specifier || typeof entry.specifier !== "string") {
        throw new TypeError(
          "Plugin registry module entries must include a string specifier.",
        );
      }

      return {
        plugin: await loadPlugin<TContext>(entry.specifier, options),
        status: entry.status ?? "installed",
        source: entry.source,
        ...(entry.order !== undefined ? { order: entry.order } : {}),
      };
    }),
  );

  return createPluginRegistry(resolvedEntries);
}

export function removePluginFromRegistry<TContext = unknown>(
  registry: readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[],
  pluginName: string,
): readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[] {
  if (!pluginName || typeof pluginName !== "string") {
    throw new TypeError("A plugin name string is required.");
  }

  return Object.freeze(
    registry.filter((entry) => entry.plugin.name !== pluginName),
  );
}

export function serializePluginRegistryState<TContext = unknown>(
  registry: readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[],
): readonly ZelavisPluginRegistryStateEntry[] {
  return Object.freeze(
    registry.map((entry) =>
      Object.freeze({
        name: entry.plugin.name,
        status: entry.status,
        ...(entry.source ? { source: entry.source } : {}),
        ...(entry.order !== undefined ? { order: entry.order } : {}),
      }),
    ),
  );
}

export function applyPluginRegistryState<TContext = unknown>(
  registry: readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[],
  stateEntries: readonly ZelavisPluginRegistryStateEntry[] | undefined,
): readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[] {
  if (!stateEntries || stateEntries.length === 0) {
    return registry;
  }

  const stateByName = new Map(stateEntries.map((entry) => [entry.name, entry]));

  return createPluginRegistry(
    registry.map((entry) => {
      const state = stateByName.get(entry.plugin.name);

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

export async function activatePluginRegistry<
  TContext extends ZelavisPluginSetupContext = ZelavisPluginSetupContext,
>(
  registry: readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[],
  context: Omit<TContext, "plugin" | "registry" | "services" | "addService" | "addServices">,
): Promise<{
  registry: readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[];
  services: readonly ZelavisAnyServiceInput[];
}> {
  const activatedServices: ZelavisAnyServiceInput[] = [];
  const installedPlugins = [...registry]
    .filter((entry) => entry.status === "installed")
    .sort((left, right) => {
      const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.plugin.name.localeCompare(right.plugin.name);
    });

  const addService = (service: ZelavisAnyServiceInput) => {
    activatedServices.push(service);
  };
  const addServices = (services: readonly ZelavisAnyServiceInput[]) => {
    activatedServices.push(...services);
  };
  const shouldMountPlugin = (plugin: ZelavisPluginDefinition<TContext>) =>
    plugin.basePath !== undefined ||
    plugin.service !== undefined ||
    Object.values(plugin.api ?? {}).some((routes) => routes.length > 0);

  for (const entry of installedPlugins) {
    if (shouldMountPlugin(entry.plugin)) {
      addService(entry.plugin as unknown as ZelavisAnyServiceInput);
    }

    if (entry.plugin.services?.length) {
      addServices(entry.plugin.services);
    }

    if (!entry.plugin.setup) {
      continue;
    }

    const result = await entry.plugin.setup({
      ...(context as TContext),
      plugin: entry.plugin as Readonly<ZelavisPluginDefinition<ZelavisPluginSetupContext>>,
      registry: registry as readonly Readonly<
        ZelavisPluginRegistryEntry<ZelavisPluginSetupContext>
      >[],
      services: activatedServices,
      addService,
      addServices,
    } as TContext);

    if (result?.services?.length) {
      addServices(result.services);
    }
  }

  return {
    registry,
    services: Object.freeze([...activatedServices]),
  };
}
