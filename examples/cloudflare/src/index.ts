import { Zelavis } from "zelavis";
import {
  cloudflareAdapter,
  createCloudflareDispatchPluginActivation,
  type CloudflareAdapterEnv,
  type CloudflareDispatchNamespace,
} from "zelavis/adapters/cloudflare";

type Env = CloudflareAdapterEnv & {
  ZELAVIS_PLUGIN_DISPATCHER?: CloudflareDispatchNamespace;
};

let zelavisInstance: Zelavis | undefined;

function getZelavis(env: Env) {
  if (zelavisInstance) {
    return zelavisInstance;
  }

  zelavisInstance = new Zelavis({
    adapter: cloudflareAdapter({
      env,
      plugins: env.ZELAVIS_PLUGIN_DISPATCHER
        ? {
            activation: createCloudflareDispatchPluginActivation({
              dispatchNamespace: env.ZELAVIS_PLUGIN_DISPATCHER,
              workerName: (request) => `plugin-${request.pluginName}`,
              bindings: {
                ZELAVIS_ROOT_PATH: "/zelavis",
              },
            }),
          }
        : undefined,
    }),
  });

  return zelavisInstance;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/hello") {
      return new Response("Hello Cloudflare");
    }

    if (!url.pathname.startsWith("/zelavis")) {
      return new Response("Not Found", { status: 404 });
    }

    return getZelavis(env).fetch(request, {
      platform: {
        cloudflare: {
          env,
          executionContext: ctx,
        },
      },
    });
  },
};
