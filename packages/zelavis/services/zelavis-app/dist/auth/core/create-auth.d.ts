import type { AuthRepositories } from "../contracts/repositories.js";
import type { AuthApi, AuthProviderService } from "./types.js";
export interface CreateAuthOptions {
    config?: Record<string, unknown>;
    services?: readonly AuthProviderService[];
    repositories?: Partial<AuthRepositories>;
}
export declare function createAuth(options?: CreateAuthOptions): Promise<AuthApi>;
