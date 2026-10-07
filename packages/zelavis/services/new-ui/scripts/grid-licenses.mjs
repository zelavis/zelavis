import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
export function gridNotices() {
  const packages = [["@glideapps/glide-data-grid", "6.0.3", "LICENSE"], ["tabulator-tables", "6.6.1", "LICENSE"], ["@visactor/vtable", "1.26.8", undefined], ["@visactor/vtable-editors", "1.26.8", undefined], ["react", "18.3.1", "LICENSE"], ["react-dom", "18.3.1", "LICENSE"]];
  return packages.map(([name, version, license]) => {
    const folder = resolve(root, "grid-dependencies/node_modules", name);
    const manifest = JSON.parse(readFileSync(resolve(folder, "package.json"), "utf8"));
    if (manifest.version !== version || manifest.license !== "MIT") throw new Error(`Unexpected version or non-MIT license for ${name}.`);
    const notice = readFileSync(license ? resolve(folder, license) : resolve(root, "grid-dependencies/VTable-LICENSE.txt"), "utf8");
    if (!notice.includes("Permission is hereby granted")) throw new Error(`Missing MIT notice for ${name}.`);
    return `${name}@${version}\n${notice}`;
  }).join("\n\n");
}
export function writeGridNotices() {
  const target = resolve(root, "dist-spa-server/client/assets"); mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, "grid-licenses.txt"), gridNotices());
}
