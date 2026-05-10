import type { ZelavisService } from "../contracts.js";

export function defineService<TService>(
  definition: ZelavisService<TService>,
): ZelavisService<TService> {
  return definition;
}
