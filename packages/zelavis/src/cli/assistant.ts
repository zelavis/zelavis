import { bodyFlag, integerFlag, required, runTable, type CliTable } from "./command-table.js";
import type { ZelavisAssistantEvent } from "../sdk/fetch.js";

const usage =
  "zelavis assistant <audit|provider|set-provider|clear-provider|project-provider|set-project-provider|clear-project-provider|threads|create-thread|thread|delete-thread|send|stream|decide> [id] [text|approval-id] [--data JSON] [--project ID] [--title TEXT] [--decision approve|deny] [--confirm ID] [--limit N] [--before CURSOR] [--principal ID] [--tool NAME] [--audit-decision D] [--url URL] [--token TOKEN] [--json]";

const table: CliTable = {
  name: "assistant",
  usage,
  valued: ["--data", "--project", "--title", "--decision", "--confirm", "--limit", "--before", "--principal", "--tool", "--audit-decision"],
  actions: {
    audit: {
      run: (input) => input.client.assistant.audit({
        ...(integerFlag(input, "--limit") === undefined ? {} : { limit: integerFlag(input, "--limit")! }),
        ...(input.flags.has("--before") ? { before: input.flags.get("--before")! } : {}),
        ...(input.flags.has("--principal") ? { principalId: input.flags.get("--principal")! } : {}),
        ...(input.flags.has("--tool") ? { tool: input.flags.get("--tool")! } : {}),
        ...(input.flags.has("--audit-decision") ? { decision: input.flags.get("--audit-decision")! } : {}),
      }),
    },
    provider: { run: (input) => input.client.assistant.provider() },
    "set-provider": { run: (input) => input.client.assistant.setProvider(bodyFlag(input, "--data", "assistant set-provider")) },
    "clear-provider": { run: (input) => input.client.assistant.clearProvider() },
    "project-provider": { run: (input) => input.client.assistant.projectProvider(required(input, 0, "A Project id")) },
    "set-project-provider": { run: (input) => input.client.assistant.setProjectProvider(required(input, 0, "A Project id"), bodyFlag(input, "--data", "assistant set-project-provider")) },
    "clear-project-provider": { run: (input) => input.client.assistant.clearProjectProvider(required(input, 0, "A Project id")) },
    threads: { run: (input) => input.client.assistant.threads(input.flags.has("--project") ? { projectId: input.flags.get("--project")! } : undefined) },
    "create-thread": {
      run: (input) => input.client.assistant.createThread({
        ...(input.flags.has("--title") ? { title: input.flags.get("--title")! } : {}),
        ...(input.flags.has("--project") ? { projectId: input.flags.get("--project")! } : {}),
      }),
    },
    thread: { run: (input) => input.client.assistant.thread(required(input, 0, "A thread id")) },
    "delete-thread": { run: (input) => input.client.assistant.deleteThread(required(input, 0, "A thread id")) },
    send: { run: (input) => input.client.assistant.sendMessage(required(input, 0, "A thread id"), required(input, 1, "The message")) },
    stream: {
      run: async (input) => {
        const events: ZelavisAssistantEvent[] = [];
        for await (const event of input.client.assistant.streamMessage(required(input, 0, "A thread id"), required(input, 1, "The message"))) events.push(event);
        return events;
      },
      text: (events: readonly ZelavisAssistantEvent[]) => events.map((entry) => entry.event === "text" ? String((entry.data as { text?: string })?.text ?? entry.data) : `[${entry.event}] ${JSON.stringify(entry.data)}`).join(""),
    },
    decide: {
      run: (input) => {
        const decision = input.flags.get("--decision");
        if (decision !== "approve" && decision !== "deny") throw new Error("assistant decide requires --decision approve or --decision deny.");
        return input.client.assistant.decide(required(input, 0, "A thread id"), required(input, 1, "An approval id"), { decision, ...(input.flags.has("--confirm") ? { confirm: input.flags.get("--confirm")! } : {}) });
      },
    },
  },
};

/** `zelavis assistant` — the Assistant's threads, replies, approvals, providers and audit trail, through the SDK client. */
export function runAssistantCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
