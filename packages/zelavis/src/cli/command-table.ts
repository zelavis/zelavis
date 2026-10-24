import { Effect } from "effect";
import { integrationValue, present, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { createZelavisClient, type ZelavisClient } from "../sdk/fetch.js";

/** What an action of a table-driven command is given: its arguments, its flags, and the SDK client it must go through. */
export interface CliInput {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly client: ZelavisClient;
}

export interface CliAction {
  /** Runs through the SDK client, so the CLI cannot drift from `client.*`; the answer is printed as the SDK returned it. */
  run(input: CliInput): Promise<unknown>;
  /** A human rendering; without one, or with `--json`, the answer is printed as JSON. */
  text?(result: any): string;
}

export interface CliTable {
  /** The command's name, for messages. */
  readonly name: string;
  readonly usage: string;
  /** Flags that take a value, besides `--url` and `--token`, which every command has. */
  readonly valued: readonly string[];
  /** Flags that are present or not, besides `--json`. */
  readonly switches?: readonly string[];
  readonly actions: Readonly<Record<string, CliAction>>;
}

/** A positional argument that the action cannot do without. */
export function required(input: CliInput, position: number, what: string): string {
  const value = input.positional[position];
  if (value === undefined || value === "") throw new Error(`${what} is required.`);
  return value;
}

/** A flag whose value is JSON, parsed; absent when not given. */
export function jsonFlag(input: CliInput, flag: string): unknown {
  const value = input.flags.get(flag);
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { throw new Error(`${flag} requires JSON.`); }
}

/** A flag whose value is JSON, which must be an object. */
/** The flag's JSON object. The route validates it, so the caller only claims the shape its call site expects. */
export function bodyFlag<Shape = Record<string, unknown>>(input: CliInput, flag: string, action: string): Shape {
  const value = jsonFlag(input, flag);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${action} requires ${flag} with a JSON object.`);
  return value as Shape;
}

export function integerFlag(input: CliInput, flag: string): number | undefined {
  const value = input.flags.get(flag);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${flag} requires an integer.`);
  return number;
}

/**
 * Runs a command made of a table of actions: the arguments are parsed, the SDK client is made from `--url` and `--token`, the
 * named action runs, and its answer is printed. A new area is a table, not another copy of the argument parser.
 */
export function runTable(table: CliTable, args: readonly string[]): Promise<void> {
  return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    const positional: string[] = [];
    const flags = new Map<string, string>();
    const switches = new Set<string>();
    const valued = new Set(["--url", "--token", ...table.valued]);
    const known = new Set(["--json", ...(table.switches ?? [])]);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--help" || arg === "-h") { console.log(table.usage); return; }
      if (!arg.startsWith("-")) { positional.push(arg); continue; }
      const separator = arg.indexOf("=");
      const flag = separator === -1 ? arg : arg.slice(0, separator);
      if (known.has(flag)) { switches.add(flag); continue; }
      if (!valued.has(flag)) throw new Error(`Unknown ${table.name} option "${arg}". ${table.usage}`);
      const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
      if (value === undefined || value === "") throw new Error(`${flag} requires a value.`);
      if (flags.has(flag)) throw new Error(`${flag} was given twice.`);
      flags.set(flag, value);
    }
    const [name, ...rest] = positional;
    if (name === undefined) { console.log(table.usage); return; }
    const action = table.actions[name];
    if (action === undefined) throw new Error(`Unknown ${table.name} command "${name}". ${table.usage}`);
    const base = new URL(flags.get("--url") ?? "http://localhost:3000/zelavis");
    const token = flags.get("--token");
    const client = createZelavisClient({ baseUrl: base.origin, rootPath: base.pathname, headers: token ? { authorization: `Bearer ${token}` } : undefined });
    const result = yield* integrationValue(action.run({ positional: rest, flags, switches, client }));
    console.log(switches.has("--json") || action.text === undefined ? JSON.stringify(result, null, 2) : action.text(result));
  }));
}
