// A small discovery entry and lazy component modules, isolated from the dashboard's own assets.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { packageRoot } from "./fuzor-source.mjs";

const out = resolve(packageRoot, ".fuzor/web/dist-spa/service-ui");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const result = await build({
  root: packageRoot,
  configFile: false,
  base: "./",
  logLevel: "warn",
  // This is a standalone production browser entry, with no consumer bundler to replace Node expressions later.
  define: { "process.env.NODE_ENV": '"production"' },
  resolve: { dedupe: ["effect"] },
  build: {
    write: false,
    target: "es2022",
    minify: true,
    rollupOptions: { input: resolve(packageRoot, "app/service-ui.ts"), output: {
      entryFileNames: "service-ui.js",
      chunkFileNames: chunk => {
        const family = /\/ui\/components\/([^/]+)\/index\.[jt]s$/.exec(chunk.facadeModuleId ?? "")?.[1];
        return `service-ui/${family ?? "[name]"}-[hash].js`;
      },
    } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(entry => entry.output);
const chunk = outputs.find(entry => entry.type === "chunk" && entry.isEntry);
if (!chunk) throw new Error("The service page runtime needs its discovery entry.");
const modules = outputs.filter(entry => entry.type === "chunk");
if (modules.length > 128 || outputs.some(entry => entry.type !== "chunk")) throw new Error("Unexpected service-page build assets.");
const byName = new Map(modules.map(module => [module.fileName, module]));
if (modules.reduce((sum, module) => sum + Buffer.byteLength(module.code), 0) > 8 * 1024 * 1024) throw new Error("Service-page build exceeds the size limit.");
mkdirSync(resolve(out, "service-ui"));
for (const module of modules) {
  if (module !== chunk && !/^service-ui\/[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]{8}\.js$/.test(module.fileName)) throw new Error(`Invalid service-page module: ${module.fileName}`);
  if (Buffer.byteLength(module.code) > 2 * 1024 * 1024) throw new Error(`Oversized service-page module: ${module.fileName}`);
  for (const dependency of [...module.imports, ...module.dynamicImports]) if (!byName.has(dependency)) throw new Error(`External service-page import: ${dependency}`);
  writeFileSync(resolve(out, module.fileName), module.code);
}
copyFileSync(resolve(packageRoot, "app/zv-ui.css"), resolve(out, "service-ui.css"));
const initial = new Set();
const visit = module => { if (initial.has(module.fileName)) return; initial.add(module.fileName); for (const name of module.imports) { const dependency = byName.get(name); if (!dependency) throw new Error(`External service-page import: ${name}`); visit(dependency); } };
visit(chunk);
const bytes = module => Buffer.byteLength(module.code);
console.log(`Service page runtime: ${modules.length} modules, ${modules.reduce((sum, module) => sum + bytes(module), 0)} bytes total; empty page ${[...initial].reduce((sum, name) => sum + bytes(byName.get(name)), 0)} bytes (${[...initial].reduce((sum, name) => sum + gzipSync(byName.get(name).code).byteLength, 0)} gzip).`);
