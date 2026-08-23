import { type ZelavisServiceDefinition, type ZelavisRuntimeService } from "../server/index.js";
import type { AuthApi, AuthProviderService } from "./core/types.js";
import { type CreateAuthOptions } from "./core/create-auth.js";
export type AuthServiceDefinition = Readonly<ZelavisRuntimeService<AuthApi> & ZelavisServiceDefinition<AuthApi, AuthApi>>;
export interface DefineAuthServiceOptions {
    childServices?: readonly string[];
}
export declare function defineAuthService(auth: AuthApi, options?: DefineAuthServiceOptions): AuthServiceDefinition;
export interface AuthServiceOptions {
    auth?: AuthApi;
    authOptions?: CreateAuthOptions;
    childServices?: readonly string[];
    services?: readonly AuthProviderService[];
}
export declare function authService(options?: AuthServiceOptions): Promise<AuthServiceDefinition>;
