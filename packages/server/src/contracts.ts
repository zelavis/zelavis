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

export interface ZelavisServerRoute<TService = unknown> {
  id: string;
  method: ZelavisHttpMethod;
  path: string;
  meta?: Record<string, unknown>;
  handler: (
    context: ZelavisRouteContext<TService>,
  ) => Promise<ZelavisRouteResponse> | ZelavisRouteResponse;
}

export interface ZelavisServerServiceMenuDefinition {
  title: string;
  path?: string;
  pageLabel?: string;
  panelLabel?: string;
  surface?: "root" | "core" | "workspace" | "settings";
  items?: readonly ZelavisServerServiceMenuDefinition[];
}

export interface ZelavisServerService<TService = unknown> {
  name: string;
  basePath?: string;
  api: Record<string, readonly ZelavisServerRoute<TService>[]>;
  service: TService;
  menu?: ZelavisServerServiceMenuDefinition;
  services?: readonly ZelavisAnyServiceInput[];
}

export type ZelavisServiceInput<TService = unknown> =
  | ZelavisServerService<TService>
  | Promise<ZelavisServerService<TService>>;

export type ZelavisAnyServiceInput =
  | ZelavisServerService<any>
  | Promise<ZelavisServerService<any>>;

export interface ZelavisResolvedRoute<TService = unknown> {
  service: ZelavisServerService<TService>;
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
  services: readonly ZelavisAnyServiceInput[];
}

export interface ZelavisServerRuntime<TService = unknown> {
  services: Record<string, ZelavisServerService<any>>;
  routes: readonly ZelavisResolvedRoute<TService>[];
  dispatch: ZelavisServerDispatchHandler<TService>;
  fetch: ZelavisServerFetchHandler<TService>;
  plain: ZelavisServerPlainHandler<TService>;
}
