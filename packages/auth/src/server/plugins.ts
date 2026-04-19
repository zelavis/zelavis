import type { ZelavisServerService } from "@zelavis/server";
import type { AuthApi } from "../core/types.js";

export type AuthServerService = ZelavisServerService<AuthApi>;

export type AuthServicePlugin =
  | ((service: AuthServerService) => AuthServerService)
  | ((service: AuthServerService) => Promise<AuthServerService>);
