import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const result = await build({
  root: packageRoot,
  configFile: false,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false, target: "es2022", modulePreload: false,
    rollupOptions: {
      input: resolve(packageRoot, "app/identity-site.ts"),
      output: { entryFileNames: "identity.js", inlineDynamicImports: true },
    },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(build => build.output);
const [script] = outputs;
if (outputs.length !== 1 || script.type !== "chunk" || !script.isEntry || script.fileName !== "identity.js" || script.imports.length || script.dynamicImports.length) {
  throw new Error("The App auth browser bundle must contain one standalone script.");
}
const out = resolve(packageRoot, "dist/identity-assets");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, script.fileName), script.code);
copyFileSync(resolve(packageRoot, "app/identity-site.css"), resolve(out, "identity.css"));
