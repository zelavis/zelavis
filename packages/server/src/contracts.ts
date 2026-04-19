export type ZelavisHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ZelavisRouteContext<TService = unknown> {
  service: TService;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string | undefined>;
  request: unknown;
}

export interface ZelavisRouteResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
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

export interface ZelavisServerService<TService = unknown> {
  name: string;
  basePath?: string;
  api: Record<string, readonly ZelavisServerRoute<TService>[]>;
  service: TService;
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

export interface ZelavisServerIntegration<TService = unknown, TResult = unknown> {
  mount: (
    routes: readonly ZelavisResolvedRoute<TService>[],
    options?: Pick<ZelavisServerMountOptions<TService>, "onError">,
  ) => TResult;
}

export interface ZelavisServerOptions<TService = unknown, TResult = unknown>
  extends ZelavisServerMountOptions<TService> {
  services: readonly ZelavisAnyServiceInput[];
  integration: ZelavisServerIntegration<TService, TResult>;
}

export interface ZelavisServerRuntime<TService = unknown, TResult = unknown> {
  services: Record<string, ZelavisServerService<any>>;
  server: TResult;
}
