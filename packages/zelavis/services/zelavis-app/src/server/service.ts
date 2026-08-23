import {
  type ZelavisAnyRuntimeServiceInput,
  type ZelavisMenuFixedActionScope,
  type ZelavisServerRoute,
  type ZelavisRuntimeService,
  type ZelavisRuntimeServiceMenuDefinition,
} from "./contracts.js";

export const ZELAVIS_SERVICE_V1 = "ZELAVIS_SERVICE_V1" as const;
export type ZelavisServiceContractVersion = typeof ZELAVIS_SERVICE_V1;
const scopedServiceNamePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const menuFixedActionScopes = [
  "local",
  "inherit",
  "replace",
  "clear",
] as const satisfies readonly ZelavisMenuFixedActionScope[];

function isBundleRelativeFilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return (
    !normalized.startsWith("/") &&
    segments.length > 0 &&
    segments.every((segment) => segment !== "." && segment !== "..")
  );
}

export interface ZelavisServiceMenuPageDefinition {
  id: string;
  title?: string;
  /**
   * HTML entry file inside the service dashboard bundle. This follows the
   * browser-extension style: menu items point at concrete files such as
   * `dashboard.html`, `settings.html`, or `options.html`.
   */
  file: string;
  /**
   * Bundle identifier that contains `file`. Defaults to the service app bundle
   * when one is declared, otherwise `"dist"`.
   */
  bundle?: string;
}

export type ZelavisServiceMenuDefinition = Omit<
  ZelavisRuntimeServiceMenuDefinition,
  "items"
> & {
  page?: ZelavisServiceMenuPageDefinition;
  items?: readonly ZelavisServiceMenuDefinition[];
};

export type ZelavisServiceKind =
  | "app"
  | "core"
  | "plugin"
  | "web-app"
  | "website"
  | "dashboard-extension"
  | "provider"
  | "template";

export type ZelavisServiceCapability =
  | "web:app"
  | "web:site"
  | "api:routes"
  | "dashboard:menu"
  | "dashboard:settings"
  | "provider:auth"
  | "provider:database"
  | "provider:payments"
  | (string & {});

export interface ZelavisServiceMarketplaceMetadata {
  title?: string;
  summary?: string;
  description?: string;
  categories?: readonly string[];
  tags?: readonly string[];
}

/**
 * Controls which capabilities are available to this service.
 *
 * - `"system"` — first-party or statically registered services. Can mount on
 *   any dashboard surface (platform, root, core, extensions, settings). Set automatically
 *   when the service is passed directly to `zelavis({ services: [...] })`.
 *
 * - `"extension"` — runtime-installed services (uploaded ZIP, marketplace).
 *   Always mount under the Extensions surface regardless of what `menu.surface`
 *   declares. Enforced by the activation layer, not the definition.
 *
 * Defaults to `"extension"`. The activation layer upgrades this to `"system"`
 * for statically registered entries and forces it back to `"extension"` for
 * any service loaded from the registry store.
 */
export type ZelavisServiceScope = "system" | "extension";

/**
 * Static-asset serving mode for a service app.
 *
 * - `"spa"` falls back to the index document for any unmatched sub-path under
 *   the mount prefix. Suitable for single-page apps that own client-side routing.
 * - `"mpa"` resolves the request path against the bundle filesystem (with
 *   `.html` and `/index.html` lookups). Suitable for static MPAs like Astro,
 *   Hugo, 11ty, or hand-authored HTML.
 */
export type ZelavisServiceAppMode = "spa" | "mpa";

/**
 * Controls how a service app participates in host-bound routing.
 *
 * - `"optional"` — the app can be served from verified domain bindings when
 *   the runtime has them, and otherwise falls back to the shared
 *   `/apps/<service-name>` path for extension services.
 * - `"required"` — extension service activation only synthesizes the app route
 *   when at least one verified domain binding exists for that service or its
 *   project. This is for website/webapp services that should not be exposed on
 *   the shared Zelavis host.
 *
 * Concrete hostnames are runtime activation state, not service metadata.
 */
