import type {
  ZelavisEndpointGroup,
  ZelavisServerRoute,
} from "../core/index.js";

export interface ZelavisPlatformEndpointOptions<TContext> {
  readonly context: TContext;
  readonly routes: readonly ZelavisServerRoute<TContext>[];
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
  });
}
