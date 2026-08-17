export type ZelavisHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ZelavisRouteContext<TService = unknown> {
  service: TService;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string | undefined>;
  requestHeaders: Headers;
  request: Request;
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
  fixed?: boolean;
  fixedOrder?: number;
  sectionLabel?: string;
  surface?: "root" | "core" | "extensions" | "settings";
  items?: readonly ZelavisRuntimeServiceMenuDefinition[];
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
  onError?: ZelavisServerErrorHandler<TService>;
}

export interface ZelavisServerExecutionContext {
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
