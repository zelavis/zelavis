import {
  type ZelavisAnyServiceInput,
  type ZelavisServerRoute,
  type ZelavisService,
  type ZelavisServiceMenuDefinition,
} from "@zelavis/server";
import type { BundleStore } from "./bundle-store.js";
import type { DomainBindingStore } from "./domain-binding.js";
import { synthesizePluginAppService } from "./plugin-app.js";

export const ZELAVIS_PLUGIN_V1 = "ZELAVIS_PLUGIN_V1" as const;
export type ZelavisPluginContractVersion = typeof ZELAVIS_PLUGIN_V1;
export interface ZelavisPluginMenuPageRenderContext {
  plugin: string;
  page: string;
  rootPath: string;
  api: ZelavisPluginSetupApiContext;
}

export interface ZelavisPluginRenderedPageDocument {
  html: string;
  status?: number;
  headers?: HeadersInit;
  contentType?: string;
}

export interface ZelavisPluginMenuPageDefinition {
  id: string;
  title?: string;
  render?:
    | ((
        context: ZelavisPluginMenuPageRenderContext,
      ) =>
        | string
        | ZelavisPluginRenderedPageDocument
        | Promise<string | ZelavisPluginRenderedPageDocument>);
}

export type ZelavisPluginMenuDefinition = Omit<
  ZelavisServiceMenuDefinition,
  "items"
> & {
  page?: ZelavisPluginMenuPageDefinition;
  items?: readonly ZelavisPluginMenuDefinition[];
};

export interface ZelavisPluginExtensionTarget {
  plugin: string;
  extensionPoint: string;
}

export type ZelavisPluginExtensionPolicy = "open" | "reviewed" | "private";

export interface ZelavisPluginExtensionPointDefinition {
  name: string;
  policy?: ZelavisPluginExtensionPolicy;
  allowedPlugins?: readonly string[];
}

/**
 * Controls which capabilities are available to this plugin.
 *
 * - `"system"` — first-party or statically registered plugins. Can mount on
 *   any dashboard surface (root, core, workspace, settings). Set automatically
 *   when the plugin is passed directly to `zelavis({ plugins: [...] })`.
 *
 * - `"workspace"` — runtime-installed plugins (uploaded ZIP, marketplace).
 *   Always mount under the Workspace surface regardless of what `menu.surface`
 *   declares. Enforced by the activation layer, not the definition.
 *
 * Defaults to `"workspace"`. The activation layer upgrades this to `"system"`
 * for statically registered entries and forces it back to `"workspace"` for
 * any plugin loaded from the registry store.
 */
export type ZelavisPluginScope = "system" | "workspace";

/**
 * Static-asset serving mode for a plugin app.
 *
 * - `"spa"` falls back to the index document for any unmatched sub-path under
 *   the mount prefix. Suitable for single-page apps that own client-side routing.
 * - `"mpa"` resolves the request path against the bundle filesystem (with
 *   `.html` and `/index.html` lookups). Suitable for static MPAs like Astro,
 *   Hugo, 11ty, or hand-authored HTML.
 */
export type ZelavisPluginAppMode = "spa" | "mpa";

/**
 * A domain binding declaration. Strings are treated as bare hostnames. The
 * object form leaves room for future per-domain config (redirects, headers,
 * cert backend) without a breaking type change.
 */
export interface ZelavisPluginAppDomainBinding {
  host: string;
}

export type ZelavisPluginAppDomainEntry =
  | string
  | ZelavisPluginAppDomainBinding;

/**
 * Context handed to a dynamic shell renderer.
 *
 * `request` is the incoming `Request`. `path` is the bundle-relative path
 * that was being resolved when the SPA fallback fired (empty string for
 * the mount root). Renderers can use the path to discriminate — e.g. the
 * dashboard returns 404 for any path under its API prefix, otherwise
 * serves the SPA shell.
 */
export interface ZelavisPluginAppShellRenderContext {
  request: Request;
  path: string;
}

export interface ZelavisPluginAppShellResult {
  status?: number;
  headers?: HeadersInit;
  body?: unknown;
}

