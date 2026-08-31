import { spawn } from "node:child_process";

const COMMAND_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 256 * 1024;

export interface BackendCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly missing: boolean;
  readonly timedOut: boolean;
}

/** Runs a fixed read-only backend probe without a shell or inherited stdin. */
export async function runBackendProbeCommand(
  executable: string,
  args: readonly string[],
): Promise<BackendCommandResult> {
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
