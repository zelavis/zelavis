import { type AuthServiceOptions } from "@zelavis/auth";
import { type CreateDatabaseOptions, type DatabaseApi } from "@zelavis/db";
import { type ZelavisServiceSetupContext } from "@zelavis/server";
import { type WorkloadsServiceOptions } from "@zelavis/workloads";
export interface ZelavisAppServiceOptions {
    database?: CreateDatabaseOptions | DatabaseApi;
    auth?: false | AuthServiceOptions;
    workloads?: false | WorkloadsServiceOptions;
}
export declare function zelavisAppService(options?: ZelavisAppServiceOptions): Readonly<import("@zelavis/server").ZelavisRuntimeService<unknown> & import("@zelavis/server").ZelavisServiceDefinition<ZelavisServiceSetupContext, unknown>>;
export declare const zelavisApp: Readonly<import("@zelavis/server").ZelavisRuntimeService<unknown> & import("@zelavis/server").ZelavisServiceDefinition<ZelavisServiceSetupContext, unknown>>;
export default zelavisApp;