export type ZelavisServiceAppDomainPolicy = "optional" | "required";

/**
 * Context handed to a dynamic shell renderer.
 *
 * `request` is the incoming `Request`. `path` is the bundle-relative path
 * that was being resolved when the SPA fallback fired (empty string for
 * the mount root). Renderers can use the path to discriminate between
 * application routes and paths they want to reject.
 */
export interface ZelavisServiceAppShellRenderContext {
  request: Request;
  path: string;
}

export interface ZelavisServiceAppShellResult {
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
 * Concrete use case: an app can inject runtime config into the HTML shell
 * before serving. A plain static index document cannot do that.
 *
 * The renderer fully controls the response (status/headers/body), so it
 * can also choose to 404 on specific paths — e.g. don't serve the SPA
 * shell for `api/*` deep links.
 */
export interface ZelavisServiceAppShellDefinition {
  render: (
    context: ZelavisServiceAppShellRenderContext,
  ) => ZelavisServiceAppShellResult | Promise<ZelavisServiceAppShellResult>;
}

/**
 * Declares that a service serves a web application — SPA bundle, static MPA, or
 * server-rendered (future). The activation layer turns this into asset-serving
 * routes on the underlying dispatcher.
 *
 * This is the foundation for embedded customer-built apps and future
 * tenant-domain hosting. Services declare their app shape and domain policy;
 * concrete domains come from verified runtime bindings before activation.
 */
export interface ZelavisServiceAppDefinition {
  /**
   * Path prefix this app is mounted under. Defaults to `"/"` (root).
   * Extension-scoped services have their mount rewritten to
   * `/apps/<service-name>` at activation regardless of what they declare.
   */
  mount?: string;
  /**
   * Host-bound routing policy. Defaults to `"optional"`.
   */
  domainPolicy?: ZelavisServiceAppDomainPolicy;
  /**
   * Logical bundle identifier. The BundleStore resolves this against the
   * service's installed assets — for the default `SharedBundleStore`, it
   * keys into `apps/<service-name>/<bundle>/...`. Defaults to `"dist"`.
   */
  bundle?: string;
  /** Index document for SPA fallback and MPA directory roots. Default `"index.html"`. */
  indexHtml?: string;
  /** Serving mode. Default `"spa"`. */
  mode?: ZelavisServiceAppMode;
  /**
   * Dynamic-shell renderer. See {@link ZelavisServiceAppShellDefinition}.
   * When set, the synthesizer uses `render` for the mount root and for
   * SPA-fallback misses, instead of reading `indexHtml` from the bundle.
   */
  shell?: ZelavisServiceAppShellDefinition;
  /**
   * Dev-server URL to proxy to instead of serving static files. When set and
   * the host is in development mode, the runtime forwards requests to this
   * URL instead of reading from the bundle.
   */
  devUrl?: string;
  /**
   * Mount-relative path prefixes that remain owned by the Zelavis runtime even
   * when `devUrl` is active. Use this for reserved API namespaces under an app
   * mount, such as a dashboard mounted at `/zelavis` with `/zelavis/api/v1`.
   */
  devUrlExcludePaths?: readonly string[];
}

export interface ZelavisServiceDefinition<
  TContext = unknown,
  TService = unknown,
> {
  name: string;
  contractVersion?: ZelavisServiceContractVersion;
  kind?: ZelavisServiceKind;
  capabilities?: readonly ZelavisServiceCapability[];
  marketplace?: ZelavisServiceMarketplaceMetadata;
  /**
   * Controls surface access and other trust-gated capabilities.
   * Set by the registration path — do not rely on this field in service code.
   */
  scope?: ZelavisServiceScope;
  basePath?: string;
  api?: Record<string, readonly ZelavisServerRoute<TService>[]>;
  service?: TService;
  version?: string;
  menu?: ZelavisServiceMenuDefinition;
  /**
   * Declare a hosted web application for this service. See
   * {@link ZelavisServiceAppDefinition}.
   */
  app?: ZelavisServiceAppDefinition;
  /**
   * Child services shown inside this service's nested marketplace instead of
   * the main marketplace. These are service names, not module specifiers.
   */
  childServices?: readonly string[];
  runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[];
  /**
   * Parent service name. Child services are hidden from the main marketplace
   * and may attach only when the parent lists them in `childServices`.
   */
  extends?: string;
  setup?: (
    context: TContext,
  ) =>
    | void
    | ZelavisServiceSetupResult
    | Promise<void | ZelavisServiceSetupResult>;
}

export type ZelavisServiceV1Definition<
  TContext = unknown,
  TService = unknown,
> = ZelavisServiceDefinition<TContext, TService> & {
  contractVersion?: typeof ZELAVIS_SERVICE_V1;
};

export interface ZelavisServiceRegistryEntry<TContext = unknown> {
  service: Readonly<ZelavisServiceDefinition<TContext>>;
  specifier?: string;
  status: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

export type ZelavisServiceCatalogSource = "official" | "community";
export type ZelavisServiceCatalogReviewStatus =
  | "official"
  | "reviewed"
  | "unreviewed"
  | "blocked";

export interface ZelavisServiceCatalogCompatibility {
  zelavis?: string;
  parentService?: string;
  service?: string;
}

export interface ZelavisServiceCatalogLinks {
  homepage?: string;
  repository?: string;
  documentation?: string;
  issues?: string;
}

export interface ZelavisServiceCatalogEntry {
  name: string;
  package: string;
  publisher: string;
  source: ZelavisServiceCatalogSource;
  title?: string;
  summary?: string;
  description?: string;
  version?: string;
  reviewStatus?: ZelavisServiceCatalogReviewStatus;
  verified?: boolean;
  extends?: string;
  compatibility?: ZelavisServiceCatalogCompatibility;
  links?: ZelavisServiceCatalogLinks;
  license?: string;
  tags?: readonly string[];
}

export type ZelavisServiceModule<TContext = unknown> =
  | Readonly<ZelavisServiceDefinition<TContext>>
  | {
      default?: Readonly<ZelavisServiceDefinition<TContext>>;
      service?: Readonly<ZelavisServiceDefinition<TContext>>;
    };

export interface ZelavisServiceLoadOptions {
  importer?: (specifier: string) => Promise<unknown>;
}

export interface ZelavisServiceRegistryModuleEntry {
  specifier: string;
  status?: "installed" | "available";
  source?: "official" | "community";
  order?: number;
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

export interface ZelavisServiceSetupResult {
  runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[];
}

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
  service: Readonly<ZelavisServiceDefinition<ZelavisServiceSetupContext>>;
  registry: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[];
  rootPath: string;
  api: ZelavisServiceSetupApiContext;
  platform: ZelavisServiceSetupPlatformContext;
  core: ZelavisServiceSetupCoreContext;
  children: readonly Readonly<ZelavisServiceDefinition>[];
  runtimeServices: readonly ZelavisAnyRuntimeServiceInput[];
  addService: (service: ZelavisAnyRuntimeServiceInput) => void;
  addServices: (services: readonly ZelavisAnyRuntimeServiceInput[]) => void;
}

function freezeMenu(
  menu: ZelavisServiceMenuDefinition,
): Readonly<ZelavisServiceMenuDefinition> {
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

function validateServiceMenu(
  menu: ZelavisServiceMenuDefinition,
  path = menu.title,
): void {
  // `surface` is allowed in the definition — the activation layer enforces
  // extension-only scoping for runtime-installed services at registration time,
  // not here. System services registered statically may use any surface.
  validateOptionalBoolean(menu.fixed, `Service menu fixed flag for "${path}"`);
  validateOptionalNumber(menu.fixedOrder, `Service menu fixedOrder for "${path}"`);
  validateOptionalMenuFixedActionScope(
    menu.fixedActionScope,
    `Service menu fixedActionScope for "${path}"`,
  );

  if ("page" in menu && menu.page !== undefined) {
    if (!menu.page || typeof menu.page !== "object") {
      throw new TypeError(
        `Service menu page metadata for "${path}" must be an object.`,
      );
    }

    if (!menu.page.id || typeof menu.page.id !== "string") {
      throw new TypeError(
        `Service menu page metadata for "${path}" must include a string id.`,
      );
    }

    if (
      "file" in menu.page &&
      menu.page.file !== undefined &&
      typeof menu.page.file !== "string"
    ) {
      throw new TypeError(
        `Service menu page metadata for "${path}" file must be a string when provided.`,
      );
    }

    if (
      "file" in menu.page &&
      typeof menu.page.file === "string" &&
      !isBundleRelativeFilePath(menu.page.file)
    ) {
      throw new TypeError(
        `Service menu page metadata for "${path}" file must be a bundle-relative path.`,
      );
    }

    if (
      "bundle" in menu.page &&
      menu.page.bundle !== undefined &&
      typeof menu.page.bundle !== "string"
    ) {
      throw new TypeError(
        `Service menu page metadata for "${path}" bundle must be a string when provided.`,
      );
    }

    if (
      "title" in menu.page &&
      menu.page.title !== undefined &&
      typeof menu.page.title !== "string"
    ) {
      throw new TypeError(
        `Service menu page metadata for "${path}" title must be a string when provided.`,
      );
    }

    if (!menu.page.file) {
      throw new TypeError(
        `Service menu page metadata for "${path}" must include a page.file HTML entry.`,
      );
    }
  }

  if ("dynamicItems" in menu && menu.dynamicItems !== undefined) {
    if (!menu.dynamicItems || typeof menu.dynamicItems !== "object") {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" must be an object.`,
      );
    }

    if (
      !menu.dynamicItems.path ||
      typeof menu.dynamicItems.path !== "string"
    ) {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" must include a string path.`,
      );
    }

    if (
      "emptyTitle" in menu.dynamicItems &&
      menu.dynamicItems.emptyTitle !== undefined &&
      typeof menu.dynamicItems.emptyTitle !== "string"
    ) {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" emptyTitle must be a string when provided.`,
      );
    }

