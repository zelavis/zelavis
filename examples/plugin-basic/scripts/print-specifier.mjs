import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const pluginPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

try {
  await access(pluginPath);
} catch {
  console.error(
    "Build the plugin first with: pnpm --filter @zelavis/example-plugin-basic build",
  );
  process.exitCode = 1;
}

if (!process.exitCode) {
  console.log(pluginPath);
}
