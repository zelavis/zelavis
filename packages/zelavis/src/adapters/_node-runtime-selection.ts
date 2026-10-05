import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Deferred, Effect } from "effect";
import { installationInstanceScope } from "../core/runtime/installation-instance.js";
import { evaluate, integration, IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import { createNodeInstallHost, nodeInstallationPaths } from "./_install-host.js";
import { planZelavisRuntimeHostAssetsProgram } from "../core/runtime/installation-plan.js";
import { assertInstallationPath, planZelavisProductionEdgeDirectories } from "../core/runtime/installation-plan.js";
import { assertProductionEdgePortsProgram } from "../core/runtime/installation-health.js";
import { isExactVersion } from "../updates.js";
import { requestNodeRuntimeControl } from "./_node-runtime-control.js";

const flushDirectory = (path: string) => process.platform === "win32" ? Effect.void : Effect.acquireUseRelease(
  integration(() => open(path, "r")), handle => integration(() => handle.sync()), handle => integration(() => handle.close()).pipe(Effect.orDie));
const writeReceipt = Effect.fn("RuntimeSelection.writeInventory")(function* (path: string, value: Readonly<Record<string, unknown>> | string, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}`;
  yield* Effect.gen(function* () {
    yield* Effect.acquireUseRelease(integration(() => open(temporary, "wx", mode)), handle => Effect.gen(function* () {
      yield* integration(() => handle.writeFile(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)); yield* integration(() => handle.sync());
    }), handle => integration(() => handle.close()).pipe(Effect.orDie));
    yield* integration(() => rename(temporary, path)); yield* flushDirectory(dirname(path));
  }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
});

/** Root installer (or the owner of a user install) commits its own inventory.
 * The engine never escalates privileges or writes the root-owned release tree.
 * Both target and rollback selections require nonce-bound acknowledgement.
 */
export const selectNodeInstallationRuntime = Effect.fn("RuntimeSelection.select")(function* (options: {
  readonly prefix: string; readonly instance: string; readonly dataDirectory: string; readonly version: string;
}) {
  yield* evaluate(() => { if (!isExactVersion(options.version)) throw new Error("Runtime selection requires an exact version."); });
  const scope = installationInstanceScope(options.prefix, options.instance);
  const source = yield* integration(() => readFile(scope.receipt, "utf8"));
  const receipt = yield* evaluate(() => {
    assertInstallationPath(options.prefix, "runtime selection prefix");
    assertInstallationPath(options.dataDirectory, "runtime selection data");
    const value = JSON.parse(source) as Record<string, unknown>;
    if (value.schemaVersion !== 2 || value.prefix !== options.prefix || value.instance !== options.instance || value.dataDirectory !== options.dataDirectory || !isExactVersion(value.version) || !["system", "user"].includes(String(value.mode))) throw new Error("Runtime selection disagrees with the installation receipt.");
    if (value.mode === "system" && process.getuid?.() !== 0) throw new Error("System installation inventory selection must run through its root installer.");
    return value;
  });
  const runtimeSource = yield* integration(() => readFile(scope.runtime, "utf8"));
  const runtime = yield* evaluate(() => {
    const value = JSON.parse(runtimeSource);
    if (value.version === undefined) throw new Error("This installation has no qualified runtime handover inventory. Run the full installer once to install the persistent host; that conversion requires a restart.");
    if (value.schemaVersion !== 1 || value.version !== receipt.version || value.prefix !== options.prefix || value.instance !== options.instance || value.dataDirectory !== options.dataDirectory) throw new Error("Public runtime descriptor disagrees with root inventory.");
    return value as Record<string, unknown>;
  });
  const previous = yield* integration(() => realpath(scope.current));
  const releases = yield* integration(() => realpath(join(options.prefix, "releases")));
  yield* evaluate(() => { if (previous !== join(releases, String(receipt.version))) throw new Error("Current release disagrees with the installation receipt."); });
  const endpoint = join(options.dataDirectory, "runtime-control.sock");
  const before = yield* requestNodeRuntimeControl(endpoint, { action: "status" });
  yield* evaluate(() => {
    if (before.ready !== true || before.requiresRecovery || (before.release as RuntimeRelease)?.version !== receipt.version) throw new Error("Platform host selection disagrees with installer inventory or requires fenced recovery.");
  });
  // Directory permissions are installed host inventory, prepared before the
  // candidate starts Traefik. The file provider must be able to watch its output
  // when it starts, including before the release-selection acknowledgement.
  if (receipt.mode === "system" && receipt.edge === true) {
    const host = createNodeInstallHost();
    const paths = { ...nodeInstallationPaths(process.env, options.instance), prefix: options.prefix,
      dataDirectory: options.dataDirectory, configDirectory: String(receipt.configDirectory), commandPath: String(receipt.commandPath) };
    yield* assertProductionEdgePortsProgram({ host, paths, port: Number(receipt.port), edge: true });
    for (const step of planZelavisProductionEdgeDirectories(paths)) yield* integration(() => host.execute(step.action));
  }
  const completed = Deferred.makeUnsafe<Readonly<Record<string, unknown>>, TaggedFailure>();
  return yield* Effect.scoped(Effect.gen(function* () {
    yield* Effect.forkChild(requestNodeRuntimeControl(endpoint, { action: "select", version: options.version, commit: true }).pipe(
      Effect.onExit(exit => Deferred.done(completed, exit).pipe(Effect.asVoid)),
      Effect.ignore,
    ));
    const acknowledged = new Set<string>();
    while (!(yield* Deferred.isDone(completed))) {
      const status = yield* requestNodeRuntimeControl(endpoint, { action: "status" });
      const pending = status.pendingCommit as { nonce: string; release: RuntimeRelease; generation: number } | undefined;
      if (pending && !acknowledged.has(pending.nonce)) {
        const committed = yield* Effect.result(Effect.gen(function* () {
          yield* evaluate(() => {
            if (typeof pending.nonce !== "string" || !Number.isSafeInteger(pending.generation) || ![receipt.version, options.version].includes(pending.release?.version)) throw new Error("Host inventory request names an unauthorized runtime selection.");
          });
          const target = join(options.prefix, "releases", pending.release.version);
          const canonical = yield* integration(() => realpath(target));
          yield* evaluate(() => { if (canonical !== join(releases, pending.release.version)) throw new Error("Runtime inventory cannot select a linked or external release."); });
          if (receipt.mode === "system") {
            const host = createNodeInstallHost();
            const paths = { ...nodeInstallationPaths(process.env, options.instance), prefix: options.prefix,
              dataDirectory: options.dataDirectory, configDirectory: String(receipt.configDirectory), commandPath: String(receipt.commandPath) };
            const assets = yield* planZelavisRuntimeHostAssetsProgram({ host, paths, source: canonical,
              port: Number(receipt.port), public: runtime.host === "0.0.0.0" });
            for (const step of assets) {
              if (step.action.kind !== "write") return yield* new IntegrationFailure(new Error("Runtime host asset plan contains an unsupported action."));
              yield* writeReceipt(step.action.path, step.action.content, step.action.mode);
            }
            yield* integration(() => host.execute({ kind: "command", command: "systemctl", args: ["daemon-reload"] }));
          }
          const temporary = `${scope.current}.${randomUUID()}`;
          yield* Effect.gen(function* () {
            yield* integration(() => symlink(target, temporary));
            yield* integration(() => rename(temporary, scope.current));
            yield* flushDirectory(dirname(scope.current));
            yield* writeReceipt(scope.receipt, { ...receipt, version: pending.release.version });
            // Write public confirmation last: an interrupted partial inventory
            // update must not allow an unacknowledged engine to boot.
            yield* writeReceipt(scope.runtime, { ...runtime, version: pending.release.version }, receipt.mode === "system" ? 0o644 : 0o600);
            if (receipt.mode === "system" && receipt.edge === true) {
              yield* integration(() => createNodeInstallHost().execute({ kind: "command", command: "systemctl", args: ["enable", "zelavis-traefik.service"] }));
            }
          }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
        }));
        yield* requestNodeRuntimeControl(endpoint, { action: "commit", nonce: pending.nonce, version: pending.release.version,
          generation: pending.generation, accepted: committed._tag === "Success" });
        acknowledged.add(pending.nonce);
      }
      yield* Effect.sleep(20);
    }
    return yield* Deferred.await(completed);
  })).pipe(Effect.timeoutOrElse({ duration: 150_000,
    orElse: () => Effect.fail(new IntegrationFailure(new Error("Runtime inventory selection did not complete within its bounded handover window."))),
  }));
});