    if (
      "emptyPath" in menu.dynamicItems &&
      menu.dynamicItems.emptyPath !== undefined &&
      typeof menu.dynamicItems.emptyPath !== "string"
    ) {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" emptyPath must be a string when provided.`,
      );
    }

    if (
      "emptySearch" in menu.dynamicItems &&
      menu.dynamicItems.emptySearch !== undefined &&
      (!menu.dynamicItems.emptySearch ||
        typeof menu.dynamicItems.emptySearch !== "object" ||
        Array.isArray(menu.dynamicItems.emptySearch))
    ) {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" emptySearch must be an object when provided.`,
      );
    }

    if (menu.dynamicItems.emptySearch) {
      for (const [key, value] of Object.entries(menu.dynamicItems.emptySearch)) {
        if (typeof key !== "string" || (value !== undefined && typeof value !== "string")) {
          throw new TypeError(
            `Service menu dynamicItems metadata for "${path}" emptySearch values must be strings when provided.`,
          );
        }
      }
    }
  }

  menu.items?.forEach((item) => validateServiceMenu(item, `${path} > ${item.title}`));
}

function validateOptionalString(
  value: unknown,
  fieldName: string,
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string when provided.`);
  }
}

function validateOptionalBoolean(
  value: unknown,
  fieldName: string,
): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${fieldName} must be a boolean when provided.`);
  }
}

