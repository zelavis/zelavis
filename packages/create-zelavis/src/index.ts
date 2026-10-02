import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const HELP = `Install Zelavis on this machine.

  npm create zelavis@latest -- [options]
  pnpm create zelavis [options]
  bun create zelavis [options]

  --user             Install in ~/.local/share/zelavis, without system services
  --system           Install system-wide on Linux with systemd (sudo when needed)
  --yes, -y          Accept the displayed plan without an interactive prompt
  --dry-run          Show acquisition, layout and the exact command; make no changes
  --instance <name>  Select a named system instance
  --port <port>      Reserve its Platform port (required for a new named instance)
  --public           Bind the Platform to 0.0.0.0 instead of 127.0.0.1
  --force            Replace a conflicting Zelavis command deliberately
  --allow-downgrade  Permit an older release deliberately
  --enable-agent     Enable the Agent (system mode only)
  --help, -h         Show help
  --version, -v      Show the create package version

No folder argument. Linux defaults to system mode when root or sudo is
available; macOS and Linux without sudo default to user mode.
`;

export interface InstallArguments {
  readonly mode?: "system" | "user";
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly flags: readonly string[];
}

export function parseArguments(args: readonly string[]): InstallArguments {
  let mode: "system" | "user" | undefined;
  let yes = false, dryRun = false, help = false, version = false;
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--instance" || arg === "--port") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--instance" && !/^[a-z][a-z0-9-]{0,23}$/u.test(value) || arg === "--port" && (!Number.isInteger(Number(value)) || Number(value) < 1024 || Number(value) > 65535)) throw new Error(`Invalid ${arg} value.`);
      flags.push(arg, value);
      continue;
    }
    if (arg === "--") continue;
    if (arg === "--user" || arg === "--system") {
      const next = arg === "--user" ? "user" : "system";
      if (mode && mode !== next) throw new Error("Choose either --user or --system.");
      mode = next;
    } else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version" || arg === "-v") version = true;
    else if (["--public", "--force", "--allow-downgrade", "--enable-agent"].includes(arg)) flags.push(arg);
    else throw new Error(`Unexpected argument: ${arg}. create-zelavis installs on this machine and accepts no folder argument. Use --help.`);
  }
  return { mode, yes, dryRun, help, version, flags };
}

export function selectInstallMode(requested: InstallArguments["mode"], platform: string, root: boolean, sudo: boolean): "system" | "user" {
  if (!["linux", "darwin"].includes(platform)) throw new Error(`Unsupported installation platform: ${platform}.`);
  const mode = requested ?? (platform === "linux" && (root || sudo) ? "system" : "user");
  if (mode === "system" && (platform !== "linux" || !root && !sudo)) throw new Error("System installation requires Linux and root or sudo; use --user.");
  return mode;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Root executes literal bootstrap code; version, flags and diagnostic PATH/home are literal argv. */
export function installationCommand(input: { version: string; script: string; mode: "user" | "system"; root: boolean; invokingPath?: string; invokingHome?: string; flags?: readonly string[] }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(input.version)) throw new Error("The create package must select an exact Zelavis version.");
  const flags = input.flags ?? [];
  try { if (parseArguments(flags).flags.length !== flags.length) throw new Error("Invalid installer flag."); } catch { throw new Error("Invalid installer flag."); }
  const instance = flags[flags.indexOf("--instance") + 1];
  if (input.mode === "user" && flags.includes("--instance") && instance !== "default") throw new Error("Named instances require system mode.");
  if (input.mode === "user" && flags.includes("--enable-agent")) throw new Error("The Agent requires system mode.");
  const elevated = input.mode === "system" && !input.root;
  const command = elevated ? "sudo" : "/bin/sh";
  const args = [...elevated ? ["--", "/bin/sh"] : [], "-c", input.script, "--", input.version, ...input.mode === "user" ? ["--user"] : [], ...flags, ...input.invokingPath ? ["--invoking-path", input.invokingPath] : [], ...input.invokingHome ? ["--invoking-home", input.invokingHome] : []];
  return { command, args, display: [command, ...args].map(shellQuote).join(" ") };
}

export function installationOverview(mode: "system" | "user", version: string, home = homedir(), flags: readonly string[] = []): string {
  const prefix = mode === "user" ? join(home, ".local/share/zelavis") : "/opt/zelavis";
  const instance = flags.includes("--instance") ? flags[flags.indexOf("--instance") + 1] : "default";
  const suffix = instance === "default" ? "" : `-${instance}`;
  const port = flags.includes("--port") ? flags[flags.indexOf("--port") + 1] : instance === "default" ? "3000" : "required for a new instance";
  return [`Instance: ${instance}; port: ${port}`, `Install Zelavis ${version} (${mode})`, "Fetch the pinned private Node from nodejs.org (SHA-256 verified) and the exact package from npm (registry digest verified).", `Release: ${prefix}/releases/${version}; ${instance === "default" ? "current" : `instances/${instance}/current`} selects that release.`, `Data: ${mode === "user" ? join(prefix, "data") : `/var/lib/zelavis${suffix}`}`, `Config: ${mode === "user" ? join(prefix, "config") : `/etc/zelavis${suffix}`}`, `Command: ${mode === "user" ? join(home, ".local/bin/zelavis") : "/usr/local/bin/zelavis"}`, mode === "user" ? "Run zelavis serve after installation. Uses private Node; no systemd, Agent or Edge." : "Start the systemd Platform on private Node. Agent is opt-in; Edge stays disabled."].join("\n");
}

export async function loadInstallerAssets(): Promise<{ version: string; script: string }> {
  const [versions, script] = await Promise.all([readFile(new URL("./versions.json", import.meta.url), "utf8"), readFile(new URL("./package-bootstrap.sh", import.meta.url), "utf8")]);
  return { version: (JSON.parse(versions) as { zelavis: string }).zelavis, script };
}

export async function executeInstallation(command: ReturnType<typeof installationCommand>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Installer exited ${signal ?? code}.`)));
  });
}
