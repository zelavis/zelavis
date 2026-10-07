import { mkdirSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const workspaceRoot = resolve(packageRoot, "../../../..");
export const fuzorRoot = resolve(process.env.FUZOR_DIR ?? resolve(workspaceRoot, "../fuzor"));
// Local links keep this experiment out of the parent workspace lockfile.
const targets = {
  ...Object.fromEntries(["@glideapps/glide-data-grid", "tabulator-tables", "@visactor/vtable", "@visactor/vtable-editors", "react", "react-dom", "@types/react", "@types/react-dom", "@types/tabulator-tables"].map(name => [name, resolve(packageRoot, "grid-dependencies/node_modules", name)])),
  swiper: resolve(workspaceRoot, "packages/zelavis/services/zelavis-ui/node_modules/swiper"),
  fuzor: resolve(fuzorRoot, "packages/fuzor"),
  vite: resolve(fuzorRoot, "packages/fuzor/node_modules/vite"),
  typescript: resolve(fuzorRoot, "packages/fuzor/node_modules/typescript"),
  effect: resolve(workspaceRoot, "packages/zelavis/node_modules/effect"),
  zelavis: resolve(workspaceRoot, "packages/zelavis"),
  "@types/node": resolve(fuzorRoot, "packages/fuzor/node_modules/@types/node"),
  "@playwright/test": resolve(workspaceRoot, "packages/zelavis/services/zelavis-ui/node_modules/@playwright/test"),
};
for (const [name, target] of Object.entries(targets)) {
  if (!existsSync(target)) throw new Error(`Missing ${target}. Install/build dependencies in its existing repository first.`);
  const link = resolve(packageRoot, "node_modules", name);
  mkdirSync(dirname(link), { recursive: true });
  if (!existsSync(link)) symlinkSync(target, link, "dir");
  else if (realpathSync(link) !== realpathSync(target)) throw new Error(`Unexpected dependency at ${link}; refusing to replace it.`);
}
