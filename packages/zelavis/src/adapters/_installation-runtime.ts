import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { assertInstallationInstance, assertInstallationPort, installationInstanceScope } from "../core/runtime/installation-instance.js";
import { assertInstallationPath } from "../core/runtime/installation-plan.js";
import { evaluate, integration, present } from "../core/runtime/effect-boundary.js";
import { isExactVersion } from "../updates.js";

/** Public descriptor has no bootstrap token and is readable by the service UID. */
const readInstallationRuntime = Effect.fn("InstallationRuntime.read")(function* (prefix?: string, instance = "default") {
  yield* evaluate(() => assertInstallationInstance(instance));
  if (!prefix) return undefined;
  const scope = installationInstanceScope(prefix, instance);
  const source = yield* integration(() => readFile(scope.runtime, "utf8"));
  return yield* evaluate(() => {
    const value = JSON.parse(source);
    if (value.schemaVersion !== 1 || !isExactVersion(value.version) || value.instance !== instance || value.prefix !== prefix || typeof value.edge !== "boolean" || !["127.0.0.1", "0.0.0.0"].includes(value.host) || scope.named && value.edge) throw new Error("Malformed selected installation runtime descriptor.");
    assertInstallationPort(value.port);
    assertInstallationPath(value.dataDirectory, "instance data");
    assertInstallationPath(value.configDirectory, "instance configuration");
    return { prefix, instance, version: value.version as string, edge: value.edge as boolean, dataDirectory: value.dataDirectory as string, configDirectory: value.configDirectory as string, port: value.port as number, host: value.host as string, node: `${scope.current}/runtime/node/bin/node`, cli: `${scope.current}/platform/dist/cli.js` };
  });
});
export function readNodeInstallationRuntime(prefix?: string, instance = "default") { return present(readInstallationRuntime(prefix, instance)); }
