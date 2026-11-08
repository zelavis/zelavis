import type {
  ZelavisEndpointGroup,
  ZelavisServerRoute,
} from "../core/index.js";
import type { ZelavisRequestAuthenticator } from "../core/runtime/authentication.js";

export interface ZelavisPlatformEndpointOptions<TContext> {
  readonly context: TContext;
  readonly routes: readonly ZelavisServerRoute<TContext>[];
  /** Credentials the control plane itself recognizes, beside the runtime's own. */
  readonly authenticators?: readonly ZelavisRequestAuthenticator[];
}

/** Native Server Control Plane endpoints. This is not a loadable service. */
export function createPlatformEndpointGroup<TContext>(
  options: ZelavisPlatformEndpointOptions<TContext>,
): ZelavisEndpointGroup<TContext> {
  return Object.freeze({
    id: "platform.control-plane",
    basePath: "/runtime",
    context: options.context,
    origin: {
      type: "subsystem",
      subsystem: "server-control-plane",
    },
    api: {
      v1: options.routes,
    },
    ...(options.authenticators === undefined ? {} : { authenticators: options.authenticators }),
  });
}
