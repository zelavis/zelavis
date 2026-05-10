import type { CreateAuthOptions } from "../core/create-auth.js";
import { createAuth } from "../core/create-auth.js";
import type { AuthApi } from "../core/types.js";
import {
  defineAuthService,
  type AuthServiceDefinition,
} from "../auth-service.js";
import type { AuthServicePlugin } from "./plugins.js";

export interface AuthServiceOptions {
  auth?: AuthApi;
  authOptions?: CreateAuthOptions;
  plugins?: AuthServicePlugin[];
}

export async function authService(options: AuthServiceOptions = {}): Promise<AuthServiceDefinition> {
  const auth = options.auth ?? (await createAuth(options.authOptions));
  let service = defineAuthService(auth);

  for (const plugin of options.plugins ?? []) {
    service = await plugin(service);
  }

  return service;
}
