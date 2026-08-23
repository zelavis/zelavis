import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");

const appDist = resolve(workspaceRoot, "packages/zelavis-app/dist");
const appPackage = resolve(workspaceRoot, "packages/zelavis-app");
const appTarget = resolve(packageRoot, "services/zelavis-app");

await rm(appTarget, { recursive: true, force: true });
await mkdir(appTarget, { recursive: true });
await cp(appDist, resolve(appTarget, "dist"), { recursive: true });
for (const file of ["package.json", "README.md", "tsconfig.json"]) {
  await cp(resolve(appPackage, file), resolve(appTarget, file));
}
for (const directory of ["src", "adapters", "plugins"]) {
  await cp(resolve(appPackage, directory), resolve(appTarget, directory), {
    recursive: true,
  });
}
await writeFile(
  resolve(appTarget, "index.js"),
  `export * from "./dist/index.js";\nexport { default } from "./dist/index.js";\n`,
  "utf8",
);
await writeFile(
  resolve(appTarget, "zelavis.service.json"),
  `${JSON.stringify(
    {
      name: "@zelavis/app",
      kind: "app",
      entry: "index.js",
      boilerplate: {
        package: "package.json",
        source: "src",
        adapters: "adapters",
        plugins: "plugins",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
