// Distribution owns these sources. Publish them with the Platform so the
// installer assembles a release from the npm package alone, without
// maintaining a second template, checksum or operation implementation.
import { copyFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const output = new URL("../dist/installation-assets/", import.meta.url);
const distribution = new URL("../../../distribution/", import.meta.url);
await mkdir(output, { recursive: true });
for (const file of ["scripts/runtime-assets.mjs", "scripts/stage-operations.mjs", "release.json"]) {
  await copyFile(new URL(file, distribution), new URL(file.split("/").at(-1), output));
}
await mkdir(new URL("share/", output), { recursive: true });
for (const file of ["zelavis.service", "zelavis@.service", "zelavis-agent.service", "zelavis-agent@.service", "zelavis-traefik.service", "zelavis-update.service", "zelavis-update.path", "traefik.yml"]) {
  await copyFile(new URL(`runtime/${file}`, distribution), new URL(`share/${file}`, output));
}
await copyFile(new URL("runtime/zelavis", distribution), new URL("zelavis-launcher", output));
// The updater runs the installer that shipped inside the installed release, so a server
// updates itself without fetching anything but Node and the package.
await copyFile(new URL("installers/install.sh", distribution), new URL("install.sh", output));
await copyFile(new URL("installers/uninstall.sh", distribution), new URL("share/uninstall.sh", output));
const { stageOperations } = await import(new URL("scripts/stage-operations.mjs", distribution).href);
const { validateHostOperationManifest } = await import(pathToFileURL(new URL("../dist/core/deployment/index.js", import.meta.url).pathname).href);
await stageOperations({
  source: new URL("operations", distribution).pathname,
  output: new URL("operations/", output).pathname,
  validate: validateHostOperationManifest,
});
