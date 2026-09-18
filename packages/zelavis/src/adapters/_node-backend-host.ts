import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import type {
  ZelavisBackendHostProbes,
  ZelavisBackendProbeCommandResult,
} from "../backends/host.js";

const COMMAND_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 256 * 1024;

/** Runs a fixed read-only backend probe without a shell or inherited stdin. */
async function runBackendProbeCommand(
  executable: string,
  args: readonly string[],
): Promise<ZelavisBackendProbeCommandResult> {
  return new Promise((resolveRun) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let missing = false;
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(0, OUTPUT_LIMIT);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      missing = error.code === "ENOENT";
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stdout, stderr, missing, timedOut });
    });
  });
}

/** Node binding for backend detection probes. */
export function createNodeBackendHostProbes(): ZelavisBackendHostProbes {
  return Object.freeze({
    platform: process.platform,
    pathExists: (path: string) => access(path).then(() => true, () => false),
    readTextFile: (path: string) =>
      readFile(path, "utf8").then((value) => value, () => undefined),
    runProbeCommand: runBackendProbeCommand,
  });
}
