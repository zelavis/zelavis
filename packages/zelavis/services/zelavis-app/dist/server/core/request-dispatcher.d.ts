import type { ZelavisPlainRequest, ZelavisResolvedRoute, ZelavisRouteResponse, ZelavisServerDispatchHandler, ZelavisServerFetchHandler, ZelavisServerMountOptions, ZelavisServerPlainHandler } from "../contracts.js";
export declare function toResponseHeaderEntries(headers: Headers): Array<[string, string]>;
export declare function toResponse(payload: ZelavisRouteResponse): Response;
export declare function createZelavisDispatcher<TService = unknown>(routes: readonly ZelavisResolvedRoute<TService>[], options?: Pick<ZelavisServerMountOptions<TService>, "authorize" | "onError" | "resolvePrincipal">): ZelavisServerDispatchHandler<TService>;
export declare function createZelavisFetchHandler<TService = unknown>(dispatch: ZelavisServerDispatchHandler<TService>): ZelavisServerFetchHandler<TService>;
export declare function createRequestFromPlainInput(input: ZelavisPlainRequest): Request;
export declare function createZelavisPlainHandler<TService = unknown>(dispatch: ZelavisServerDispatchHandler<TService>): ZelavisServerPlainHandler<TService>;
