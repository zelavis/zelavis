import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const source = resolve(workspaceRoot, "packages/ui/dist/client");
const target = resolve(packageRoot, "dist/dashboard");

if (!existsSync(source)) {
  throw new Error(
    `Dashboard UI build not found at ${source}. Run pnpm --filter @zelavis/ui build first.`,
  );
}

rmSync(target, { force: true, recursive: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