function validateOptionalNumber(
  value: unknown,
  fieldName: string,
): asserts value is number | undefined {
  if (value !== undefined && typeof value !== "number") {
    throw new TypeError(`${fieldName} must be a number when provided.`);
  }
}

function validateOptionalMenuFixedActionScope(
  value: unknown,
  fieldName: string,
): asserts value is ZelavisMenuFixedActionScope | undefined {
  if (
    value !== undefined &&
    !menuFixedActionScopes.includes(value as ZelavisMenuFixedActionScope)
  ) {
    throw new TypeError(
      `${fieldName} must be "local", "inherit", "replace", or "clear" when provided.`,
    );
  }
}

function validateScopedServiceName(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== "string" || !scopedServiceNamePattern.test(value)) {
    throw new TypeError(
      `${fieldName} must be a scoped package-style name such as "@zelavis/auth" or "@acme/search".`,
    );
  }
}

function freezeCatalogCompatibility(
  compatibility: ZelavisServiceCatalogCompatibility,
): Readonly<ZelavisServiceCatalogCompatibility> {
  validateOptionalString(
    compatibility.zelavis,
    "Service catalog compatibility zelavis",
  );
  validateOptionalString(
    compatibility.parentService,
    "Service catalog compatibility parentService",
  );
  validateOptionalString(
    compatibility.service,
    "Service catalog compatibility service",
  );

  return Object.freeze({ ...compatibility });
}

