import { bodyFlag, integerFlag, required, runTable, type CliTable } from "./command-table.js";

const usage =
  "zelavis environment <identity|health|create-session|update-session|session|close-session|usage|start-process|process|operate-process|events> [session-id|process-id] [--data JSON] [--after CURSOR] [--limit N] [--url URL] [--token TOKEN] [--json]";

const table: CliTable = {
  name: "environment",
  usage,
  valued: ["--data", "--after", "--limit"],
  actions: {
    identity: { run: (input) => input.client.environment.identity() },
    health: { run: (input) => input.client.environment.health() },
    "create-session": { run: (input) => input.client.environment.createSession(input.flags.has("--data") ? bodyFlag(input, "--data", "environment create-session") as never : undefined) },
    "update-session": { run: (input) => input.client.environment.updateSession(required(input, 0, "A session id"), bodyFlag(input, "--data", "environment update-session") as never) },
    session: { run: (input) => input.client.environment.getSession(required(input, 0, "A session id")) },
    "close-session": { run: (input) => input.client.environment.closeSession(required(input, 0, "A session id")) },
    usage: { run: (input) => input.client.environment.recordUsage(required(input, 0, "A session id"), bodyFlag(input, "--data", "environment usage") as never) },
    "start-process": { run: (input) => input.client.environment.startProcess(required(input, 0, "A session id"), bodyFlag(input, "--data", "environment start-process") as never) },
    process: { run: (input) => input.client.environment.getProcess(required(input, 0, "A process id")) },
    "operate-process": { run: (input) => input.client.environment.operateProcess(required(input, 0, "A process id"), bodyFlag(input, "--data", "environment operate-process") as never) },
    events: {
      run: (input) => input.client.environment.readEvents(required(input, 0, "A session id"), {
        ...(input.flags.has("--after") ? { after: input.flags.get("--after")! } : {}),
        ...(integerFlag(input, "--limit") === undefined ? {} : { limit: integerFlag(input, "--limit")! }),
      }),
    },
  },
};

/** `zelavis environment` — remote environment sessions and their processes, through the SDK client. */
export function runEnvironmentCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
