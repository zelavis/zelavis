import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  getRuntimeTemplate,
  toProjectPath,
  type BootstrapAction,
  type BootstrapAdapter,
  type BootstrapFrameworkOptions,
  type BootstrapResult,
  writeIfMissing,
} from "./react-router.js";

export type NextjsRouter = "app" | "pages";

export interface BootstrapNextjsOptions extends BootstrapFrameworkOptions {
  router: NextjsRouter;
}

function getRuntimeImportPath(router: NextjsRouter): string {
  return router === "app" ? "@/lib/zelavis.server" : "@/lib/zelavis";
}

function getAppRouterRouteTemplate(adapter: BootstrapAdapter): string {
  const runtimeImportPath = getRuntimeImportPath("app");

  if (adapter === "cloudflare") {
    return `import { getZelavis } from "${runtimeImportPath}";

export const runtime = "edge";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  return getZelavis().fetch(request);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
`;
  }

  return `import { zelavis } from "${runtimeImportPath}";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  return zelavis.fetch(request);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
`;
}

function getPagesRouterApiTemplate(): string {
  return `import { nextjsPagesRouterHandler } from "zelavis/nextjs/pages";
import { zelavis } from "@/lib/zelavis";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default nextjsPagesRouterHandler(zelavis, {
  routePrefix: "/api/zelavis",
  mountPath: "/zelavis",
});
`;
}

function getNextConfigTemplate(): string {
  return `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/zelavis/:path*",
        destination: "/api/zelavis/:path*",
      },
    ];
  },
};

export default nextConfig;
`;
}

async function addPagesRouterRewrite(
  cwd: string,
  actions: BootstrapAction[],
  warnings: string[],
) {
  const candidates = [
    join(cwd, "next.config.ts"),
    join(cwd, "next.config.mjs"),
    join(cwd, "next.config.js"),
  ];
  const existing = candidates.find((path) => existsSync(path));

  if (!existing) {
    await writeIfMissing(
      cwd,
      actions,
      candidates[0],
      getNextConfigTemplate(),
    );
    return;
  }

  const projectPath = toProjectPath(cwd, existing);
  const source = await readFile(existing, "utf8");
  if (source.includes("/api/zelavis") || source.includes("/zelavis/:path*")) {
    actions.push({ path: projectPath, status: "skipped" });
    return;
  }

  warnings.push(
    `Could not safely update ${projectPath}. Add a rewrite from /zelavis/:path* to /api/zelavis/:path*.`,
  );
}

async function bootstrapNextjsAppRouter(
  options: BootstrapFrameworkOptions,
): Promise<BootstrapResult> {
  const cwd = resolve(options.cwd);
  const actions: BootstrapAction[] = [];
  const warnings: string[] = [];

  await writeIfMissing(
    cwd,
    actions,
    join(cwd, "lib/zelavis.server.ts"),
    getRuntimeTemplate(options.adapter),
  );

  await writeIfMissing(
    cwd,
    actions,
    join(cwd, "app/zelavis/[[...path]]/route.ts"),
    getAppRouterRouteTemplate(options.adapter),
  );

  return {
    mountPath: "/zelavis",
    actions,
    warnings,
  };
}

async function bootstrapNextjsPagesRouter(
  options: BootstrapFrameworkOptions,
): Promise<BootstrapResult> {
  const cwd = resolve(options.cwd);
  const actions: BootstrapAction[] = [];
  const warnings: string[] = [];

  await writeIfMissing(
    cwd,
    actions,
    join(cwd, "lib/zelavis.ts"),
    getRuntimeTemplate(options.adapter),
  );

  await writeIfMissing(
    cwd,
    actions,
    join(cwd, "pages/api/zelavis/[[...path]].ts"),
    getPagesRouterApiTemplate(),
  );

  await addPagesRouterRewrite(cwd, actions, warnings);

  return {
    mountPath: "/zelavis",
    actions,
    warnings,
  };
}

export async function bootstrapNextjs(
  options: BootstrapNextjsOptions,
): Promise<BootstrapResult> {
  return options.router === "app"
    ? bootstrapNextjsAppRouter(options)
    : bootstrapNextjsPagesRouter(options);
}
