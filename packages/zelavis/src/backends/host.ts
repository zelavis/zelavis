/**
 * Read-only host probes a backend adapter uses for detection.
 *
 * Backend identity, capability and policy stay runtime-neutral; the concrete
 * filesystem and command access belongs to a runtime adapter
 * (`src/adapters/_node-backend-host.ts` for Node) that supplies these. A probe
 * reports what it observed and never installs, configures or elevates.
 */
export interface ZelavisBackendHostProbes {
  /** Host operating system as the runtime reports it (`linux`, `darwin`, `win32`). */
  readonly platform: string;
  pathExists(path: string): Promise<boolean>;
  /** Resolves `undefined` when the file cannot be read. */
  readTextFile(path: string): Promise<string | undefined>;
  /** Runs a fixed read-only probe without a shell, stdin, or unbounded output. */
  runProbeCommand(
    executable: string,
    args: readonly string[],
  ): Promise<ZelavisBackendProbeCommandResult>;
}

export interface ZelavisBackendProbeCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The executable was not found. */
  readonly missing: boolean;
  readonly timedOut: boolean;
}
