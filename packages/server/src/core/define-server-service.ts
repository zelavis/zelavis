import type { ZelavisServerService } from "../contracts.js";

export function defineServerService<TService>(
  definition: ZelavisServerService<TService>,
): ZelavisServerService<TService> {
  return definition;
}
