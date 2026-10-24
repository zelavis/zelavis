// Bundles app/service-ui.ts into one self-contained module, and copies its stylesheet, beside the built dashboard. The
// Platform serves both to service pages (`runtime/service-ui.js`, `runtime/service-ui.css`).
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { packageRoot } from "./fuzor-source.mjs";

const out = resolve(packageRoot, ".fuzor/web/dist-spa/service-ui");
mkdirSync(out, { recursive: true });
const result = await build({
  root: packageRoot,
  configFile: false,
  logLevel: "warn",
  resolve: { dedupe: ["effect"] },
  build: {
    write: false,
    target: "es2022",
    minify: true,
    lib: { entry: resolve(packageRoot, "app/service-ui.ts"), formats: ["es"], fileName: "service-ui" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(entry => entry.output);
const chunk = outputs.find(entry => entry.type === "chunk" && entry.isEntry);
if (!chunk || outputs.filter(entry => entry.type === "chunk").length !== 1) throw new Error("The service page runtime must build to a single module.");
writeFileSync(resolve(out, "service-ui.js"), chunk.code);
copyFileSync(resolve(packageRoot, "app/zv-ui.css"), resolve(out, "service-ui.css"));
console.log(`Service page runtime: ${(chunk.code.length / 1024).toFixed(0)} KB`);