/**
 * Optional dynamic-shell hook. When set, the synthesized app handler
 * calls `render` instead of reading `indexHtml` from the bundle on:
 *
 * - a request to the mount root,
 * - a SPA-fallback miss (mode `"spa"`, asset not found).
 *
 * Concrete use case: the dashboard injects a `<script>` with runtime
 * config (API base path, theme, feature flags) into the HTML shell
 * before serving. A plain static index document can't do that.
 *
 * The renderer fully controls the response (status/headers/body), so it
 * can also choose to 404 on specific paths — e.g. don't serve the SPA
 * shell for `api/*` deep links.
 */
export interface ZelavisPluginAppShellDefinition {
  render: (
    context: ZelavisPluginAppShellRenderContext,
  ) => ZelavisPluginAppShellResult | Promise<ZelavisPluginAppShellResult>;
}

/**
 * Declares that a plugin owns a route prefix (and optionally a set of domains)
 * and serves a web application — SPA bundle, static MPA, or server-rendered
 * (future). The activation layer turns this into asset-serving routes on the
 * underlying dispatcher.
 *
 * This is the foundation for "dashboard is just a plugin", embedded
 * customer-built apps, and (eventually) tenant-domain hosting.
 */
export interface ZelavisPluginAppDefinition {
  /**
   * Path prefix this app is mounted under. Defaults to `"/"` (root).
   * Workspace-scoped plugins have their mount rewritten to
   * `/apps/<plugin-name>` at activation regardless of what they declare.
   */
  mount?: string;
  /**
   * Hostnames this app responds on. Strings are exact-match hostnames; the
   * sentinel `"*"` matches any host. Defaults to `["*"]` (host-agnostic).
   */
  domains?: readonly ZelavisPluginAppDomainEntry[];
  /**
   * Logical bundle identifier. The BundleStore resolves this against the
   * plugin's installed assets — for the default `SharedBundleStore`, it
   * keys into `apps/<plugin-name>/<bundle>/...`. Defaults to `"dist"`.
   */
  bundle?: string;
  /** Index document for SPA fallback and MPA directory roots. Default `"index.html"`. */
  indexHtml?: string;
  /** Serving mode. Default `"spa"`. */
  mode?: ZelavisPluginAppMode;
  /**
   * Dynamic-shell renderer. See {@link ZelavisPluginAppShellDefinition}.
   * When set, the synthesizer uses `render` for the mount root and for
   * SPA-fallback misses, instead of reading `indexHtml` from the bundle.
   */
  shell?: ZelavisPluginAppShellDefinition;
  /**
   * Dev-server URL to proxy to instead of serving static files. When set and
   * the host is in development mode, the runtime forwards requests to this
   * URL instead of reading from the bundle.
   */
  devUrl?: string;
}

export interface ZelavisPluginDefinition<
  TContext = unknown,
  TService = unknown,
> {
  name: string;
  contractVersion?: ZelavisPluginContractVersion;
  /**
   * Controls surface access and other trust-gated capabilities.
   * Set by the registration path — do not rely on this field in plugin code.
   */
  scope?: ZelavisPluginScope;
  basePath?: string;
  api?: Record<string, readonly ZelavisServerRoute<TService>[]>;
  service?: TService;
  version?: string;
  menu?: ZelavisPluginMenuDefinition;
  /**
   * Declare a hosted web application for this plugin. See
   * {@link ZelavisPluginAppDefinition}.
   */
  app?: ZelavisPluginAppDefinition;
  services?: readonly ZelavisAnyServiceInput[];
  extends?: ZelavisPluginExtensionTarget;
  extensionPoints?: readonly ZelavisPluginExtensionPointDefinition[];
  setup?: (
    context: TContext,
  ) =>
    | void
    | ZelavisPluginSetupResult
    | Promise<void | ZelavisPluginSetupResult>;
}

export type ZelavisPluginV1Definition<
  TContext = unknown,
  TService = unknown,
> = ZelavisPluginDefinition<TContext, TService> & {
  contractVersion?: typeof ZELAVIS_PLUGIN_V1;
};

