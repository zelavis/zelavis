/**
 * A terminal on the server, from the dashboard.
 *
 * Authority. A terminal is a shell as the account the Platform runs as, which is
 * unprivileged (never root) but can read what the Platform reads. So it is the
 * owner's, not a convenience: `server.terminal.use` in system scope, off for every
 * other role, and a session belongs to the principal that opened it (another
 * principal's session is "not found", never "forbidden"). Opening and closing are
 * written to the Platform log with the principal; what is typed and what is
 * printed are never recorded.
 *
 * The shell runs inside tmux, so it survives a closed tab and a Platform restart
 * and can be picked up again; tmux is also what keeps this free of a native
 * pseudo-terminal dependency. Everything is bounded: sessions, input per call,
 * output per read, and idle time.
 *
 * This file is runtime-neutral: contract and limits. The tmux binding lives in
 * `adapters/_node-terminal.ts`.
 */

export const TERMINAL_MAX_SESSIONS = 8;
export const TERMINAL_MAX_SESSIONS_PER_OWNER = 4;
export const TERMINAL_MAX_INPUT_BYTES = 16 * 1024;
export const TERMINAL_MAX_OUTPUT_BYTES = 64 * 1024;
export const TERMINAL_IDLE_MS = 30 * 60_000;
export const TERMINAL_MIN_SIZE = 10;
export const TERMINAL_MAX_COLUMNS = 400;
export const TERMINAL_MAX_ROWS = 200;

export interface ZelavisTerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface ZelavisTerminalStatus {
  /** Whether sessions can be opened on this server now. */
  readonly available: boolean;
  /** Why not, in plain words, when it is not available. */
  readonly reason?: string;
  readonly maxSessions: number;
}

export interface ZelavisTerminalSession {
  readonly id: string;
  readonly createdAt: string;
  /** The last time input or output was read; an idle session is closed. */
  readonly lastActiveAt: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ZelavisTerminalOutput {
  /** Bytes the terminal printed, base64, at most `TERMINAL_MAX_OUTPUT_BYTES` before encoding. */
  readonly data: string;
  /** Opaque; pass it as `after` to read what follows. */
  readonly cursor: string;
  /**
   * The reader's place was lost (first read, or the stream moved on), so `data` begins with
   * the current screen and history: clear the display before writing it.
   */
  readonly reset: boolean;
  /** More output is waiting right now; read again without pausing. */
  readonly more: boolean;
}

export type ZelavisTerminalRefusalCode = "unavailable" | "not-found" | "limit" | "invalid";

/** A refusal with a reason a person can act on; the routes map `code` to a status. */
export class ZelavisTerminalRefusal extends Error {
  readonly code: ZelavisTerminalRefusalCode;
  constructor(code: ZelavisTerminalRefusalCode, message: string) {
    super(message);
    this.name = "ZelavisTerminalRefusal";
    this.code = code;
  }
}

/** Every method takes the owner (the principal id) first; sessions are visible only to it. */
export interface ZelavisTerminalControl {
  status(): Promise<ZelavisTerminalStatus>;
  list(owner: string): Promise<readonly ZelavisTerminalSession[]>;
  open(owner: string, size: ZelavisTerminalSize): Promise<ZelavisTerminalSession>;
  /** Types `data` (text, including control characters) into the session. */
  write(owner: string, id: string, data: string): Promise<void>;
  read(owner: string, id: string, after?: string): Promise<ZelavisTerminalOutput>;
  resize(owner: string, id: string, size: ZelavisTerminalSize): Promise<void>;
  close(owner: string, id: string): Promise<void>;
  /** Stops background upkeep; sessions themselves keep running in tmux. */
  stop(): void;
}

export function isTerminalSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/** The size a client asks for, or the refusal that names the limit. */
export function checkTerminalSize(value: unknown): ZelavisTerminalSize {
  const size = value as { cols?: unknown; rows?: unknown } | null | undefined;
  const cols = size?.cols;
  const rows = size?.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)
    || (cols as number) < TERMINAL_MIN_SIZE || (cols as number) > TERMINAL_MAX_COLUMNS
    || (rows as number) < TERMINAL_MIN_SIZE || (rows as number) > TERMINAL_MAX_ROWS) {
    throw new ZelavisTerminalRefusal("invalid", `A terminal is ${TERMINAL_MIN_SIZE}-${TERMINAL_MAX_COLUMNS} columns by ${TERMINAL_MIN_SIZE}-${TERMINAL_MAX_ROWS} rows.`);
  }
  return { cols: cols as number, rows: rows as number };
}