function freezeCatalogLinks(
  links: ZelavisServiceCatalogLinks,
): Readonly<ZelavisServiceCatalogLinks> {
  validateOptionalString(links.homepage, "Service catalog link homepage");
  validateOptionalString(links.repository, "Service catalog link repository");
  validateOptionalString(links.documentation, "Service catalog link documentation");
  validateOptionalString(links.issues, "Service catalog link issues");

  return Object.freeze({ ...links });
}

function freezeMarketplaceMetadata(
  marketplace: ZelavisServiceMarketplaceMetadata,
): Readonly<ZelavisServiceMarketplaceMetadata> {
  validateOptionalString(marketplace.title, "Service marketplace title");
  validateOptionalString(marketplace.summary, "Service marketplace summary");
  validateOptionalString(
    marketplace.description,
    "Service marketplace description",
  );

  if (
    marketplace.categories !== undefined &&
    !Array.isArray(marketplace.categories)
  ) {
    throw new TypeError("Service marketplace categories must be an array.");
  }

  if (marketplace.tags !== undefined && !Array.isArray(marketplace.tags)) {
    throw new TypeError("Service marketplace tags must be an array.");
  }

  for (const category of marketplace.categories ?? []) {
    if (!category || typeof category !== "string") {
      throw new TypeError("Service marketplace categories must be strings.");
    }
  }

  for (const tag of marketplace.tags ?? []) {
    if (!tag || typeof tag !== "string") {
      throw new TypeError("Service marketplace tags must be strings.");
    }
  }

  return Object.freeze({
    ...marketplace,
    categories: marketplace.categories
      ? Object.freeze([...marketplace.categories])
      : marketplace.categories,
    tags: marketplace.tags ? Object.freeze([...marketplace.tags]) : marketplace.tags,
  });
}

function freezeChildServices(
  childServices: readonly string[],
): readonly string[] {
  if (!Array.isArray(childServices)) {
    throw new TypeError("Service childServices must be provided as an array.");
  }

  const seen = new Set<string>();

  for (const childService of childServices) {
    validateScopedServiceName(childService, "Service childServices entry");

    if (seen.has(childService)) {
      throw new TypeError(
        `Service childServices must use unique names. Duplicate: ${childService}`,
      );
    }

    seen.add(childService);
  }

  return Object.freeze([...childServices]);
}

