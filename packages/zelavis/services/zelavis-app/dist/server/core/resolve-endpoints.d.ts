import type { ZelavisResolvedRoute, ZelavisServerMountOptions, ZelavisRuntimeService } from "../contracts.js";
export declare function resolveMountedEndpoints<TContext = unknown>(services: readonly ZelavisRuntimeService<TContext>[], options?: Pick<ZelavisServerMountOptions<TContext>, "prefix" | "version" | "servicePrefixes" | "pathOverrides">): ZelavisResolvedRoute<TContext>[];
