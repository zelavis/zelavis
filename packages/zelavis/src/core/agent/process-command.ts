/**
 * The Agent's command contract for supervised processes.
 *
 * The Agent already had a command contract for host operations —
 * `ZelavisHostOperationExecutor` — but that one describes a short, registered,
 * digest-pinned program: run it, collect its output, report an exit code. A
 * Project runtime is the other shape entirely: it starts, announces readiness
 * on its own stdout, serves traffic for as long as the Platform wants it, and
 * has to be stopped in a way that gives it a chance to finish first.
 *
 * Until now every driver that ran one wrote that supervision itself. Three did:
 * the Node Project runtime, the server frontend runtime, and the native
 * WordPress runtime, each with its own `spawn`, its own line splitting, its own
 * SIGTERM-then-SIGKILL escalation, and its own idea of what happens to a child
 * when the Platform process exits — two of them had no answer to that last one
 * at all, so a Platform crash left their children running.
 *
 * This is the contract those three now issue commands through. Making it one
 * contract before there is a remote Agent is the point: the local runner is the
 * first implementation of it rather than the thing a remote Agent will later
 * have to be retrofitted around. A driver that asks an Agent to start a process
 * does not know or care whether that Agent is this process or another machine's.
 *
 * What it deliberately does not describe: artifact resolution, authority, or
 * leases. Those belong to the operation journal the Agent already has, and a
 * remote runner will need them — but inventing them here, with only a local
 * implementation to test against, would be designing a protocol against no
 * counterpart.
 */

/** What to run. */
export interface ZelavisAgentProcessCommand {
  /**
   * What this process belongs to.
   *
   * A Project id today. Named for the workload rather than the Project because
   * the Agent runs whatever it is told to; the Project is the caller's concept.
   */
  readonly workloadId: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /**
   * The complete environment. Not merged with the host's.
   *
   * Inheriting `process.env` wholesale would hand a Project the Platform's
   * bootstrap token, provider credentials, and signing keys. Callers assemble
   * exactly what the process needs; an empty record means an empty environment.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface ZelavisAgentProcessOutput {
  readonly stream: "stdout" | "stderr";
  /** One line, without its terminator. */
  readonly line: string;
}

export interface ZelavisAgentProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  /**
   * Whether the Platform asked for this exit.
   *
   * A driver reports a Project that stopped on request differently from one
   * that fell over, and it cannot tell the two apart from the exit code alone —
   * a process killed by SIGTERM looks like a crash.
   */
  readonly requested: boolean;
}

export interface ZelavisAgentProcessStartOptions {
  /**
   * Called once per complete line of output.
   *
   * Lines rather than chunks because every caller needed lines and each was
   * reassembling them differently. A line longer than the runner's cap is
   * dropped and reported as a `system` note by the caller, since no readiness
   * event is that large and an unbounded buffer is a memory leak with a
   * misbehaving child at the other end.
   */
  readonly onOutput?: (output: ZelavisAgentProcessOutput) => void;
  /** Called when the process exits, before `exit` resolves. */
  readonly onExit?: (exit: ZelavisAgentProcessExit) => void;
}

export interface ZelavisAgentProcess {
  readonly workloadId: string;
  /** False once the process has exited. */
  readonly running: boolean;
  readonly exit: Promise<ZelavisAgentProcessExit>;
  /**
   * Asks the process to stop, escalating if it does not.
   *
   * Resolves once it has actually exited, so a caller that stops and then
   * reports "stopped" is not describing a process that is still running.
   */
  stop(options?: { readonly graceMs?: number }): Promise<ZelavisAgentProcessExit>;
}

export interface ZelavisAgentProcessRunner {
  /** Identifies the execution boundary, for honest capability reporting. */
  readonly name: string;
  start(
    command: ZelavisAgentProcessCommand,
    options?: ZelavisAgentProcessStartOptions,
  ): Promise<ZelavisAgentProcess>;
  /** Stops everything this runner started. */
  close(): Promise<void>;
}
