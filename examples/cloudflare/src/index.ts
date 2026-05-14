import { Zelavis } from "zelavis";
import { zelavisCloudflare } from "zelavis/adapters";
import type { CloudflarePlatformEnv } from "zelavis/platforms/cloudflare";

type Env = CloudflarePlatformEnv;

let zelavisInstance: Zelavis | undefined;

function getZelavis(env: Env) {
  if (zelavisInstance) {
    return zelavisInstance;
  }

  zelavisInstance = new Zelavis({
    adapter: zelavisCloudflare({ env }),
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
