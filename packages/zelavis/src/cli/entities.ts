import type { EntityMessage, EntityState } from "../db/entities.js";
import { bodyFlag, integerFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";

const usage =
  "zelavis entities <send|message|cancel|state|mailbox|list> --project ID <type> [id] [message-key] [--tag TAG] [--data JSON] [--primary-key KEY] [--deliver-at ISO] [--tenant ID] [--after CURSOR] [--limit N] [--url URL] [--token TOKEN] [--json]";

const entities = (input: CliInput) =>
  input.client.data(required({ ...input, positional: [input.flags.get("--project") ?? ""] }, 0, "entities commands need --project")).entities;
const type = (input: CliInput) => required(input, 0, "An entity type");
const id = (input: CliInput) => required(input, 1, "An entity id");
const tenant = (input: CliInput) => (input.flags.has("--tenant") ? { tenantId: input.flags.get("--tenant")! } : {});
const page = (input: CliInput) => {
  const limit = integerFlag(input, "--limit");
  return { ...(input.flags.has("--after") ? { after: input.flags.get("--after")! } : {}), ...(limit === undefined ? {} : { limit }) };
};
const line = (message: EntityMessage) =>
  `${message.messageKey}\t${message.tag}\t${message.status}\tattempts ${message.attempts}` +
  (message.lastError === undefined ? "" : `\t${message.lastError}`) + (message.reply === undefined ? "" : `\treply ${JSON.stringify(message.reply)}`);
const stateLine = (state: EntityState) => `${state.id}\tpending ${state.pending}\tprocessed ${state.processed}\tfailed ${state.failed}\t${JSON.stringify(state.state)}`;

const table: CliTable = {
  name: "entities",
  usage,
  valued: ["--project", "--tag", "--data", "--primary-key", "--deliver-at", "--tenant", "--after", "--limit"],
  actions: {
    send: {
      run: (input) => entities(input).send({
        type: type(input), id: id(input),
        tag: required({ ...input, positional: [input.flags.get("--tag") ?? ""] }, 0, "--tag"),
        payload: input.flags.has("--data") ? bodyFlag(input, "--data", "entities send") : {},
        ...(input.flags.has("--primary-key") ? { primaryKey: input.flags.get("--primary-key")! } : {}),
        ...(input.flags.has("--deliver-at") ? { deliverAt: input.flags.get("--deliver-at")! } : {}),
        ...tenant(input),
      }),
      text: (result: { message: EntityMessage; duplicate: boolean }) =>
        `${result.duplicate ? "Already sent" : "Sent"}: ${line(result.message)}`,
    },
    message: {
      run: (input) => entities(input).message({ type: type(input), id: id(input), messageKey: required(input, 2, "A message key"), ...tenant(input) }),
      text: line,
    },
    cancel: {
      run: (input) => entities(input).cancel({ type: type(input), id: id(input), messageKey: required(input, 2, "A message key"), ...tenant(input) }),
      text: (result: { cancelled: boolean; message?: EntityMessage }) =>
        result.cancelled ? "Cancelled." : `Not cancelled${result.message === undefined ? ": no such message" : `: it is ${result.message.status}`}.`,
    },
    state: {
      run: (input) => entities(input).state({ type: type(input), id: id(input), ...tenant(input) }),
      text: stateLine,
    },
    mailbox: {
      run: (input) => entities(input).mailbox({ type: type(input), id: id(input), ...page(input), ...tenant(input) }),
      text: (result: { messages: readonly EntityMessage[]; next?: string }) =>
        [...result.messages.map(line), ...(result.next === undefined ? [] : [`next\t${result.next}`])].join("\n") || "Nothing owed.",
    },
    list: {
      run: (input) => entities(input).list({ type: type(input), ...page(input), ...tenant(input) }),
      text: (result: { entities: readonly EntityState[]; next?: string }) =>
        [...result.entities.map(stateLine), ...(result.next === undefined ? [] : [`next\t${result.next}`])].join("\n") || "No entities of this type.",
    },
  },
};

/**
 * `zelavis entities` — durable entities in an App Project's database, through the SDK client, so the CLI cannot drift
 * from `client.data(projectId).entities`.
 */
export function runEntitiesCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