function validateServiceApp(app: ZelavisServiceAppDefinition): void {
  if (!app || typeof app !== "object") {
    throw new TypeError("Service app metadata must be an object.");
  }

  if (
    "mount" in app &&
    app.mount !== undefined &&
    typeof app.mount !== "string"
  ) {
    throw new TypeError("Service app mount must be a string when provided.");
  }

  if (app.mount !== undefined && !app.mount.startsWith("/")) {
    throw new TypeError("Service app mount must start with a leading slash.");
  }

  if ("domainPolicy" in app && app.domainPolicy !== undefined) {
    if (
      app.domainPolicy !== "optional" &&
      app.domainPolicy !== "required"
    ) {
      throw new TypeError(
        'Service app domainPolicy must be "optional" or "required".',
      );
    }
  }

  if (
    "bundle" in app &&
    app.bundle !== undefined &&
    typeof app.bundle !== "string"
  ) {
    throw new TypeError("Service app bundle must be a string when provided.");
  }

  if (
    "indexHtml" in app &&
    app.indexHtml !== undefined &&
    typeof app.indexHtml !== "string"
  ) {
    throw new TypeError(
      "Service app indexHtml must be a string when provided.",
    );
  }

  if ("mode" in app && app.mode !== undefined) {
    if (app.mode !== "spa" && app.mode !== "mpa") {
      throw new TypeError('Service app mode must be "spa" or "mpa".');
    }
  }

  if ("shell" in app && app.shell !== undefined) {
    if (!app.shell || typeof app.shell !== "object") {
      throw new TypeError("Service app shell must be an object when provided.");
    }
    if (typeof app.shell.render !== "function") {
      throw new TypeError("Service app shell.render must be a function.");
    }
  }

  if (
    "devUrl" in app &&
    app.devUrl !== undefined &&
    typeof app.devUrl !== "string"
  ) {
    throw new TypeError("Service app devUrl must be a string when provided.");
  }

  if ("devUrlExcludePaths" in app && app.devUrlExcludePaths !== undefined) {
    if (!Array.isArray(app.devUrlExcludePaths)) {
      throw new TypeError(
        "Service app devUrlExcludePaths must be an array when provided.",
      );
    }
    for (const path of app.devUrlExcludePaths) {
      if (typeof path !== "string") {
        throw new TypeError(
          "Service app devUrlExcludePaths entries must be strings.",
        );
      }
    }
  }
}

function freezeServiceApp(
  app: ZelavisServiceAppDefinition,
): Readonly<ZelavisServiceAppDefinition> {
  return Object.freeze({
    mount: app.mount,
    domainPolicy: app.domainPolicy,
    bundle: app.bundle,
    indexHtml: app.indexHtml,
    mode: app.mode,
    shell: app.shell ? Object.freeze({ render: app.shell.render }) : app.shell,
    devUrl: app.devUrl,
    devUrlExcludePaths: app.devUrlExcludePaths
      ? Object.freeze([...app.devUrlExcludePaths])
      : app.devUrlExcludePaths,
  });
}

export function isChildServiceAllowed(
  parent: Readonly<ZelavisServiceRegistryEntry<any>>,
  child: Readonly<ZelavisServiceRegistryEntry<any>>,
): boolean {
  if (child.service.extends !== parent.service.name) {
    return false;
  }

  return parent.service.childServices?.includes(child.service.name) ?? false;
}

