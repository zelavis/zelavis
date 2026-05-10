import type { ZelavisServerService } from "../contracts.js";

export function defineService<TService>(
  definition: ZelavisServerService<TService>,
): ZelavisServerService<TService> {
  return definition;
}
