import { execFile } from "node:child_process";

import { createZelavisClient } from "../sdk/fetch.js";
import { fetchChannelVersion } from "../adapters/_node-updates.js";
import { runUpdate } from "../adapters/_update-runner.js";
import type { ZelavisUpdateStatus } from "../updates.js";

const usage =
  "zelavis update <status|check|apply> [--wait] [--url URL] [--token TOKEN] [--json]\n  sudo zelavis update --run   (host-local; run by the zelavis-update unit, not by hand)";

/**
 * `zelavis update` — the update routes through the JS SDK client.
 *
 * `status` and `check` say what is running and what is newest. `apply` asks the
 * installation to update itself and, with `--wait`, follows it to the end; the
 * Platform restarts part-way, so a refused connection while waiting is expected.
 *
 * `--run` is the other half: the root updater a systemd unit starts when the
 * Platform leaves a request. It is host-local and has no HTTP route, because it
 * replaces the installed release.
 */
export async function runUpdateCommand(args: readonly string[]): Promise<void> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let json = false, wait = false, run = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--wait") { wait = true; continue; }
    if (arg === "--run") { run = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log(usage); return; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token"].includes(flag)) throw new Error(`Unknown update option "${arg}".`);
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
  }

  if (run) {
    await runHostUpdate(json);
    return;
  }

  const [action, ...rest] = positional;
  if (!action) { console.log(usage); return; }
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const print = (value: unknown, text: () => string) => console.log(json ? JSON.stringify(value, null, 2) : text());

  switch (action) {
    case "status": {
      const status = await client.updates.status();
      print(status, () => describe(status));
      return;
    }
    case "check": {
      const status = await client.updates.check();
      print(status, () => describe(status));
      return;
    }
    case "apply": {
      let status = await client.updates.apply();
      if (!wait) { print(status, () => `${describe(status)}\nThe update is requested and runs in the background. Follow it with: zelavis update status`); return; }
      const deadline = Date.now() + 15 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try { status = await client.updates.status(); } catch { continue; }
        const line = status.run?.message ?? status.state;
        if (!json && line !== last) { console.log(line); last = line; }
        if (status.state !== "requested" && status.state !== "running") break;
      }
      print(status, () => describe(status));
      if (status.state === "failed" || status.state === "rolled-back") process.exitCode = 1;
      return;
    }
    default:
      throw new Error(`Unknown update command "${action}". ${usage}`);
  }
}

function describe(status: ZelavisUpdateStatus): string {
  const lines = [`Running ${status.current}${status.channel ? ` on the ${status.channel} channel` : ""}.`];
  if (status.latest) lines.push(status.available ? `Version ${status.latest} is available.` : "This is the newest version.");
  else if (status.checkError) lines.push(`The newest version could not be looked up: ${status.checkError}`);
  if (!status.managed && status.unmanagedReason) lines.push(`Cannot update itself: ${status.unmanagedReason}`);
  if (status.state !== "idle") lines.push(`Update: ${status.run?.message ?? status.state}`);
  return lines.join("\n");
}

function execute(command: string, args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024, timeout: 12 * 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

async function runHostUpdate(json: boolean): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("zelavis update --run replaces the installed release and must run as root. Use the Update button, or: zelavis update apply");
  const prefix = process.env.ZELAVIS_PREFIX ?? "/opt/zelavis";
  const dataDirectory = process.env.ZELAVIS_DATA_DIR ?? "/var/lib/zelavis";
  const result = await runUpdate({
    prefix,
    dataDirectory,
    socketUnitFile: process.env.ZELAVIS_SOCKET_UNIT ?? "/etc/systemd/system/zelavis.socket",
    run: execute,
    channelVersion: (channel) => fetchChannelVersion(channel),
    healthy: async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/zelavis/api/v1/auth/bootstrap`, { signal: AbortSignal.timeout(4000) });
        return response.ok;
      } catch { return false; }
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  if (!result) { console.log("No update was requested."); return; }
  console.log(json ? JSON.stringify(result, null, 2) : `${result.state}: ${result.message ?? ""}`);
  if (result.state === "failed" || result.state === "rolled-back") process.exitCode = 1;
}