export function defineServiceCatalogEntry(
  entry: ZelavisServiceCatalogEntry,
): Readonly<ZelavisServiceCatalogEntry> {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("A service catalog entry object is required.");
  }

  if (!entry.name || typeof entry.name !== "string") {
    throw new TypeError("A service catalog entry must include a string name.");
  }
  validateScopedServiceName(entry.name, "Service catalog entry name");

  if (!entry.package || typeof entry.package !== "string") {
    throw new TypeError("A service catalog entry must include a string package.");
  }

  if (!entry.publisher || typeof entry.publisher !== "string") {
    throw new TypeError("A service catalog entry must include a string publisher.");
  }

  if (entry.source !== "official" && entry.source !== "community") {
    throw new TypeError(
      'A service catalog entry source must be "official" or "community".',
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
      'A service catalog entry reviewStatus must be "official", "reviewed", "unreviewed", or "blocked".',
    );
  }

  validateOptionalString(entry.title, "Service catalog entry title");
  validateOptionalString(entry.summary, "Service catalog entry summary");
  validateOptionalString(entry.description, "Service catalog entry description");
  validateOptionalString(entry.version, "Service catalog entry version");
  validateOptionalString(entry.license, "Service catalog entry license");

  if (entry.verified !== undefined && typeof entry.verified !== "boolean") {
    throw new TypeError(
      "A service catalog entry verified field must be boolean when provided.",
    );
  }

  if (entry.extends !== undefined) {
    validateScopedServiceName(entry.extends, "Service catalog entry extends");
  }

  if (entry.compatibility !== undefined) {
    if (!entry.compatibility || typeof entry.compatibility !== "object") {
      throw new TypeError(
        "A service catalog entry compatibility field must be an object.",
      );
    }
  }

  if (entry.links !== undefined) {
    if (!entry.links || typeof entry.links !== "object") {
      throw new TypeError("A service catalog entry links field must be an object.");
    }
  }

  if (entry.tags !== undefined && !Array.isArray(entry.tags)) {
    throw new TypeError("A service catalog entry tags field must be an array.");
  }

  for (const tag of entry.tags ?? []) {
    if (!tag || typeof tag !== "string") {
      throw new TypeError("A service catalog entry tags must be strings.");
    }
  }

  return Object.freeze({
    ...entry,
    reviewStatus:
      entry.reviewStatus ??
      (entry.source === "official" ? "official" : "unreviewed"),
    verified: entry.verified ?? (entry.source === "official"),
    extends: entry.extends,
    compatibility: entry.compatibility
      ? freezeCatalogCompatibility(entry.compatibility)
      : entry.compatibility,
    links: entry.links ? freezeCatalogLinks(entry.links) : entry.links,
    tags: entry.tags ? Object.freeze([...entry.tags]) : entry.tags,
  });
}

export function defineServiceCatalog(
  entries: readonly ZelavisServiceCatalogEntry[],
): readonly Readonly<ZelavisServiceCatalogEntry>[] {
  if (!Array.isArray(entries)) {
    throw new TypeError("A service catalog must be an array.");
  }

  const seen = new Set<string>();

  return Object.freeze(
    entries.map((entry) => {
      const normalized = defineServiceCatalogEntry(entry);

      if (seen.has(normalized.name)) {
        throw new TypeError(
          `Service catalog entries must use unique names. Duplicate: ${normalized.name}`,
        );
      }

      seen.add(normalized.name);

      return normalized;
    }),
  );
}

export function defineService<TContext = unknown, TService = unknown>(
  definition: ZelavisServiceV1Definition<TContext, TService>,
): Readonly<
  ZelavisRuntimeService<TService> & ZelavisServiceDefinition<TContext, TService>
