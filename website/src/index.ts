import { Zelavis } from "zelavis";
import {
  cloudflareAdapter,
  type CloudflareAdapterEnv,
} from "zelavis/adapters/cloudflare";

type Env = CloudflareAdapterEnv;

let runtimePromise: Promise<Awaited<ReturnType<Zelavis["runtime"]>>> | undefined;

function getRuntime(env: Env) {
  if (runtimePromise) {
    return runtimePromise;
  }

  const zelavis = new Zelavis({
    adapter: cloudflareAdapter({ env }),
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
    try {
      const runtime = await getRuntime(env);

      return runtime.fetch(request, {
        platform: {
          cloudflare: {
            env,
            executionContext: ctx,
          },
        },
      });
    } catch (error) {
      const url = new URL(request.url);
      const isLocalDev =
        url.hostname === "localhost" || url.hostname === "127.0.0.1";

      if (isLocalDev) {
        const message =
          error instanceof Error
            ? (error.stack ?? `${error.name}: ${error.message}`)
            : String(error);

        return new Response(message, {
          status: 500,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-cache",
          },
        });
      }

      throw error;
    }
  },
};
