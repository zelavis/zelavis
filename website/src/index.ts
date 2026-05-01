import {
  createCloudflareD1DatabaseDriver,
  type CloudflareD1Database,
} from "@zelavis/database-cloudflare-d1";
import { zelavis } from "zelavis";

interface Env {
  ZELAVIS_DB: CloudflareD1Database;
}

let runtimePromise: ReturnType<typeof zelavis> | undefined;

function requireDatabase(env: Env): CloudflareD1Database {
  const database = env.ZELAVIS_DB;

  if (
    !database ||
    typeof database !== "object" ||
    typeof database.prepare !== "function"
  ) {
    throw new TypeError(
      "Missing or invalid Cloudflare D1 binding `ZELAVIS_DB`. Configure the binding in website/wrangler.jsonc before running the website worker.",
    );
  }

  return database;
}

function getRuntime(env: Env) {
  if (runtimePromise) {
    return runtimePromise;
  }

  const database = requireDatabase(env);

  runtimePromise = zelavis({
    coreServices: {
      database: {
        driver: createCloudflareD1DatabaseDriver({
          database,
        }),
        defaultNodeId: "cloudflare",
      },
    },
  });

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
