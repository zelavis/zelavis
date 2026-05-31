import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type BootstrapAdapter = "node" | "bun" | "cloudflare" | "vercel" | "netlify";

export interface BootstrapAction {
  path: string;
  status: "created" | "updated" | "skipped";
}

export interface BootstrapResult {
  mountPath: string;
  actions: BootstrapAction[];
  warnings: string[];
}

export interface BootstrapFrameworkOptions {
  cwd: string;
  adapter: BootstrapAdapter;
}

const ZELAVIS_ROUTE_ENTRY = `route("zelavis/*", "routes/zelavis.$.ts")`;

export function toProjectPath(cwd: string, absolutePath: string): string {
  return absolutePath.startsWith(cwd)
    ? absolutePath.slice(cwd.length + 1)
    : absolutePath;
}

export function getRuntimeTemplate(adapter: BootstrapAdapter): string {
  if (adapter === "cloudflare") {
    return `import { Zelavis } from "zelavis";
import {
  cloudflareAdapter,
  type CloudflareAdapterEnv,
} from "zelavis/adapters/cloudflare";

const instances = new WeakMap<CloudflareAdapterEnv, Zelavis>();

export function getZelavis(env: CloudflareAdapterEnv) {
  const existing = instances.get(env);
  if (existing) {
    return existing;
  }

  const zv = new Zelavis({
    adapter: cloudflareAdapter({ env }),
  });

  instances.set(env, zv);
  return zv;
}
`;
  }

  const adapterImport = {
    node: `import { nodeAdapter } from "zelavis/adapters/node";`,
    bun: `import { bunAdapter } from "zelavis/adapters/bun";`,
    vercel: `import { vercelAdapter } from "zelavis/adapters/vercel";`,
    netlify: `import { netlifyAdapter } from "zelavis/adapters/netlify";`,
  }[adapter];

  const adapterCall = {
    node: "nodeAdapter()",
    bun: "bunAdapter()",
    vercel: "vercelAdapter()",
    netlify: "netlifyAdapter()",
  }[adapter];

  return `import { Zelavis } from "zelavis";
${adapterImport}

export const zv = new Zelavis({
  adapter: ${adapterCall},
});
`;
}

function getRouteTemplate(adapter: BootstrapAdapter): string {
  if (adapter === "cloudflare") {
    return `import { getZelavis } from "~/lib/zelavis.server";
import type { CloudflareAdapterEnv } from "zelavis/adapters/cloudflare";

interface CloudflareContext {
  cloudflare?: {
    env?: CloudflareAdapterEnv;
    ctx?: unknown;
  };
}

function readCloudflareEnv(context: CloudflareContext): CloudflareAdapterEnv {
  const env = context.cloudflare?.env;
  if (!env || typeof env !== "object") {
    throw new Error("Zelavis Cloudflare bootstrap requires a React Router Cloudflare context with env bindings.");
  }
  return env;
}

export async function loader({
  request,
  context,
}: {
  request: Request;
  context: CloudflareContext;
}) {
  const env = readCloudflareEnv(context);
  return getZelavis(env).fetch(request, {
    platform: {
      cloudflare: {
        env,
        executionContext: context.cloudflare?.ctx,
      },
    },
  });
}

export async function action({
  request,
  context,
}: {
  request: Request;
  context: CloudflareContext;
}) {
  const env = readCloudflareEnv(context);
  return getZelavis(env).fetch(request, {
    platform: {
      cloudflare: {
        env,
        executionContext: context.cloudflare?.ctx,
      },
    },
  });
}
`;
  }

  return `import { zv } from "~/lib/zelavis.server";

export async function loader({ request }: { request: Request }) {
  return zv.fetch(request);
}

export async function action({ request }: { request: Request }) {
  return zv.fetch(request);
}
`;
}

export async function writeIfMissing(
  cwd: string,
  actions: BootstrapAction[],
  absolutePath: string,
  content: string,
): Promise<void> {
  const projectPath = toProjectPath(cwd, absolutePath);
  if (existsSync(absolutePath)) {
    actions.push({ path: projectPath, status: "skipped" });
    return;
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  actions.push({ path: projectPath, status: "created" });
}

async function updateRouteConfig(
  cwd: string,
  actions: BootstrapAction[],
  warnings: string[],
  routeConfigPath: string,
): Promise<void> {
  const projectPath = toProjectPath(cwd, routeConfigPath);
  if (!existsSync(routeConfigPath)) {
    warnings.push(
      "No app/routes.ts file was found. Add route(\"zelavis/*\", \"routes/zelavis.$.ts\") to your React Router route config if your app does not use file routes.",
    );
    return;
  }

  const source = await readFile(routeConfigPath, "utf8");
  if (source.includes("routes/zelavis.$.ts") || source.includes("zelavis/*")) {
    actions.push({ path: projectPath, status: "skipped" });
    return;
  }

  const catchAllPattern = /^([ \t]*)route\(\s*["']\*["']\s*,.*$/m;
  const catchAllMatch = source.match(catchAllPattern);
  if (catchAllMatch?.index !== undefined) {
    const indent = catchAllMatch[1];
    const updated = `${source.slice(0, catchAllMatch.index)}${indent}${ZELAVIS_ROUTE_ENTRY},\n${source.slice(catchAllMatch.index)}`;
    await writeFile(routeConfigPath, updated, "utf8");
    actions.push({ path: projectPath, status: "updated" });
    return;
  }

  const satisfiesPattern = /\n\]\s+satisfies\s+RouteConfig\s*;/;
  const satisfiesMatch = source.match(satisfiesPattern);
  if (satisfiesMatch?.index !== undefined) {
    const updated = `${source.slice(0, satisfiesMatch.index)}\n  ${ZELAVIS_ROUTE_ENTRY},${source.slice(satisfiesMatch.index)}`;
    await writeFile(routeConfigPath, updated, "utf8");
    actions.push({ path: projectPath, status: "updated" });
    return;
  }

  warnings.push(
    `Could not safely update ${projectPath}. Add ${ZELAVIS_ROUTE_ENTRY} to the exported React Router route config.`,
  );
}

export async function bootstrapReactRouter(
  options: BootstrapFrameworkOptions,
): Promise<BootstrapResult> {
  const cwd = resolve(options.cwd);
  const actions: BootstrapAction[] = [];
  const warnings: string[] = [];

  await writeIfMissing(
    cwd,
    actions,
    join(cwd, "app/lib/zelavis.server.ts"),
    getRuntimeTemplate(options.adapter),
  );

  await writeIfMissing(
    cwd,
    actions,
    join(cwd, "app/routes/zelavis.$.ts"),
    getRouteTemplate(options.adapter),
  );

  await updateRouteConfig(cwd, actions, warnings, join(cwd, "app/routes.ts"));

  return {
    mountPath: "/zelavis",
    actions,
    warnings,
  };
}
