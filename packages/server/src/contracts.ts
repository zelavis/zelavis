export type ZelavisHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ZelavisMenuFixedActionScope =
  | "local"
  | "inherit"
  | "replace"
  | "clear";

export type ZelavisPrincipalType =
  | "anonymous"
  | "user"
  | "service"
  | "system";

export type ZelavisAccessScope =
  | {
      type: "system";
    }
  | {
      type: "project";
      projectId?: string;
      projectIdParam?: string;
    }
  | {
      type: "service";
      serviceName?: string;
      serviceNameParam?: string;
    };

export interface ZelavisPrincipalGrant {
  permission: string;
  scope?: ZelavisAccessScope;
}

export interface ZelavisPrincipal {
  id: string;
  type: ZelavisPrincipalType;
  roles?: readonly string[];
  permissions?: readonly string[];
  grants?: readonly ZelavisPrincipalGrant[];
  metadata?: Record<string, unknown>;
}

export interface ZelavisAccessRequirement {
  /**
   * Require a non-anonymous principal before role or permission checks run.
   */
  authenticated?: boolean;
  roles?: readonly string[];
  permissions?: readonly string[];
  scope?: ZelavisAccessScope;
}

export interface ZelavisAccessDecision {
  allowed: boolean;
  status?: 401 | 403;
  reason?: string;
}

export interface ZelavisAccessResolveContext<TService = unknown> {
  request: Request;
  platform?: unknown;
  resolvedRoute: ZelavisResolvedRoute<TService>;
  params: Record<string, string>;
}

export interface ZelavisAccessAuthorizeContext<TService = unknown>
  extends ZelavisAccessResolveContext<TService> {
  principal?: ZelavisPrincipal;
  requirement: ZelavisAccessRequirement;
}

export type ZelavisPrincipalResolver<TService = unknown> = (
  context: ZelavisAccessResolveContext<TService>,
) => ZelavisPrincipal | undefined | Promise<ZelavisPrincipal | undefined>;

export type ZelavisAuthorizer<TService = unknown> = (
  context: ZelavisAccessAuthorizeContext<TService>,
) =>
  | boolean
  | ZelavisAccessDecision
  | Promise<boolean | ZelavisAccessDecision>;

export interface ZelavisRouteContext<TService = unknown> {
  service: TService;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string | undefined>;
  requestHeaders: Headers;
  request: Request;
  principal?: ZelavisPrincipal;
  platform?: unknown;
}

export interface ZelavisRouteResponse {
  status?: number;
  body?: unknown;
  headers?: HeadersInit;
}

/**
 * Hosts a route is willing to serve. A string is treated as a single exact
 * hostname; an array as the set of acceptable hostnames; `"*"` (the default
 * when omitted) means host-agnostic.
 *
 * This is the route-level half of the (host, path) two-pass matching the
 * dispatcher does. It exists primarily for service `app` mounts that want
 * to bind to a tenant domain.
 */
export type ZelavisRouteHostMatcher = string | readonly string[];

export interface ZelavisServerRoute<TService = unknown> {
  id: string;
  method: ZelavisHttpMethod;
  path: string;
  /**
   * Restrict this route to specific hostnames. Omit (or pass `"*"`) for
   * host-agnostic routes — the dispatcher will match regardless of host.
   */
  host?: ZelavisRouteHostMatcher;
  access?: ZelavisAccessRequirement | readonly ZelavisAccessRequirement[];
  meta?: Record<string, unknown>;
  handler: (
    context: ZelavisRouteContext<TService>,
  ) => Promise<ZelavisRouteResponse> | ZelavisRouteResponse;
}

