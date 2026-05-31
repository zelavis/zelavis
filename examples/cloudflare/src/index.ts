import { Zelavis } from "zelavis";
import {
  cloudflareAdapter,
  createCloudflareDispatchServiceActivation,
  type CloudflareAdapterEnv,
  type CloudflareDispatchNamespace,
} from "zelavis/adapters/cloudflare";

type Env = CloudflareAdapterEnv & {
  ZELAVIS_SERVICE_DISPATCHER?: CloudflareDispatchNamespace;
};

let zv: Zelavis | undefined;

function getZelavis(env: Env) {
  if (zv) {
    return zv;
  }

  zv = new Zelavis({
    adapter: cloudflareAdapter({
      env,
      services: env.ZELAVIS_SERVICE_DISPATCHER
        ? {
            activation: createCloudflareDispatchServiceActivation({
              dispatchNamespace: env.ZELAVIS_SERVICE_DISPATCHER,
              workerName: (request) => `service-`,
              bindings: {
                ZELAVIS_ROOT_PATH: "/zelavis",
              },
            }),
          }
        : undefined,
    }),
  });

  return zv;
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
