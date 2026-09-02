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
  createdAt: string;
}

export interface ZelavisAssistantThread {
  id: string;
  title: string;
  projectId?: string;
  messages: readonly ZelavisAssistantMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ZelavisAssistantReply {
  content: string;
  actions?: readonly ZelavisAssistantAction[];
}

export interface ZelavisAssistantResponder {
  readonly name: string;
  respond(input: {
    thread: ZelavisAssistantThread;
    prompt: string;
  }): Promise<ZelavisAssistantReply> | ZelavisAssistantReply;
}

export interface ZelavisAssistantManager {
  readonly responder: string;
  list(projectId?: string): Promise<readonly ZelavisAssistantThread[]>;
  get(id: string): Promise<ZelavisAssistantThread | undefined>;
  deleteProjectThreads(projectId: string): Promise<number>;
  create(input?: {
    title?: string;
    projectId?: string;
  }): Promise<ZelavisAssistantThread>;
  appendMessage(
    id: string,
    prompt: string,
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

  async function write(thread: ZelavisAssistantThread) {
    await store.set(ASSISTANT_THREADS_NAMESPACE, thread.id, toStoreValue(thread));
    return thread;
  }

  return {
    responder: responder.name,
    async list(projectId) {
      const normalizedProjectId = normalizeOptionalText(projectId);
      const records = await store.list(ASSISTANT_THREADS_NAMESPACE);
      return records
        .map((record) => parseStoredThread(record.value))
        .filter(
          (thread) =>
            normalizedProjectId === undefined || thread.projectId === normalizedProjectId,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    get: read,
    async deleteProjectThreads(projectId) {
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
        }
      }
      return deleted;
    },
    async create(input = {}) {
      const timestamp = new Date().toISOString();
      return write({
        id: createId("thread"),
        title: normalizeOptionalText(input.title) ?? "New chat",
        ...(normalizeOptionalText(input.projectId)
          ? { projectId: normalizeOptionalText(input.projectId) }
          : {}),
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },
    async appendMessage(id, prompt) {
      const normalizedPrompt = prompt.trim();
      if (!normalizedPrompt) {
        throw new ZelavisAssistantValidationError("Assistant prompt is required.");
      }
      const current = await read(id);
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
      const reply = await responder.respond({
        thread: withUser,
        prompt: normalizedPrompt,
      });
      const assistantMessage: ZelavisAssistantMessage = {
        id: createId("message"),
        role: "assistant",
        content: reply.content,
        ...(reply.actions?.length ? { actions: reply.actions } : {}),
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
        [["security", "checklist"], "Security", "/security", "Security checks are available in the global Security area."],
        [["resource", "usage", "metrics"], "Resources", "/resources", "Host usage and resource charts are available in Resources."],
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
