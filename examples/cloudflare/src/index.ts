import { Zelavis } from "zelavis";
import {
  cloudflarePlatform,
  type CloudflarePlatformEnv,
} from "zelavis/platforms/cloudflare";

type Env = CloudflarePlatformEnv;

let runtimePromise: Promise<Awaited<ReturnType<Zelavis["runtime"]>>> | undefined;

function getRuntime(env: Env) {
  if (runtimePromise) {
    return runtimePromise;
  }

  const zelavis = new Zelavis({
    platform: cloudflarePlatform({
      env,
    }),
  });

  runtimePromise = zelavis.runtime();
  return runtimePromise;
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

    const runtime = await getRuntime(env);

    return runtime.fetch(request, {
      platform: {
        cloudflare: {
          env,
          executionContext: ctx,
        },
      },
    });
  },
};
