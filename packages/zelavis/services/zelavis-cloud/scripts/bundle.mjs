// Bundles the built cloud service into one self-contained module for the Platform to load.
//
// Only `zelavis`, `effect` and `node:` stay external, matching the host-provided rule: every
// other dependency (Alchemy, the Hetzner client, the headless Node platform layer) is inlined,
// so a self-hosted server installs nothing. Alchemy's own tree is 1.3 GB unbundled.
//
// The one patch: Alchemy has a module-scope `import.meta.resolve("alchemy/Local/Sidecar")` (dev
// sidecar code that tree-shaking cannot drop) which fails outside its package. It is replaced with
// a stub that returns an `unavailable:` marker instead of a URL, so the module loads and only the local
// dev sidecars we do not use would fail if they were ever started.
// Re-verify this on every Alchemy bump; `test/bundle.test.mjs` fails if the patch stops applying.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDirectory = resolve(root, "bundle");
rmSync(outDirectory, { recursive: true, force: true });
mkdirSync(outDirectory, { recursive: true });

const STUB = "__zelavisUnavailableResolve";
let patched = 0;
const bundle = await rolldown({
  input: resolve(root, "dist/index.js"),
  platform: "node",
  external: [/^node:/, /^effect(\/|$)/, /^zelavis(\/|$)/, /^@effect\/platform-bun(\/|$)/],
  plugins: [{
    name: "stub-import-meta-resolve",
    transform(code) {
      if (!code.includes("import.meta.resolve(")) return null;
      patched += 1;
      const stub = `const ${STUB} = (specifier) => "unavailable:" + specifier;`;
      return `${stub}\n${code.replaceAll("import.meta.resolve(", `${STUB}(`)}`;
    },
  }],
});
await bundle.write({ file: resolve(outDirectory, "index.js"), format: "esm", sourcemap: false, codeSplitting: false });
await bundle.close();
writeFileSync(resolve(outDirectory, "PATCHED_MODULES"), `${patched}\n`);
console.log(`Bundled the cloud service (${patched} module(s) patched).`);
