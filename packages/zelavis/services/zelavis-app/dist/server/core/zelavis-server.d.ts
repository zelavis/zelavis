import type { ZelavisServerOptions, ZelavisServerRuntime } from "../contracts.js";
export declare function zelavisServer<TService = unknown>(options: ZelavisServerOptions<TService>): Promise<ZelavisServerRuntime<TService>>;
