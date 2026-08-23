import { type ZelavisAnyRuntimeServiceInput, type ZelavisServerRoute, type ZelavisRuntimeService, type ZelavisRuntimeServiceMenuDefinition } from "./contracts.js";
export declare const ZELAVIS_SERVICE_V1: "ZELAVIS_SERVICE_V1";
export type ZelavisServiceContractVersion = typeof ZELAVIS_SERVICE_V1;
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
export type ZelavisServiceMenuDefinition = Omit<ZelavisRuntimeServiceMenuDefinition, "items"> & {
    page?: ZelavisServiceMenuPageDefinition;
    items?: readonly ZelavisServiceMenuDefinition[];
};
export type ZelavisServiceKind = "app" | "plugin" | "web-app" | "website" | "dashboard-extension" | "provider" | "template";
export type ZelavisServiceCapability = "web:app" | "web:site" | "api:routes" | "dashboard:menu" | "dashboard:settings" | "provider:auth" | "provider:database" | "provider:payments" | (string & {});
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
    render: (context: ZelavisServiceAppShellRenderContext) => ZelavisServiceAppShellResult | Promise<ZelavisServiceAppShellResult>;
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
export interface ZelavisServiceDefinition<TContext = unknown, TService = unknown> {
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
    setup?: (context: TContext) => void | ZelavisServiceSetupResult | Promise<void | ZelavisServiceSetupResult>;
}
export type ZelavisServiceV1Definition<TContext = unknown, TService = unknown> = ZelavisServiceDefinition<TContext, TService> & {
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
export type ZelavisServiceCatalogReviewStatus = "official" | "reviewed" | "unreviewed" | "blocked";
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
export type ZelavisServiceModule<TContext = unknown> = Readonly<ZelavisServiceDefinition<TContext>> | {
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
    read: (() => Promise<readonly ZelavisServiceRegistryStateEntry[] | undefined> | readonly ZelavisServiceRegistryStateEntry[] | undefined) | (() => Promise<readonly ZelavisServiceRegistryStateEntry[] | undefined>);
    write: (entries: readonly ZelavisServiceRegistryStateEntry[]) => Promise<readonly ZelavisServiceRegistryStateEntry[]> | readonly ZelavisServiceRegistryStateEntry[];
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
export declare function isChildServiceAllowed(parent: Readonly<ZelavisServiceRegistryEntry<any>>, child: Readonly<ZelavisServiceRegistryEntry<any>>): boolean;
export declare function defineServiceCatalogEntry(entry: ZelavisServiceCatalogEntry): Readonly<ZelavisServiceCatalogEntry>;
export declare function defineServiceCatalog(entries: readonly ZelavisServiceCatalogEntry[]): readonly Readonly<ZelavisServiceCatalogEntry>[];
export declare function defineService<TContext = unknown, TService = unknown>(definition: ZelavisServiceV1Definition<TContext, TService>): Readonly<ZelavisRuntimeService<TService> & ZelavisServiceDefinition<TContext, TService>>;
