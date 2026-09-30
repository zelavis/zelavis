import type { ZelavisPrincipal } from "./core/index.js";
import type {
  ZelavisSystemStore,
  ZelavisSystemStoreValue,
} from "./system-store.js";

export interface ZelavisAssistantAction {
  label: string;
  to: string;
}

export interface ZelavisAssistantMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  actions?: readonly ZelavisAssistantAction[];
  /** What the Assistant looked up to answer, so the reply can show its work. */
  activity?: readonly ZelavisAssistantActivity[];
  /** Changes this reply asked to make; their state lives with each approval. */
  approvalIds?: readonly string[];
  /** Which provider and model wrote this reply, since a thread can outlive a setting. */
  provider?: string;
  createdAt: string;
}

export interface ZelavisAssistantThread {
  id: string;
  /** The principal that started the thread; the only one that may read or extend it. */
  ownerId: string;
  title: string;
  projectId?: string;
  messages: readonly ZelavisAssistantMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ZelavisAssistantReply {
  content: string;
  activity?: readonly ZelavisAssistantActivity[];
  approvalIds?: readonly string[];
  actions?: readonly ZelavisAssistantAction[];
  /** Which provider and model wrote it; recorded with the message. */
  provider?: string;
}

/** Progress a responder can report while it works. */
export type ZelavisAssistantStreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool";
      /** Ties a call's `running` and final events together. */
      readonly id: string;
      readonly name: string;
      /** What the call is doing, in the operator's words. */
      readonly label: string;
      readonly status: "running" | "done" | "refused" | "awaiting";
    }
  | {
      /** A change was requested and waits for a person's decision. */
      readonly type: "approval";
      readonly id: string;
      readonly label: string;
      readonly irreversible: boolean;
      readonly target: { readonly kind: string; readonly id: string };
    };

/** One tool call as shown in chat, kept with the message it belongs to. */
export interface ZelavisAssistantActivity {
  readonly label: string;
  readonly status: "done" | "refused" | "awaiting";
}

export interface ZelavisAssistantResponder {
  readonly name: string;
  respond(input: {
    thread: ZelavisAssistantThread;
    prompt: string;
    /**
     * The caller's own authority. A responder acts with it and never with
     * authority of its own; it is not persisted with the thread.
     */
    principal: ZelavisPrincipal;
    /** Report progress as it happens. Optional; the final reply is authoritative. */
    onEvent?: (event: ZelavisAssistantStreamEvent) => void;
    /** Aborted when the caller goes away; a responder should stop working. */
    signal?: AbortSignal;
  }): Promise<ZelavisAssistantReply> | ZelavisAssistantReply;
}

export interface ZelavisAssistantManager {
  readonly responder: string;
  /** Only the owner's threads; other principals' threads are never listed. */
  list(ownerId: string, projectId?: string): Promise<readonly ZelavisAssistantThread[]>;
  /** `undefined` for a missing thread and for one another principal owns. */
  get(id: string, ownerId: string): Promise<ZelavisAssistantThread | undefined>;
  deleteProjectThreads(
    projectId: string,
    onDeleted?: (threadId: string) => Promise<unknown>,
  ): Promise<number>;
  /** Deletes one of the owner's threads. `false` when there is none (or it is not theirs). */
  delete(id: string, ownerId: string): Promise<boolean>;
  /**
   * Adds an assistant message without asking the responder, for the result of
   * something a person decided (an approved or denied change).
   */
  recordOutcome(
    id: string,
    ownerId: string,
    message: { content: string; activity?: readonly ZelavisAssistantActivity[] },
  ): Promise<{ thread: ZelavisAssistantThread; message: ZelavisAssistantMessage }>;
  create(
    ownerId: string,
    input?: {
      title?: string;
      projectId?: string;
    },
  ): Promise<ZelavisAssistantThread>;
  appendMessage(
    id: string,
    prompt: string,
    principal: ZelavisPrincipal,
    options?: {
      onEvent?: (event: ZelavisAssistantStreamEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<{
    thread: ZelavisAssistantThread;
    userMessage: ZelavisAssistantMessage;
    assistantMessage: ZelavisAssistantMessage;
  }>;
}

export class ZelavisAssistantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisAssistantValidationError";
  }
}

export class ZelavisAssistantNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisAssistantNotFoundError";
  }
}

const ASSISTANT_THREADS_NAMESPACE = "assistant-threads";

