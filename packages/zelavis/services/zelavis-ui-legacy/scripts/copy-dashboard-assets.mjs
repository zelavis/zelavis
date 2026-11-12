import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const source = resolve(packageRoot, "build/client");
const target = resolve(packageRoot, "src/generated/dashboard-assets.ts");

if (!existsSync(source)) {
  throw new Error(
    `Dashboard UI build not found at ${source}. Run pnpm --filter @zelavis/ui build first.`,
  );
}

function getContentType(routePath) {
  if (routePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (routePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (routePath.endsWith(".js") || routePath.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (routePath.endsWith(".json") || routePath.endsWith(".webmanifest")) {
    return "application/json; charset=utf-8";
  }
  if (routePath.endsWith(".ico")) return "image/x-icon";
  if (routePath.endsWith(".png")) return "image/png";
  if (routePath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (routePath.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function walk(directory = source) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(filePath);
    }

    return [filePath];
  });
}

const files = walk(source).sort((left, right) => left.localeCompare(right));
const shellPath = join(source, "index.html");
const shell = existsSync(shellPath) ? readFileSync(shellPath, "utf8") : "";

const assets = files
  .filter((filePath) => filePath !== shellPath)
  .map((filePath) => {
    const routePath = `/${relative(source, filePath).split(sep).join("/")}`;
    const contentType = getContentType(routePath);
    const isText =
      contentType.startsWith("text/") ||
      contentType.startsWith("application/json") ||
      routePath.endsWith(".js") ||
      routePath.endsWith(".mjs");

    return {
      path: routePath,
      contentType,
      cacheControl: "no-cache",
      kind: isText ? "text" : "base64",
      content: isText
        ? readFileSync(filePath, "utf8")
        : readFileSync(filePath).toString("base64"),
    };
  });

mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  `export interface EmbeddedDashboardAsset {\n  path: string;\n  contentType: string;\n  cacheControl: string;\n  kind: "text" | "base64";\n  content: string;\n}\n\nexport const embeddedDashboardShell = ${JSON.stringify(shell)};\n\nexport const embeddedDashboardAssets: readonly EmbeddedDashboardAsset[] = ${JSON.stringify(assets, null, 2)} as const;\n`,
);
