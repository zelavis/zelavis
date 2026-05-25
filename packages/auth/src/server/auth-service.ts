import type { CreateAuthOptions } from "../core/create-auth.js";
import { createAuth } from "../core/create-auth.js";
import type { AuthApi } from "../core/types.js";
import {
  defineAuthService,
  type AuthServiceDefinition,
} from "../auth-service.js";
import type { AuthProviderService } from "../core/types.js";

export interface AuthServiceOptions {
  auth?: AuthApi;
  authOptions?: CreateAuthOptions;
  childServices?: readonly string[];
  services?: readonly AuthProviderService[];
}

export async function authService(options: AuthServiceOptions = {}): Promise<AuthServiceDefinition> {
  const auth =
    options.auth ??
    (await createAuth({
      ...(options.authOptions ?? {}),
      services: [
        ...(options.authOptions?.services ?? []),
        ...(options.services ?? []),
      ],
    }));

  return defineAuthService(auth, {
    childServices: options.childServices,
  });
}