export interface ZelavisRuntimeServiceMenuDefinition {
  title: string;
  path?: string;
  pageLabel?: string;
  panelLabel?: string;
  search?: Record<string, string | undefined>;
  /**
   * Render this item in the panel's fixed action area instead of the normal
   * scrollable menu list. Use for primary actions such as "Add Function".
   */
  fixed?: boolean;
  /**
   * Sort order for fixed actions. Lower numbers appear first; items with the
   * same order fall back to title sorting in the dashboard.
   */
  fixedOrder?: number;
  /**
   * Controls which fixed actions are visible when this item opens a nested
   * sidebar panel. The default is "local": only fixed actions declared inside
   * the opened panel are shown. "inherit" combines the parent panel's visible
   * fixed actions with the opened panel's local fixed actions. "replace" uses
   * only the opened panel's local fixed actions as an explicit boundary. "clear"
   * hides inherited and local fixed actions for the opened panel.
   */
  fixedActionScope?: ZelavisMenuFixedActionScope;
  sectionLabel?: string;
  disabled?: boolean;
  access?: ZelavisAccessRequirement | readonly ZelavisAccessRequirement[];
  /**
   * Dashboard area where this menu should render.
   *
   * - platform: global `/zelavis` owner/operator shell
   * - root: first slide of a Zelavis-native project dashboard
   * - core: Backend slide of a Zelavis-native project dashboard
   * - extensions: Extensions slide of a Zelavis-native project dashboard
   * - settings: Settings slide of a Zelavis-native project dashboard
   */
  surface?: "platform" | "root" | "core" | "extensions" | "settings";
  dynamicItems?: {
    path: string;
    emptyTitle?: string;
    emptyPath?: string;
    emptySearch?: Record<string, string | undefined>;
  };
  items?: readonly ZelavisRuntimeServiceMenuDefinition[];
}

export interface ZelavisRuntimeServiceDynamicMenuResponse {
  items: readonly ZelavisRuntimeServiceMenuDefinition[];
}

export interface ZelavisRuntimeService<TService = unknown> {
  name: string;
  basePath?: string;
  api: Record<string, readonly ZelavisServerRoute<TService>[]>;
  service: TService;
  menu?: ZelavisRuntimeServiceMenuDefinition;
  services?: readonly ZelavisAnyRuntimeServiceInput[];
}

export type ZelavisRuntimeServiceInput<TService = unknown> =
  | ZelavisRuntimeService<TService>
  | Promise<ZelavisRuntimeService<TService>>;

export type ZelavisAnyRuntimeServiceInput =
  | ZelavisRuntimeService<any>
  | Promise<ZelavisRuntimeService<any>>;

export interface ZelavisResolvedRoute<TService = unknown> {
  service: ZelavisRuntimeService<TService>;
  route: ZelavisServerRoute<TService>;
  fullPath: string;
}

export interface ZelavisServerErrorContext<TService = unknown> {
  error: unknown;
  resolvedRoute: ZelavisResolvedRoute<TService>;
}

export type ZelavisServerErrorHandler<TService = unknown> = (
  context: ZelavisServerErrorContext<TService>,
) => ZelavisRouteResponse;

export interface ZelavisServerMountOptions<TService = unknown> {
  prefix?: string;
  version?: string;
  servicePrefixes?: Record<string, string>;
  pathOverrides?: Record<string, string>;
  resolvePrincipal?: ZelavisPrincipalResolver<TService>;
  authorize?: ZelavisAuthorizer<TService>;
  onError?: ZelavisServerErrorHandler<TService>;
}

export interface ZelavisServerExecutionContext {
  principal?: ZelavisPrincipal;
  platform?: unknown;
}

export interface ZelavisServerDispatchResult<TService = unknown> {
  matched: boolean;
  response: Response;
  resolvedRoute?: ZelavisResolvedRoute<TService>;
}

export type ZelavisServerDispatchHandler<TService = unknown> = (
  request: Request,
  context?: ZelavisServerExecutionContext,
) => Promise<ZelavisServerDispatchResult<TService>>;

export type ZelavisServerFetchHandler<TService = unknown> = (
  request: Request,
  context?: ZelavisServerExecutionContext,
) => Promise<Response>;

export interface ZelavisPlainRequest {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  baseUrl?: string;
  request?: Request;
  principal?: ZelavisPrincipal;
  platform?: unknown;
}

export interface ZelavisPlainResponse<TService = unknown> {
  matched: boolean;
  status: number;
  headers: Record<string, string>;
  headerEntries: readonly [string, string][];
  responseHeaders: Headers;
  body: unknown;
  response: Response;
  resolvedRoute?: ZelavisResolvedRoute<TService>;
}

export type ZelavisServerPlainHandler<TService = unknown> = (
  request: ZelavisPlainRequest,
) => Promise<ZelavisPlainResponse<TService>>;

export interface ZelavisServerOptions<
  TService = unknown,
> extends ZelavisServerMountOptions<TService> {
  services: readonly ZelavisAnyRuntimeServiceInput[];
}

export interface ZelavisServerRuntime<TService = unknown> {
  services: Record<string, ZelavisRuntimeService<any>>;
  routes: readonly ZelavisResolvedRoute<TService>[];
  dispatch: ZelavisServerDispatchHandler<TService>;
  fetch: ZelavisServerFetchHandler<TService>;
  plain: ZelavisServerPlainHandler<TService>;
}
