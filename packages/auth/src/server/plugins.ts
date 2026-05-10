import type { AuthServiceDefinition } from "../auth-service.js";

export type AuthServicePlugin =
  | ((service: AuthServiceDefinition) => AuthServiceDefinition)
  | ((service: AuthServiceDefinition) => Promise<AuthServiceDefinition>);
