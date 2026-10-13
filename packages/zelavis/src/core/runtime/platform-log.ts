import { redactText } from "../../assistant-redaction.js";

/**
 * The Platform's own recent log: what the process wrote about itself, kept so an
 * operator can read it from the dashboard, the CLI or a script without a shell.
 *
 * Authority and limits. The log is memory only and bounded: the newest
 * `capacity` entries survive, each message and detail is cut to a fixed size,
 * and everything is redacted when written, never when read. It is a debugging
 * aid, not an audit trail: a restart empties it, and the process's stderr (the
 * service journal) is the durable copy. Entries carry a strictly increasing
 * `sequence`, so a reader continues with `after` and can tell when it fell
 * behind (`truncated`).
 */
export type PlatformLogLevel = "debug" | "info" | "warn" | "error";

export interface PlatformLogEntry {
  readonly sequence: number;
  readonly at: string;
  readonly level: PlatformLogLevel;
  /** Which part of the Platform wrote it, such as `http` or `project:blog`. */
  readonly source: string;
  readonly message: string;
  /** The reference a client received with a generic error; joins a report to its cause. */
  readonly correlationId?: string;
  /** Stack or further detail, redacted and bounded. */
  readonly detail?: string;
}

export interface PlatformLogRecord {
  readonly level: PlatformLogLevel;
  readonly source: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly detail?: string;
}

export interface PlatformLogQuery {
  /** Only entries newer than this sequence. */
  readonly after?: number;
  readonly limit?: number;
  /** Entries at this level or more severe. */
  readonly level?: PlatformLogLevel;
  readonly correlationId?: string;
  readonly source?: string;
}

export interface PlatformLogPage {
  readonly entries: readonly PlatformLogEntry[];
  /** The highest sequence ever written; pass it as `after` to follow. */
  readonly latest: number;
  /** Entries between `after` and the oldest one kept were dropped. */
  readonly truncated: boolean;
}

export interface PlatformLog {
  readonly record: (entry: PlatformLogRecord) => void;
  readonly read: (query?: PlatformLogQuery) => PlatformLogPage;
}

export const PLATFORM_LOG_CAPACITY = 2000;
export const PLATFORM_LOG_DEFAULT_LIMIT = 200;
export const PLATFORM_LOG_MAX_LIMIT = 1000;
const MESSAGE_MAX = 2000;
const DETAIL_MAX = 8000;
const SOURCE_MAX = 120;
const SEVERITY: Record<PlatformLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function isPlatformLogLevel(value: unknown): value is PlatformLogLevel {
  return typeof value === "string" && Object.hasOwn(SEVERITY, value);
}

const bounded = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** An error's name, message and stack as one bounded, redacted detail text. */
export function describeFailure(error: unknown): { message: string; detail: string | undefined } {
  if (error instanceof Error) {
    const stack = error.stack && error.stack.startsWith(error.name) ? error.stack : `${error.name}: ${error.message}\n${error.stack ?? ""}`;
    const cause = error.cause !== undefined ? `\ncaused by: ${error.cause instanceof Error ? (error.cause.stack ?? error.cause.message) : String(error.cause)}` : "";
    return { message: `${error.name}: ${error.message}`, detail: `${stack}${cause}` };
  }
  return { message: String(error), detail: undefined };
}

export function createPlatformLog(capacity: number = PLATFORM_LOG_CAPACITY): PlatformLog {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("Platform log capacity must be a positive integer.");
  const entries: PlatformLogEntry[] = [];
  let sequence = 0;

  return {
    record: (input) => {
      sequence += 1;
      const entry: PlatformLogEntry = {
        sequence,
        at: new Date().toISOString(),
        level: input.level,
        source: bounded(redactText(input.source), SOURCE_MAX),
        message: bounded(redactText(input.message), MESSAGE_MAX),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId.slice(0, 64) }),
        ...(input.detail === undefined ? {} : { detail: bounded(redactText(input.detail), DETAIL_MAX) }),
      };
      entries.push(entry);
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    read: (query = {}) => {
      const after = query.after ?? 0;
      const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? PLATFORM_LOG_DEFAULT_LIMIT)), PLATFORM_LOG_MAX_LIMIT);
      const floor = query.level === undefined ? 0 : SEVERITY[query.level];
      const matching = entries.filter((entry) =>
        entry.sequence > after
        && SEVERITY[entry.level] >= floor
        && (query.correlationId === undefined || entry.correlationId === query.correlationId)
        && (query.source === undefined || entry.source === query.source));
      const oldest = entries[0]?.sequence ?? sequence + 1;
      return {
        // Newest last when following, so the page is the limit's worth just after `after`.
        entries: after > 0 ? matching.slice(0, limit) : matching.slice(-limit),
        latest: sequence,
        truncated: after > 0 && oldest > after + 1,
      };
    },
  };
}

/**
 * Parses `GET runtime/logs` query parameters. A string result is the reason the
 * query is refused, so every transport answers the same way.
 */
export function readPlatformLogQuery(params: URLSearchParams): PlatformLogQuery | string {
  const integer = (name: string): number | undefined | string => {
    const raw = params.get(name);
    if (raw === null || raw === "") return undefined;
    return /^\d{1,15}$/.test(raw) ? Number(raw) : `${name} must be a non-negative integer.`;
  };
  const after = integer("after");
  if (typeof after === "string") return after;
  const limit = integer("limit");
  if (typeof limit === "string") return limit;
  const level = params.get("level") ?? undefined;
  if (level !== undefined && !isPlatformLogLevel(level)) return "level must be debug, info, warn or error.";
  const correlationId = params.get("correlationId") ?? undefined;
  if (correlationId !== undefined && !/^[0-9a-f]{1,64}$/.test(correlationId)) return "correlationId must be hexadecimal.";
  const source = params.get("source") ?? undefined;
  if (source !== undefined && source.length > SOURCE_MAX) return "source is too long.";
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
    ...(level === undefined ? {} : { level }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * Records every unexpected request failure with its reference, and writes the
 * same line to stderr so the service journal keeps it past a restart. Only the
 * method and path are logged for the request, never its query or headers.
 */
export function platformLogPlugin(log: PlatformLog) {
  return ({ hooks }: { hooks: { hook: (name: "error", handler: (event: { error: unknown; request: Request; correlationId?: string }) => void) => () => void } }) =>
    hooks.hook("error", ({ error, request, correlationId }) => {
      const { message, detail } = describeFailure(error);
      const target = (() => { try { return new URL(request.url).pathname; } catch { return "(unparseable)"; } })();
      log.record({
        level: "error",
        source: "http",
        message: `${request.method} ${target} failed: ${message}`,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(detail === undefined ? {} : { detail }),
      });
      console.error(`[zelavis] error ${correlationId ?? "-"} ${request.method} ${redactText(target)}: ${redactText(message)}`);
    });
}