> {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("A service definition object is required.");
  }

  if (!definition.name || typeof definition.name !== "string") {
    throw new TypeError("A service must include a string name.");
  }
  validateScopedServiceName(definition.name, "Service name");

  if (
    "contractVersion" in definition &&
    definition.contractVersion !== undefined &&
    definition.contractVersion !== ZELAVIS_SERVICE_V1
  ) {
    throw new TypeError(
      `Unsupported service contract version. Expected ${ZELAVIS_SERVICE_V1}.`,
    );
  }

  if (
    "version" in definition &&
    definition.version !== undefined &&
    typeof definition.version !== "string"
  ) {
    throw new TypeError("A service version must be a string when provided.");
  }

  if ("kind" in definition && definition.kind !== undefined) {
    const allowedKinds: readonly ZelavisServiceKind[] = [
      "app",
      "core",
      "plugin",
      "web-app",
      "website",
      "dashboard-extension",
      "provider",
      "template",
    ];
    if (!allowedKinds.includes(definition.kind)) {
      throw new TypeError(
        'Service kind must be "app", "core", "plugin", "web-app", "website", "dashboard-extension", "provider", or "template".',
      );
    }
  }

  if (
    "capabilities" in definition &&
    definition.capabilities !== undefined
  ) {
    if (!Array.isArray(definition.capabilities)) {
      throw new TypeError("Service capabilities must be provided as an array.");
    }
    for (const capability of definition.capabilities) {
      if (!capability || typeof capability !== "string") {
        throw new TypeError("Service capabilities must be string values.");
      }
    }
  }

  if ("marketplace" in definition && definition.marketplace !== undefined) {
    if (!definition.marketplace || typeof definition.marketplace !== "object") {
      throw new TypeError("Service marketplace metadata must be an object.");
    }
  }

  if (definition.menu !== undefined) {
    if (!definition.menu || typeof definition.menu !== "object") {
      throw new TypeError("Service menu metadata must be an object.");
    }

    if (
      !definition.menu.title ||
      typeof definition.menu.title !== "string"
    ) {
      throw new TypeError("Service menu metadata must include a string title.");
    }

    if (
      "path" in definition.menu &&
      definition.menu.path !== undefined &&
      typeof definition.menu.path !== "string"
    ) {
      throw new TypeError(
        "Service menu metadata path must be a string when provided.",
      );
    }

    if (
      definition.menu.path === undefined &&
      (!definition.menu.items || definition.menu.items.length === 0)
    ) {
      throw new TypeError(
        "Service menu metadata must include a path or nested items.",
      );
    }

    validateServiceMenu(definition.menu);
  }

  if (
    "setup" in definition &&
    definition.setup !== undefined &&
    typeof definition.setup !== "function"
  ) {
    throw new TypeError("A service setup field must be a function.");
  }

  if ("childServices" in definition && definition.childServices !== undefined) {
    freezeChildServices(definition.childServices);
  }

  if (
    "runtimeServices" in definition &&
    definition.runtimeServices !== undefined &&
    !Array.isArray(definition.runtimeServices)
  ) {
    throw new TypeError("Service runtimeServices must be provided as an array.");
  }

  if ("extends" in definition && definition.extends !== undefined) {
    validateScopedServiceName(definition.extends, "Service extends");

    if (definition.menu !== undefined) {
      throw new TypeError(
        "Child services cannot declare top-level dashboard menu metadata.",
      );
    }
  }

  if ("app" in definition && definition.app !== undefined) {
    validateServiceApp(definition.app);
  }

  const normalized = {
    name: definition.name,
    basePath: definition.basePath,
    api: definition.api ?? {},
    service: definition.service as unknown,
    menu: definition.menu ? freezeMenu(definition.menu) : definition.menu,
    runtimeServices: definition.runtimeServices
      ? Object.freeze([...definition.runtimeServices])
      : definition.runtimeServices,
  } as ZelavisRuntimeService<TService> & ZelavisServiceDefinition<
    TContext,
    TService
  >;

  return Object.freeze({
    ...normalized,
    contractVersion: ZELAVIS_SERVICE_V1,
    // Default to "extension". The registration path (static vs. uploaded)
    // overrides this — see loadStoredServiceRegistryModules in index.ts.
    scope: definition.scope ?? "extension",
    kind: definition.kind,
    capabilities: definition.capabilities
      ? Object.freeze([...definition.capabilities])
      : definition.capabilities,
    marketplace: definition.marketplace
      ? freezeMarketplaceMetadata(definition.marketplace)
      : definition.marketplace,
    childServices: definition.childServices
      ? freezeChildServices(definition.childServices)
      : definition.childServices,
    version: definition.version,
    app: definition.app ? freezeServiceApp(definition.app) : definition.app,
    extends: definition.extends,
    setup: definition.setup,
  });
}
