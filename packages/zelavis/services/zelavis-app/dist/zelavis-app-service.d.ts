import { type AuthServiceOptions } from "./auth/index.js";
import { type CreateDatabaseOptions, type DatabaseApi } from "./db/index.js";
import { type ZelavisServiceSetupContext } from "./server/index.js";
import { type WorkloadsServiceOptions } from "./workloads/index.js";
export interface ZelavisAppServiceOptions {
    database?: CreateDatabaseOptions | DatabaseApi;
    auth?: false | AuthServiceOptions;
    workloads?: false | WorkloadsServiceOptions;
}
export declare function zelavisAppService(options?: ZelavisAppServiceOptions): Readonly<import("./server/contracts.js").ZelavisRuntimeService<unknown> & import("./server/service.js").ZelavisServiceDefinition<ZelavisServiceSetupContext, unknown>>;
export declare const zelavisApp: Readonly<import("./server/contracts.js").ZelavisRuntimeService<unknown> & import("./server/service.js").ZelavisServiceDefinition<ZelavisServiceSetupContext, unknown>>;
export default zelavisApp;
