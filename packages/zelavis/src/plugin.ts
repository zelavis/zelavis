import type { ZelavisAnyServiceInput } from "@zelavis/server";

export interface ZelavisPluginMenuDefinition {
  title: string;
  path: string;
  pageLabel?: string;
  items?: readonly ZelavisPluginMenuDefinition[];
}

export interface ZelavisPluginDefinition<TContext = unknown> {
  name: string;
  version?: string;
  menu?: ZelavisPluginMenuDefinition;
  services?: readonly ZelavisAnyServiceInput[];
  setup?: (context: TContext) => void | Promise<void>;
}

export interface ZelavisPluginRegistryEntry<TContext = unknown> {
  plugin: Readonly<ZelavisPluginDefinition<TContext>>;
  status: "installed" | "available";
  source?: "official" | "community";
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

    if (!definition.menu.path || typeof definition.menu.path !== "string") {
      throw new TypeError("Plugin menu metadata must include a string path.");
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

  return Object.freeze({
    ...definition,
    menu: definition.menu ? freezeMenu(definition.menu) : definition.menu,
    services: definition.services
      ? Object.freeze([...definition.services])
      : definition.services,
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

      return Object.freeze({
        ...entry,
        plugin,
      });
    }),
  );
}
