import { Zelavis } from "zelavis";
import {
  cloudflarePlatform,
  type CloudflareD1Binding,
  type CloudflareKvNamespace,
  type CloudflareR2Bucket,
} from "zelavis/platforms/cloudflare";

interface Env {
  ZELAVIS_DB?: CloudflareD1Binding;
  ZELAVIS_KV?: CloudflareKvNamespace;
  ZELAVIS_FILES?: CloudflareR2Bucket;
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

    const zelavis = new Zelavis({
      platform: cloudflarePlatform({
        database: env.ZELAVIS_DB
          ? {
              binding: env.ZELAVIS_DB,
            }
          : false,
        kv: env.ZELAVIS_KV
          ? {
              namespace: env.ZELAVIS_KV,
            }
          : false,
        files: env.ZELAVIS_FILES
          ? {
              bucket: env.ZELAVIS_FILES,
            }
          : false,
      }),
    });

    return zelavis.fetch(request, {
      platform: {
        cloudflare: {
          env,
          executionContext: ctx,
        },
      },
    });
  },
};