export interface ZelavisPluginRegistryEntry<TContext = unknown> {
  plugin: Readonly<ZelavisPluginDefinition<TContext>>;
  specifier?: string;
  status: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

export type ZelavisPluginCatalogSource = "official" | "community";
export type ZelavisPluginCatalogReviewStatus =
  | "official"
  | "reviewed"
  | "unreviewed"
  | "blocked";

export interface ZelavisPluginCatalogCompatibility {
  zelavis?: string;
  parentPlugin?: string;
  plugin?: string;
}

export interface ZelavisPluginCatalogLinks {
  homepage?: string;
  repository?: string;
  documentation?: string;
  issues?: string;
}

export interface ZelavisPluginCatalogEntry {
  name: string;
  package: string;
  publisher: string;
  source: ZelavisPluginCatalogSource;
  title?: string;
  summary?: string;
  description?: string;
  version?: string;
  reviewStatus?: ZelavisPluginCatalogReviewStatus;
  verified?: boolean;
  extends?: ZelavisPluginExtensionTarget;
  compatibility?: ZelavisPluginCatalogCompatibility;
  links?: ZelavisPluginCatalogLinks;
  license?: string;
  tags?: readonly string[];
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
  specifier?: string;
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

export interface ZelavisPluginSetupCoreContext {
  database?: unknown;
}

export interface ZelavisPluginSetupContext {
  plugin: Readonly<ZelavisPluginDefinition<ZelavisPluginSetupContext>>;
  registry: readonly Readonly<ZelavisPluginRegistryEntry<ZelavisPluginSetupContext>>[];
  rootPath: string;
  api: ZelavisPluginSetupApiContext;
  platform: ZelavisPluginSetupPlatformContext;
  core: ZelavisPluginSetupCoreContext;
  children: readonly Readonly<ZelavisPluginDefinition>[];
  services: readonly ZelavisAnyServiceInput[];
  addService: (service: ZelavisAnyServiceInput) => void;
  addServices: (services: readonly ZelavisAnyServiceInput[]) => void;
}

function freezeMenu(
  menu: ZelavisPluginMenuDefinition,
): Readonly<ZelavisPluginMenuDefinition> {
  return Object.freeze({
    ...menu,
    page: menu.page
      ? Object.freeze({
          ...menu.page,
        })
      : menu.page,
    items: menu.items?.map(freezeMenu),
  });
}

function validatePluginMenu(
  menu: ZelavisPluginMenuDefinition,
  path = menu.title,
): void {
  // `surface` is allowed in the definition — the activation layer enforces
  // workspace-only scoping for runtime-installed plugins at registration time,
  // not here. System plugins registered statically may use any surface.

  if ("page" in menu && menu.page !== undefined) {
    if (!menu.page || typeof menu.page !== "object") {
      throw new TypeError(
        `Plugin menu page metadata for "${path}" must be an object.`,
      );
    }

    if (!menu.page.id || typeof menu.page.id !== "string") {
      throw new TypeError(
        `Plugin menu page metadata for "${path}" must include a string id.`,
      );
    }

    if (
      "title" in menu.page &&
      menu.page.title !== undefined &&
      typeof menu.page.title !== "string"
    ) {
      throw new TypeError(
        `Plugin menu page metadata for "${path}" title must be a string when provided.`,
      );
    }

    if (
      "render" in menu.page &&
      menu.page.render !== undefined &&
      typeof menu.page.render !== "function"
    ) {
      throw new TypeError(
        `Plugin menu page metadata for "${path}" render field must be a function.`,
      );
    }
  }

  menu.items?.forEach((item) => validatePluginMenu(item, `${path} > ${item.title}`));
}

export function findPluginMenuPageById(
  menu: ZelavisPluginMenuDefinition | undefined,
  pageId: string,
): ZelavisPluginMenuPageDefinition | undefined {
  if (!menu) {
    return undefined;
  }

  if (menu.page?.id === pageId) {
    return menu.page;
  }

  for (const item of menu.items ?? []) {
    const page = findPluginMenuPageById(item, pageId);
    if (page) {
      return page;
    }
  }

  return undefined;
}

function freezeExtensionPoint(
  extensionPoint: ZelavisPluginExtensionPointDefinition,
): Readonly<ZelavisPluginExtensionPointDefinition> {
  return Object.freeze({
    ...extensionPoint,
    allowedPlugins: extensionPoint.allowedPlugins
      ? Object.freeze([...extensionPoint.allowedPlugins])
      : extensionPoint.allowedPlugins,
  });
}

function validateExtensionPoints(
  extensionPoints: readonly ZelavisPluginExtensionPointDefinition[],
): void {
  const seen = new Set<string>();

  for (const extensionPoint of extensionPoints) {
    if (!extensionPoint || typeof extensionPoint !== "object") {
      throw new TypeError("Plugin extension points must be objects.");
    }

    if (!extensionPoint.name || typeof extensionPoint.name !== "string") {
      throw new TypeError("Plugin extension points must include a string name.");
    }

    if (seen.has(extensionPoint.name)) {
      throw new TypeError(
        `Plugin extension points must use unique names. Duplicate: ${extensionPoint.name}`,
      );
    }

    seen.add(extensionPoint.name);

    if (
      extensionPoint.policy !== undefined &&
      extensionPoint.policy !== "open" &&
      extensionPoint.policy !== "reviewed" &&
      extensionPoint.policy !== "private"
    ) {
      throw new TypeError(
        'Plugin extension point policy must be "open", "reviewed", or "private".',
      );
    }

    if (
      extensionPoint.allowedPlugins !== undefined &&
      !Array.isArray(extensionPoint.allowedPlugins)
    ) {
      throw new TypeError("Plugin extension point allowed plugins must be an array.");
    }

    for (const pluginName of extensionPoint.allowedPlugins ?? []) {
      if (!pluginName || typeof pluginName !== "string") {
        throw new TypeError(
          "Plugin extension point allowed plugins must be string plugin names.",
        );
      }
    }
  }
}

function getExtensionPoint(
  parent: ZelavisPluginDefinition,
  extensionPointName: string,
): ZelavisPluginExtensionPointDefinition | undefined {
  return parent.extensionPoints?.find(
    (extensionPoint) => extensionPoint.name === extensionPointName,
  );
}

function validateOptionalString(
  value: unknown,
  fieldName: string,
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string when provided.`);
  }
}

function freezeCatalogCompatibility(
  compatibility: ZelavisPluginCatalogCompatibility,
): Readonly<ZelavisPluginCatalogCompatibility> {
  validateOptionalString(
    compatibility.zelavis,
    "Plugin catalog compatibility zelavis",
  );
  validateOptionalString(
    compatibility.parentPlugin,
    "Plugin catalog compatibility parentPlugin",
  );
  validateOptionalString(
    compatibility.plugin,
    "Plugin catalog compatibility plugin",
  );

  return Object.freeze({ ...compatibility });
}

function freezeCatalogLinks(
  links: ZelavisPluginCatalogLinks,
): Readonly<ZelavisPluginCatalogLinks> {
  validateOptionalString(links.homepage, "Plugin catalog link homepage");
  validateOptionalString(links.repository, "Plugin catalog link repository");
  validateOptionalString(links.documentation, "Plugin catalog link documentation");
  validateOptionalString(links.issues, "Plugin catalog link issues");

  return Object.freeze({ ...links });
}

function validatePluginApp(app: ZelavisPluginAppDefinition): void {
  if (!app || typeof app !== "object") {
    throw new TypeError("Plugin app metadata must be an object.");
  }

  if (
    "mount" in app &&
    app.mount !== undefined &&
    typeof app.mount !== "string"
  ) {
    throw new TypeError("Plugin app mount must be a string when provided.");
  }

  if (app.mount !== undefined && !app.mount.startsWith("/")) {
    throw new TypeError("Plugin app mount must start with a leading slash.");
  }

  if ("domains" in app && app.domains !== undefined) {
    if (!Array.isArray(app.domains)) {
      throw new TypeError("Plugin app domains must be provided as an array.");
    }

    for (const entry of app.domains) {
      if (typeof entry === "string") {
        if (entry.length === 0) {
          throw new TypeError("Plugin app domain entries must not be empty.");
        }
        continue;
      }

      if (!entry || typeof entry !== "object") {
        throw new TypeError(
          "Plugin app domain entries must be strings or binding objects.",
        );
      }

      if (!entry.host || typeof entry.host !== "string") {
        throw new TypeError(
          "Plugin app domain bindings must include a string host.",
        );
      }
    }
  }

  if (
    "bundle" in app &&
    app.bundle !== undefined &&
    typeof app.bundle !== "string"
  ) {
    throw new TypeError("Plugin app bundle must be a string when provided.");
  }

  if (
    "indexHtml" in app &&
    app.indexHtml !== undefined &&
    typeof app.indexHtml !== "string"
  ) {
    throw new TypeError(
      "Plugin app indexHtml must be a string when provided.",
    );
  }

  if ("mode" in app && app.mode !== undefined) {
    if (app.mode !== "spa" && app.mode !== "mpa") {
      throw new TypeError('Plugin app mode must be "spa" or "mpa".');
    }
  }

  if ("shell" in app && app.shell !== undefined) {
    if (!app.shell || typeof app.shell !== "object") {
      throw new TypeError("Plugin app shell must be an object when provided.");
    }
    if (typeof app.shell.render !== "function") {
      throw new TypeError("Plugin app shell.render must be a function.");
    }
  }

  if (
    "devUrl" in app &&
    app.devUrl !== undefined &&
    typeof app.devUrl !== "string"
  ) {
    throw new TypeError("Plugin app devUrl must be a string when provided.");
  }
}

function freezePluginApp(
  app: ZelavisPluginAppDefinition,
): Readonly<ZelavisPluginAppDefinition> {
  const frozenDomains = app.domains
    ? Object.freeze(
        app.domains.map((entry) =>
          typeof entry === "string" ? entry : Object.freeze({ ...entry }),
        ),
      )
    : app.domains;

  return Object.freeze({
    mount: app.mount,
    domains: frozenDomains,
    bundle: app.bundle,
    indexHtml: app.indexHtml,
    mode: app.mode,
    shell: app.shell ? Object.freeze({ render: app.shell.render }) : app.shell,
    devUrl: app.devUrl,
  });
}

function validateExtensionTarget(target: ZelavisPluginExtensionTarget): void {
  if (!target || typeof target !== "object") {
    throw new TypeError("Plugin extension target must be an object.");
  }

  if (!target.plugin || typeof target.plugin !== "string") {
    throw new TypeError(
      "Plugin extension target must include a parent plugin name.",
    );
  }

  if (!target.extensionPoint || typeof target.extensionPoint !== "string") {
    throw new TypeError(
      "Plugin extension target must include an extension point.",
    );
  }
}

export function isPluginExtensionAllowed(
  parent: Readonly<ZelavisPluginRegistryEntry<any>>,
  child: Readonly<ZelavisPluginRegistryEntry<any>>,
): boolean {
  const target = child.plugin.extends;

  if (!target || target.plugin !== parent.plugin.name) {
    return false;
  }

  const extensionPoint = getExtensionPoint(
    parent.plugin,
    target.extensionPoint,
  );

  if (!extensionPoint) {
    return false;
  }

  const policy = extensionPoint.policy ?? "private";

  if (policy === "open") {
    return true;
  }

  return extensionPoint.allowedPlugins?.includes(child.plugin.name) ?? false;
}

export function definePluginCatalogEntry(
  entry: ZelavisPluginCatalogEntry,
): Readonly<ZelavisPluginCatalogEntry> {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("A plugin catalog entry object is required.");
  }

  if (!entry.name || typeof entry.name !== "string") {
    throw new TypeError("A plugin catalog entry must include a string name.");
  }

  if (!entry.package || typeof entry.package !== "string") {
    throw new TypeError("A plugin catalog entry must include a string package.");
  }

  if (!entry.publisher || typeof entry.publisher !== "string") {
    throw new TypeError("A plugin catalog entry must include a string publisher.");
  }

  if (entry.source !== "official" && entry.source !== "community") {
    throw new TypeError(
      'A plugin catalog entry source must be "official" or "community".',
    );
  }

  if (
    entry.reviewStatus !== undefined &&
    entry.reviewStatus !== "official" &&
    entry.reviewStatus !== "reviewed" &&
    entry.reviewStatus !== "unreviewed" &&
    entry.reviewStatus !== "blocked"
  ) {
    throw new TypeError(
      'A plugin catalog entry reviewStatus must be "official", "reviewed", "unreviewed", or "blocked".',
    );
  }

  validateOptionalString(entry.title, "Plugin catalog entry title");
  validateOptionalString(entry.summary, "Plugin catalog entry summary");
  validateOptionalString(entry.description, "Plugin catalog entry description");
  validateOptionalString(entry.version, "Plugin catalog entry version");
  validateOptionalString(entry.license, "Plugin catalog entry license");

  if (entry.verified !== undefined && typeof entry.verified !== "boolean") {
    throw new TypeError(
      "A plugin catalog entry verified field must be boolean when provided.",
    );
  }

  if (entry.extends !== undefined) {
    validateExtensionTarget(entry.extends);
  }

  if (entry.compatibility !== undefined) {
    if (!entry.compatibility || typeof entry.compatibility !== "object") {
      throw new TypeError(
        "A plugin catalog entry compatibility field must be an object.",
      );
    }
  }

  if (entry.links !== undefined) {
    if (!entry.links || typeof entry.links !== "object") {
      throw new TypeError("A plugin catalog entry links field must be an object.");
    }
  }

  if (entry.tags !== undefined && !Array.isArray(entry.tags)) {
    throw new TypeError("A plugin catalog entry tags field must be an array.");
  }

  for (const tag of entry.tags ?? []) {
    if (!tag || typeof tag !== "string") {
      throw new TypeError("A plugin catalog entry tags must be strings.");
    }
  }

  return Object.freeze({
    ...entry,
    reviewStatus:
      entry.reviewStatus ??
      (entry.source === "official" ? "official" : "unreviewed"),
    verified: entry.verified ?? (entry.source === "official"),
    extends: entry.extends ? Object.freeze({ ...entry.extends }) : entry.extends,
    compatibility: entry.compatibility
      ? freezeCatalogCompatibility(entry.compatibility)
      : entry.compatibility,
    links: entry.links ? freezeCatalogLinks(entry.links) : entry.links,
    tags: entry.tags ? Object.freeze([...entry.tags]) : entry.tags,
  });
}

export function definePluginCatalog(
  entries: readonly ZelavisPluginCatalogEntry[],
): readonly Readonly<ZelavisPluginCatalogEntry>[] {
  if (!Array.isArray(entries)) {
    throw new TypeError("A plugin catalog must be an array.");
  }

  const seen = new Set<string>();

  return Object.freeze(
    entries.map((entry) => {
      const normalized = definePluginCatalogEntry(entry);

      if (seen.has(normalized.name)) {
        throw new TypeError(
          `Plugin catalog entries must use unique names. Duplicate: ${normalized.name}`,
        );
      }

      seen.add(normalized.name);

      return normalized;
    }),
  );
}

export function definePlugin<TContext = unknown>(
  definition: ZelavisPluginV1Definition<TContext>,
): Readonly<ZelavisPluginDefinition<TContext>> {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("A plugin definition object is required.");
  }

  if (!definition.name || typeof definition.name !== "string") {
    throw new TypeError("A plugin must include a string name.");
  }

  if (
    "contractVersion" in definition &&
    definition.contractVersion !== undefined &&
    definition.contractVersion !== ZELAVIS_PLUGIN_V1
  ) {
    throw new TypeError(
      `Unsupported plugin contract version. Expected ${ZELAVIS_PLUGIN_V1}.`,
    );
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

    validatePluginMenu(definition.menu);
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

  if ("extends" in definition && definition.extends !== undefined) {
    validateExtensionTarget(definition.extends);

    if (definition.menu !== undefined) {
      throw new TypeError(
        "Child plugins cannot declare top-level dashboard menu metadata.",
      );
    }
  }

  if (
    "extensionPoints" in definition &&
    definition.extensionPoints !== undefined
  ) {
    if (!Array.isArray(definition.extensionPoints)) {
      throw new TypeError("Plugin extension points must be provided as an array.");
    }

    validateExtensionPoints(definition.extensionPoints);
  }

  if ("app" in definition && definition.app !== undefined) {
    validatePluginApp(definition.app);
  }

  const normalized = {
    name: definition.name,
    basePath: definition.basePath,
    api: definition.api ?? {},
    service: definition.service as unknown,
    menu: definition.menu ? freezeMenu(definition.menu) : definition.menu,
    services: definition.services
      ? Object.freeze([...definition.services])
      : definition.services,
  } as ZelavisService<unknown> & ZelavisPluginDefinition<TContext>;

  return Object.freeze({
    ...normalized,
    contractVersion: ZELAVIS_PLUGIN_V1,
    // Default to "workspace". The registration path (static vs. uploaded)
    // overrides this — see loadStoredPluginRegistryModules in index.ts.
    scope: definition.scope ?? "workspace",
    version: definition.version,
    app: definition.app ? freezePluginApp(definition.app) : definition.app,
    extends: definition.extends
      ? Object.freeze({ ...definition.extends })
      : definition.extends,
    extensionPoints: definition.extensionPoints
      ? Object.freeze(definition.extensionPoints.map(freezeExtensionPoint))
      : definition.extensionPoints,
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

      const plugin = definePlugin(entry.plugin);

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
    return definePlugin(module as ZelavisPluginDefinition<TContext>);
  }

  if ("plugin" in module && module.plugin !== undefined) {
    return definePlugin(module.plugin as ZelavisPluginDefinition<TContext>);
  }

  if ("default" in module && module.default !== undefined) {
    return definePlugin(module.default as ZelavisPluginDefinition<TContext>);
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
        specifier: entry.specifier,
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
        ...(entry.specifier ? { specifier: entry.specifier } : {}),
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

export interface ActivatePluginRegistryOptions {
  /**
   * Bundle store the plugin-app synthesizer reads from. When omitted,
   * plugins that declare an `app` field are still mounted but their
   * synthesized routes fall back to a 404 — i.e. the host has not
   * configured static-asset serving. Provide a store (typically a
   * {@link createSharedBundleStore} backed by `platform.resources.files`)
   * for the routes to actually serve content.
   */
  bundleStore?: BundleStore;
  /**
   * Workspace ownership context for synthesized app services. The
   * `BundleStore` uses this to key into per-tenant asset namespaces. For
   * system-host activation (no multi-tenancy), leave undefined.
   */
  workspaceId?: string;
  /**
   * Domain-binding store. When set, workspace-scoped plugins
   * declaring `app.domains` only get host-bound routing for hosts with
   * a verified binding owned by their workspace+plugin pair. System
   * plugins are unaffected.
   */
  domainBindings?: DomainBindingStore;
}

export async function activatePluginRegistry<
  TContext extends ZelavisPluginSetupContext = ZelavisPluginSetupContext,
>(
  registry: readonly Readonly<ZelavisPluginRegistryEntry<TContext>>[],
  context: Omit<
    TContext,
    "plugin" | "registry" | "children" | "services" | "addService" | "addServices"
  >,
  options: ActivatePluginRegistryOptions = {},
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
    if (entry.plugin.extends) {
      continue;
    }

    const children = installedPlugins
      .filter((installed) => isPluginExtensionAllowed(entry, installed))
      .map((installed) => installed.plugin);

    if (shouldMountPlugin(entry.plugin)) {
      addService(entry.plugin as unknown as ZelavisAnyServiceInput);
    }

    // Synthesize an asset-serving service for plugins that declare an
    // `app`. The synthesizer decides the effective mount internally
    // based on (scope, verified hosts): system plugins keep their
    // declared mount; workspace plugins with verified host bindings
    // serve their declared mount restricted to those hosts; workspace
    // plugins without verified hosts get the path-namespaced
    // `/apps/<plugin-name>` mount on the shared host.
    if (entry.plugin.app && options.bundleStore) {
      const appService = await synthesizePluginAppService({
        plugin: entry.plugin as Readonly<ZelavisPluginDefinition<unknown>>,
        bundleStore: options.bundleStore,
        workspaceId: options.workspaceId,
        domainBindings: options.domainBindings,
      });
      if (appService) {
        addService(appService as unknown as ZelavisAnyServiceInput);
      }
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
      children,
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
