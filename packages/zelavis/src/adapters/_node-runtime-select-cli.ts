import { Effect } from "effect";
import { selectNodeInstallationRuntime } from "./_node-runtime-selection.js";

// Private installer entrypoint. Public operations retain their ordinary
// authenticated SDK/HTTP/CLI surfaces; this owns only local root inventory.
const [prefix, instance, dataDirectory, version, ...extra] = process.argv.slice(2);
if (!prefix || !instance || !dataDirectory || !version || extra.length) throw new Error("Runtime selection requires prefix, instance, data directory and exact version.");
Effect.runFork(selectNodeInstallationRuntime({ prefix, instance, dataDirectory, version }).pipe(Effect.match({
  onSuccess: selected => console.log(JSON.stringify({ selected })),
  onFailure: error => { console.error(error.message); process.exitCode = 1; },
})));