/** A prompt is a sentence or a paragraph, not a document; it is stored and re-sent on every turn. */
export const ASSISTANT_MAX_PROMPT_CHARS = 8_000;
export const ASSISTANT_MAX_THREADS_PER_OWNER = 200;
export const ASSISTANT_MAX_MESSAGES_PER_THREAD = 400;

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}

function toStoreValue(thread: ZelavisAssistantThread): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(thread)) as ZelavisSystemStoreValue;
}

function parseStoredThread(value: ZelavisSystemStoreValue): ZelavisAssistantThread {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ZelavisAssistantValidationError("Stored Assistant thread is invalid.");
  }
  return JSON.parse(JSON.stringify(value)) as ZelavisAssistantThread;
}

export function createAssistantManager(options: {
  store: ZelavisSystemStore;
  responder?: ZelavisAssistantResponder;
}): ZelavisAssistantManager {
  const { store } = options;
  const responder = options.responder ?? createLocalAssistantResponder();

  async function read(id: string): Promise<ZelavisAssistantThread | undefined> {
    const normalizedId = normalizeOptionalText(id);
    if (!normalizedId) {
      throw new ZelavisAssistantValidationError("Assistant thread id is required.");
    }
    const record = await store.get(ASSISTANT_THREADS_NAMESPACE, normalizedId);
    return record ? parseStoredThread(record.value) : undefined;
  }

  async function readOwned(id: string, ownerId: string) {
    const thread = await read(id);
    return thread && thread.ownerId === ownerId ? thread : undefined;
  }

  async function write(thread: ZelavisAssistantThread) {
    await store.set(ASSISTANT_THREADS_NAMESPACE, thread.id, toStoreValue(thread));
    return thread;
  }

  return {
    responder: responder.name,
    async list(ownerId, projectId) {
      const normalizedProjectId = normalizeOptionalText(projectId);
      const records = await store.list(ASSISTANT_THREADS_NAMESPACE);
      return records
        .map((record) => parseStoredThread(record.value))
        .filter(
          (thread) =>
            thread.ownerId === ownerId &&
            (normalizedProjectId === undefined || thread.projectId === normalizedProjectId),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    get: readOwned,
    async delete(id, ownerId) {
      const thread = await readOwned(id, ownerId);
      return thread ? store.delete(ASSISTANT_THREADS_NAMESPACE, thread.id) : false;
    },
    async deleteProjectThreads(projectId, onDeleted) {
      const normalizedProjectId = normalizeOptionalText(projectId);
      if (!normalizedProjectId) {
        throw new ZelavisAssistantValidationError("Project id is required.");
      }
      const records = await store.list(ASSISTANT_THREADS_NAMESPACE);
      let deleted = 0;
      for (const record of records) {
        const thread = parseStoredThread(record.value);
        if (
          thread.projectId === normalizedProjectId &&
          await store.delete(ASSISTANT_THREADS_NAMESPACE, record.key)
        ) {
          deleted += 1;
          await onDeleted?.(thread.id);
        }
      }
      return deleted;
    },
    async recordOutcome(id, ownerId, outcome) {
      const current = await readOwned(id, ownerId);
      if (!current) {
        throw new ZelavisAssistantNotFoundError(`Assistant thread "${id}" was not found.`);
      }
      const message: ZelavisAssistantMessage = {
        id: createId("message"),
        role: "assistant",
        content: outcome.content,
        ...(outcome.activity?.length ? { activity: outcome.activity } : {}),
        createdAt: new Date().toISOString(),
      };
      const thread = await write({
        ...current,
        messages: [...current.messages, message],
        updatedAt: message.createdAt,
      });
      return { thread, message };
    },
    async create(ownerId, input = {}) {
      if (!normalizeOptionalText(ownerId)) {
        throw new ZelavisAssistantValidationError("An Assistant thread needs an owner.");
      }
      const owned = (await store.list(ASSISTANT_THREADS_NAMESPACE))
        .map((record) => parseStoredThread(record.value))
        .filter((thread) => thread.ownerId === ownerId).length;
      if (owned >= ASSISTANT_MAX_THREADS_PER_OWNER) {
        throw new ZelavisAssistantValidationError(
          `You already have ${ASSISTANT_MAX_THREADS_PER_OWNER} chats. Delete some before starting another.`,
        );
      }
      const timestamp = new Date().toISOString();
      return write({
        id: createId("thread"),
        ownerId,
        title: normalizeOptionalText(input.title) ?? "New chat",
        ...(normalizeOptionalText(input.projectId)
          ? { projectId: normalizeOptionalText(input.projectId) }
          : {}),
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },
    async appendMessage(id, prompt, principal, callOptions) {
      const normalizedPrompt = prompt.trim();
      if (!normalizedPrompt) {
        throw new ZelavisAssistantValidationError("Assistant prompt is required.");
      }
      if (normalizedPrompt.length > ASSISTANT_MAX_PROMPT_CHARS) {
        throw new ZelavisAssistantValidationError(
          `A message may be at most ${ASSISTANT_MAX_PROMPT_CHARS} characters.`,
        );
      }
      const current = await readOwned(id, principal.id);
      if (current && current.messages.length >= ASSISTANT_MAX_MESSAGES_PER_THREAD) {
        throw new ZelavisAssistantValidationError(
          "This chat is full. Start a new one to keep going.",
        );
      }
      if (!current) {
        throw new ZelavisAssistantNotFoundError(
          `Assistant thread "${id}" was not found.`,
        );
      }

      const userMessage: ZelavisAssistantMessage = {
        id: createId("message"),
        role: "user",
        content: normalizedPrompt,
        createdAt: new Date().toISOString(),
      };
      const withUser: ZelavisAssistantThread = {
        ...current,
        title:
          current.messages.length === 0 && current.title === "New chat"
            ? titleFromPrompt(normalizedPrompt)
            : current.title,
        messages: [...current.messages, userMessage],
        updatedAt: userMessage.createdAt,
      };
      let streamedText = false;
      const reply = await responder.respond({
        thread: withUser,
        prompt: normalizedPrompt,
        principal,
        ...(callOptions?.onEvent
          ? {
              onEvent: (event: ZelavisAssistantStreamEvent) => {
                if (event.type === "text") streamedText = true;
                callOptions.onEvent!(event);
              },
            }
          : {}),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
      // A responder that cannot stream still reaches a streaming caller.
      if (callOptions?.onEvent && !streamedText && reply.content) {
        callOptions.onEvent({ type: "text", delta: reply.content });
      }
      const assistantMessage: ZelavisAssistantMessage = {
        id: createId("message"),
        role: "assistant",
        content: reply.content,
        ...(reply.actions?.length ? { actions: reply.actions } : {}),
        ...(reply.activity?.length ? { activity: reply.activity } : {}),
        ...(reply.approvalIds?.length ? { approvalIds: reply.approvalIds } : {}),
        provider: reply.provider ?? responder.name,
        createdAt: new Date().toISOString(),
      };
      const thread = await write({
        ...withUser,
        messages: [...withUser.messages, assistantMessage],
        updatedAt: assistantMessage.createdAt,
      });
      return { thread, userMessage, assistantMessage };
    },
  };
}

export function createLocalAssistantResponder(): ZelavisAssistantResponder {
  return {
    name: "zelavis-local-router",
    respond({ prompt, thread }) {
      const lower = prompt.toLowerCase();
      const projectId = thread.projectId;

      if (
        lower.includes("create project") ||
        lower.includes("new project") ||
        lower.includes("create app") ||
        lower.includes("new app") ||
        lower.includes("create website") ||
        lower.includes("new website")
      ) {
        return {
          content: "I can open the project creation flow for you to review and create the project.",
          actions: [{ label: "Create project", to: "/projects?new=1" }],
        };
      }

      const destinations: readonly (readonly [
        readonly string[],
        string,
        string,
        string,
      ])[] = [
        [["security", "checklist"], "Security", "/server/security", "Security checks are available in the Server area."],
        [["resource", "usage", "metrics"], "Resources", "/server/resources", "Host usage and resource charts are available in the Server area."],
        [["log"], "Logs", "/server/logs", "Server logs are available from the global Server area."],
        [["domain"], "Domains", "/server/domains", "Domain management is a global server-level area."],
        [["marketplace", "plugin"], "Marketplace", "/marketplace", "Project recipes, templates, and provider plugins are in Marketplace."],
        ...(projectId
          ? ([
              [["database", "table"], "Database", `/projects/${encodeURIComponent(projectId)}/database`, "You can inspect tables and rows in the project Database."],
              [["content", "schema"], "Content", `/projects/${encodeURIComponent(projectId)}/content`, "Content types, schemas, and entries are in Content."],
            ] as const)
          : []),
      ];
      const destination = destinations.find(([terms]) =>
        terms.some((term) => lower.includes(term)),
      );
      if (destination) {
        const [, label, to, content] = destination;
        return { content, actions: [{ label: `Open ${label}`, to }] };
      }

      return {
        content:
          "I can currently help you navigate project creation, security, resources, logs, domains, Marketplace, Database, and Content. Model and tool-provider adapters come next.",
      };
    },
  };
}
