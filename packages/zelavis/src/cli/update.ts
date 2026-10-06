import { Effect } from "effect";
import { integration, IntegrationFailure, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { execFile } from "node:child_process";

import { nodeInstallationPaths, nodeUserInstallationPaths } from "../adapters/_install-host.js";
import { createZelavisClient } from "../sdk/fetch.js";
import { fetchChannelVersion } from "../adapters/_node-updates.js";
import { runUpdateProgram } from "../adapters/_update-runner.js";
import type { ZelavisUpdateStatus } from "../updates.js";

const usage =
  "zelavis update <status|check|apply> [--wait] [--url URL] [--token TOKEN] [--json]\n  sudo zelavis update --run [--instance NAME] | zelavis update --run --user   (host-local; run by the zelavis-update unit, not by hand)";

/**
 * `zelavis update` — the update routes through the JS SDK client.
 *
 * `status` and `check` say what is running and what is newest. `apply` asks the
 * installation to update itself and, with `--wait`, follows it to the end; the
 * persistent host admits those polling requests after the handover completes.
 *
 * `--run` is the other half: the root updater a systemd unit starts when the
 * Platform leaves a request. It is host-local and has no HTTP route, because it
 * replaces the installed release.
 */
const runUpdateCommandProgram = Effect.fn("UpdateCLI.run")(function* (args: readonly string[]): Effect.fn.Return<void, TaggedFailure> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let json = false, wait = false, run = false, userMode = false;
  let instance = "default";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--wait") { wait = true; continue; }
    if (arg === "--run") { run = true; continue; }
    if (arg === "--user") { userMode = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log(usage); return; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token", "--instance"].includes(flag)) return yield* new IntegrationFailure(new Error(`Unknown update option "${arg}".`));
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) return yield* new IntegrationFailure(new Error(`${flag} requires a value.`));
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--instance") instance = value;
  }

  if (run) {
    yield* runHostUpdate(json, instance, userMode);
    return;
  }

  const [action, ...rest] = positional;
  if (!action) { console.log(usage); return; }
  if (rest.length > 0) return yield* new IntegrationFailure(new Error(`Unexpected argument "${rest[0]}". ${usage}`));
  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const print = (value: unknown, text: () => string) => console.log(json ? JSON.stringify(value, null, 2) : text());

  switch (action) {
    case "status": {
      const status = yield* integration(() => client.updates.status());
      print(status, () => describe(status));
      return;
    }
    case "check": {
      const status = yield* integration(() => client.updates.check());
      print(status, () => describe(status));
      return;
    }
    case "apply": {
      let status = yield* integration(() => client.updates.apply());
      if (!wait) { print(status, () => `${describe(status)}\nThe update is requested and runs in the background. Follow it with: zelavis update status`); return; }
      const deadline = Date.now() + 15 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        yield* Effect.sleep(2000);
        const inspected = yield* Effect.result(integration(() => client.updates.status()));
        if (inspected._tag === "Failure") continue;
        status = inspected.success;
        const line = status.run?.message ?? status.state;
        if (!json && line !== last) { console.log(line); last = line; }
        if (status.state !== "requested" && status.state !== "running") break;
      }
      print(status, () => describe(status));
      if (status.state === "failed" || status.state === "rolled-back") process.exitCode = 1;
      return;
    }
    default:
      return yield* new IntegrationFailure(new Error(`Unknown update command "${action}". ${usage}`));
  }
});

export function runUpdateCommand(args: readonly string[]): Promise<void> { return present(runUpdateCommandProgram(args)); }

function describe(status: ZelavisUpdateStatus): string {
  const lines = [`Running ${status.current}${status.channel ? ` on the ${status.channel} channel` : ""}.`];
  if (status.latest) lines.push(status.available ? `Version ${status.latest} is available.` : "This is the newest version.");
  else if (status.checkError) lines.push(`The newest version could not be looked up: ${status.checkError}`);
  if (!status.managed && status.unmanagedReason) lines.push(`Cannot update itself: ${status.unmanagedReason}`);
  if (status.state !== "idle") lines.push(`Update: ${status.run?.message ?? status.state}`);
  return lines.join("\n");
}

const executeProgram = Effect.fn("UpdateCLI.execute")(function* (command: string, args: readonly string[]) {
  return yield* Effect.callback<{ code: number; output: string }>(resume => {
    execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024, timeout: 12 * 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resume(Effect.succeed({ code, output: `${stdout}${stderr}` }));
    });
  }).pipe(Effect.uninterruptible);
});

const runHostUpdate = Effect.fn("UpdateCLI.runHost")(function* (json: boolean, instance: string, userMode: boolean): Effect.fn.Return<void, TaggedFailure> {
  if (!userMode && process.getuid?.() !== 0) return yield* new IntegrationFailure(new Error("zelavis update --run replaces the installed release and must run as root. Use the Update button, or: zelavis update apply"));
  const { prefix, dataDirectory } = userMode ? nodeUserInstallationPaths() : nodeInstallationPaths(process.env, instance);
  const result = yield* runUpdateProgram({
    prefix,
    dataDirectory,
    instance,
    mode: userMode ? "user" : "system",
    ...process.env.ZELAVIS_RUNNING_RELEASE ? { keepRelease: process.env.ZELAVIS_RUNNING_RELEASE } : {},
    run: (command, args) => present(executeProgram(command, args)),
    channelVersion: (channel) => fetchChannelVersion(channel),
    healthy: port => present(integration(signal => fetch(`http://127.0.0.1:${port}/zelavis/api/v1/auth/bootstrap`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
    }), { interruptible: true }).pipe(Effect.flatMap(response => integration(() => response.body?.cancel()).pipe(Effect.as(response.ok))), Effect.orElseSucceed(() => false))),
    sleep: milliseconds => present(Effect.sleep(milliseconds)),
  });
  if (!result) { console.log("No update was requested."); return; }
  console.log(json ? JSON.stringify(result, null, 2) : `${result.state}: ${result.message ?? ""}`);
  if (result.state === "failed" || result.state === "rolled-back") process.exitCode = 1;
});
