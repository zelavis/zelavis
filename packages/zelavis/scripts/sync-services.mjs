import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");

const appDist = resolve(workspaceRoot, "packages/zelavis-app/dist");
const appTarget = resolve(packageRoot, "services/zelavis-app");

await rm(appTarget, { recursive: true, force: true });
await mkdir(appTarget, { recursive: true });
await cp(appDist, appTarget, { recursive: true });
await writeFile(
  resolve(appTarget, "zelavis.service.json"),
  `${JSON.stringify(
    {
      name: "@zelavis/app",
      kind: "app",
      entry: "index.js",
    },
    null,
    2,
  )}\n`,
  "utf8",
);
