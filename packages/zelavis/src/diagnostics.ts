/**
 * Read-only diagnostics for whoever debugs a running Platform: the questions that otherwise need a shell on
 * the server. Authority is `server.debug.read` in system scope (an API key can hold it without holding the
 * terminal). Nothing here changes anything, every answer is bounded, and command lines are redacted before
 * they leave the host.
 *
 * This file is runtime-neutral: the contract, the redaction and the reading of a process listing. The host
 * binding that obtains the listing lives in `adapters/_node-diagnostics.ts`.
 */

export const DIAGNOSTICS_MAX_PROCESSES = 500;
export const DIAGNOSTICS_MAX_COMMAND_CHARACTERS = 600;

export interface ZelavisProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly user: string;
  /** When it started, as the host reports it. */
  readonly startedAt: string;
  /** How long it has run, as `[[dd-]hh:]mm:ss`. */
  readonly elapsed: string;
  /** The Project whose folder the command line names, when it names one. */
  readonly projectId?: string;
  /** The command line with secrets removed, cut at a bounded length. */
  readonly command: string;
}

/** Processes that run the very same command side by side, none of them a child of another: a leftover copy. */
export interface ZelavisDuplicateProcesses {
  readonly command: string;
  readonly projectId?: string;
  readonly pids: readonly number[];
}

export interface ZelavisProcessReport {
  readonly generatedAt: string;
  /** Whose processes these are: the account the Platform runs as. */
  readonly user: string;
  readonly processes: readonly ZelavisProcessEntry[];
  readonly duplicates: readonly ZelavisDuplicateProcesses[];
  /** More matched than the bound allowed. */
  readonly truncated: boolean;
}

/** Everything worth reading about one Project in a single answer, so a debugging session starts from facts. */
export interface ZelavisProjectDiagnostics {
  readonly generatedAt: string;
  /** The Project record: lifecycle and runtime state, placement, the locked recipe, any unfinished update or deletion. */
  readonly project: Readonly<Record<string, unknown>>;
  /** The Project's own recent runtime log lines, oldest first. */
  readonly logs: readonly unknown[];
  /** The Platform log's recent entries that name this Project, oldest first. */
  readonly platformLog: readonly unknown[];
  /** This Project's processes on the Platform account, when the host can list them. */
  readonly processes: readonly ZelavisProcessEntry[];
  readonly duplicates: readonly ZelavisDuplicateProcesses[];
}

export const DIAGNOSTICS_PROJECT_LOG_LINES = 100;
export const DIAGNOSTICS_PLATFORM_LOG_ENTRIES = 50;

export interface ZelavisDiagnosticsControl {
  /** The Platform account's processes that belong to Zelavis (its data folder or its name in the command line). */
  processes(): Promise<ZelavisProcessReport>;
}

const SECRET_NAME = "(?:pass(?:word|wd)?|secret|token|api[-_]?key|private[-_]?key|credential|auth(?:orization)?)";
const REDACTED = "[redacted]";

/** Removes what a command line must not show: values of secret-looking flags and variables, and URL credentials. */
export function redactCommand(command: string): string {
  return command
    // --password=value, --password value, -p value is not guessed: only names that say what they hold.
    .replace(new RegExp(`(--?[A-Za-z0-9-]*${SECRET_NAME}[A-Za-z0-9-]*)(=|\\s+)(\\S+)`, "gi"), `$1$2${REDACTED}`)
    // NAME=value environment-style assignments.
    .replace(new RegExp(`\\b([A-Za-z0-9_]*${SECRET_NAME.replace(/\[-_\]/g, "_")}[A-Za-z0-9_]*)=(\\S+)`, "gi"), `$1=${REDACTED}`)
    // scheme://user:password@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`);
}

const LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(\S+)\s+(.*)$/;
const PROJECT_FOLDER = /\/projects\/([a-z0-9][a-z0-9_-]{0,127})(?:\/|\s|$)/;

/**
 * Reads `ps -o pid=,ppid=,user=,lstart=,etime=,args=` output and keeps what belongs to Zelavis: a command line that
 * names the data folder or "zelavis". A line that does not parse is skipped, not guessed at.
 */
export function readProcessListing(listing: string, scope: { readonly dataDirectory: string; readonly user: string; readonly now: Date }): ZelavisProcessReport {
  const wanted = (command: string) => command.includes(scope.dataDirectory) || /zelavis/i.test(command);
  const entries: ZelavisProcessEntry[] = [];
  let truncated = false;
  for (const line of listing.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, pid, parentPid, user, startedAt, elapsed, raw] = match as unknown as [string, string, string, string, string, string, string];
    if (!wanted(raw)) continue;
    if (entries.length >= DIAGNOSTICS_MAX_PROCESSES) { truncated = true; break; }
    const command = redactCommand(raw);
    const projectId = PROJECT_FOLDER.exec(raw)?.[1];
    entries.push({
      pid: Number(pid), parentPid: Number(parentPid), user, startedAt, elapsed,
      ...(projectId ? { projectId } : {}),
      command: command.length > DIAGNOSTICS_MAX_COMMAND_CHARACTERS ? `${command.slice(0, DIAGNOSTICS_MAX_COMMAND_CHARACTERS - 1)}…` : command,
    });
  }
  const byPid = new Map(entries.map(entry => [entry.pid, entry]));
  const processes = entries.map(entry => {
    const parent = byPid.get(entry.parentPid);
    return !entry.projectId && parent?.projectId && /_node-runtime-worker\.js(?:\s|$)/.test(entry.command)
      ? { ...entry, projectId: parent.projectId } : entry;
  });
  return { generatedAt: scope.now.toISOString(), user: scope.user, processes, duplicates: findDuplicates(processes), truncated };
}

/** Same command, more than one root: a worker pool's children share their parent and are not a duplicate. */
export function findDuplicates(entries: readonly ZelavisProcessEntry[]): readonly ZelavisDuplicateProcesses[] {
  const groups = new Map<string, ZelavisProcessEntry[]>();
  for (const entry of entries) {
    const key = `${entry.projectId ?? ""}\u0000${entry.command}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const duplicates: ZelavisDuplicateProcesses[] = [];
  for (const group of groups.values()) {
    const pids = new Set(group.map((entry) => entry.pid));
    const roots = group.filter((entry) => !pids.has(entry.parentPid));
    if (roots.length > 1) {
      duplicates.push({ command: roots[0]!.command, ...(roots[0]!.projectId ? { projectId: roots[0]!.projectId } : {}), pids: roots.map((entry) => entry.pid) });
    }
  }
  return duplicates;
}
