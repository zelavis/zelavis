// Clients for the Platform's own operations that were HTTP-only: the Fabric, the Assistant, deployment backends and the
// Agent's status. Each is a thin, typed map of method to route, over the SDK's `json` helper; bodies and answers are the
// Platform's own JSON, passed through, so the three forms (route, SDK, CLI) cannot say different things.
import type { ZelavisAssistantThread } from "../assistant.js";
import type { AssistantApproval } from "../assistant-approvals.js";
import type { AssistantAuditPage } from "../assistant-audit.js";
import type { ZelavisClientRequestOptions, ZelavisDataBody, ZelavisDataResult } from "./fetch.js";

type Json = <T>(path: string, options?: ZelavisClientRequestOptions) => Promise<T>;
type Raw = (path: string, options?: ZelavisClientRequestOptions) => Promise<Response>;

const segment = (value: string, what: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`A ${what} is required.`);
  const encoded = encodeURIComponent(value);
  if (encoded === "." || encoded === "..") throw new TypeError(`Invalid ${what}.`);
  return encoded;
};

const withQuery = (path: string, query: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value !== undefined) params.set(name, String(value));
  return params.size ? `${path}?${params}` : path;
};

/** The Fabric's view of nodes, Project placements and migrations, over `/fabric`. Same contract as `zelavis fabric`. */
export interface ZelavisFabricClient {
  snapshot(): Promise<ZelavisDataResult>;
  health(): Promise<ZelavisDataResult>;
  nodes(): Promise<ZelavisDataResult>;
  node(nodeId: string): Promise<ZelavisDataResult>;
  placements(): Promise<ZelavisDataResult>;
  placement(projectId: string): Promise<ZelavisDataResult>;
  /** Compute a placement plan without applying it: each request is `{ projectId, … }`, as the Fabric defines them. */
  plan(requests: readonly ZelavisDataBody[]): Promise<ZelavisDataResult>;
  migrations(): Promise<ZelavisDataResult>;
}

export function createFabricClient(json: Json): ZelavisFabricClient {
  return {
    snapshot: () => json("/fabric/snapshot"),
    health: () => json("/fabric/health"),
    nodes: () => json("/fabric/nodes"),
    node: (nodeId) => json(`/fabric/nodes/${segment(nodeId, "node id")}`),
    placements: () => json("/fabric/placements/projects"),
    placement: (projectId) => json(`/fabric/placements/projects/${segment(projectId, "Project id")}`),
    plan: (requests) => json("/fabric/placements/projects/plan", { method: "POST", body: { requests } }),
    migrations: () => json("/fabric/migrations"),
  };
}

/** One event of a streamed Assistant reply: `text`, `tool`, `done` or `error`, with the data the Platform sent. */
export interface ZelavisAssistantEvent {
  readonly event: string;
  readonly data: unknown;
}

/** The Assistant: threads, replies, approvals, providers and the audit trail, over `/runtime/assistant`. Same contract as `zelavis assistant`. */
export interface ZelavisAssistantClient {
  /** The trail of tool calls, newest first: `{ limit?, before?, principalId?, tool?, decision? }`. Needs `server.assistant.audit`. */
  audit(query?: { readonly limit?: number; readonly before?: string; readonly principalId?: string; readonly tool?: string; readonly decision?: string }): Promise<AssistantAuditPage>;
  /** The Platform's model provider, and whether it is set by code or by settings. */
  provider(): Promise<ZelavisDataResult>;
  setProvider(input: ZelavisDataBody): Promise<ZelavisDataResult>;
  clearProvider(): Promise<ZelavisDataResult>;
  /** A Project's own provider, which answers only that Project's chats. */
  projectProvider(projectId: string): Promise<ZelavisDataResult>;
  setProjectProvider(projectId: string, input: ZelavisDataBody): Promise<ZelavisDataResult>;
  clearProjectProvider(projectId: string): Promise<ZelavisDataResult>;
  threads(options?: { readonly projectId?: string }): Promise<{ readonly threads: readonly ZelavisAssistantThread[] }>;
  createThread(input?: { readonly title?: string; readonly projectId?: string }): Promise<{ readonly thread: ZelavisAssistantThread }>;
  thread(threadId: string): Promise<{ readonly thread: ZelavisAssistantThread; readonly approvals: readonly AssistantApproval[] }>;
  deleteThread(threadId: string): Promise<{ readonly deleted: boolean }>;
  /** Send a message and wait for the whole reply. */
  sendMessage(threadId: string, content: string): Promise<ZelavisDataResult>;
  /** Send a message and read the reply as it is written. Reading ends with a `done` or an `error` event. */
  streamMessage(threadId: string, content: string): AsyncIterable<ZelavisAssistantEvent>;
  /** Approve or deny a change the Assistant asked to make; an irreversible one also needs `confirm`, the typed id. */
  decide(threadId: string, approvalId: string, input: { readonly decision: "approve" | "deny"; readonly confirm?: string }): Promise<ZelavisDataResult>;
}

export function createAssistantClient(json: Json, request: Raw): ZelavisAssistantClient {
  const base = "/runtime/assistant";
  const thread = (id: string) => `${base}/threads/${segment(id, "thread id")}`;
  const project = (id: string) => `${base}/projects/${segment(id, "Project id")}/provider`;
  return {
    audit: (query) => json(withQuery(`${base}/audit`, { ...query })),
    provider: () => json(`${base}/provider`),
    setProvider: (input) => json(`${base}/provider`, { method: "PUT", body: input }),
    clearProvider: () => json(`${base}/provider`, { method: "DELETE" }),
    projectProvider: (projectId) => json(project(projectId)),
    setProjectProvider: (projectId, input) => json(project(projectId), { method: "PUT", body: input }),
    clearProjectProvider: (projectId) => json(project(projectId), { method: "DELETE" }),
    threads: (options) => json(withQuery(`${base}/threads`, { projectId: options?.projectId })),
    createThread: (input) => json(`${base}/threads`, { method: "POST", body: input ?? {} }),
    thread: (threadId) => json(thread(threadId)),
    deleteThread: (threadId) => json(thread(threadId), { method: "DELETE" }),
    sendMessage: (threadId, content) => json(`${thread(threadId)}/messages`, { method: "POST", body: { content } }),
    streamMessage: (threadId, content) => streamEvents(request(`${thread(threadId)}/messages/stream`, { method: "POST", body: { content } })),
    decide: (threadId, approvalId, input) => json(`${thread(threadId)}/approvals/${segment(approvalId, "approval id")}`, { method: "POST", body: input }),
  };
}

/** Reads a `text/event-stream` body as events: `event: name` then `data: json`, a blank line ending each. */
async function* streamEvents(pending: Promise<Response>): AsyncGenerator<ZelavisAssistantEvent> {
  const response = await pending;
  if (!response.ok || !response.body) {
    const body = await response.clone().json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(body?.error ?? `The Assistant stream answered ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): ZelavisAssistantEvent | undefined => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return undefined;
    const text = data.join("\n");
    try { return { event, data: JSON.parse(text) }; } catch { return { event, data: text }; }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const parsed = parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (parsed) yield parsed;
      }
    }
    const rest = parse(buffer);
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

/** The service registry beyond the list `client.marketplace.services()` returns, over `/runtime/services`. Same contract as `zelavis services`. */
export interface ZelavisServicesClient {
  /** Register an ESM service: `{ specifier, name?, status?: "available" | "installed", source?, order? }`. */
  register(input: ZelavisDataBody): Promise<ZelavisDataResult>;
  /** Install or disable a registered service, or change its order: `{ status?, order? }`. */
  update(name: string, input: ZelavisDataBody): Promise<ZelavisDataResult>;
  /** Services that extend another, grouped by what they extend; `owner` limits it to one service. */
  extensions(owner?: string): Promise<ZelavisDataResult>;
}

export function createServicesClient(json: Json): ZelavisServicesClient {
  return {
    register: (input) => json("/runtime/services", { method: "POST", body: input }),
    update: (name, input) => json(`/runtime/services/${segment(name, "service name")}`, { method: "PATCH", body: input }),
    extensions: (owner) => json(withQuery("/runtime/extensions", { owner })),
  };
}

/** Where the Platform may run Projects: Docker, native and what else was detected, over `/runtime/deployment-backends`. Same contract as `zelavis backends`. */
export interface ZelavisDeploymentBackendsClient {
  list(): Promise<ZelavisDataResult>;
  /** Look again for what this host can run. */
  detect(): Promise<ZelavisDataResult>;
  enable(backendId: string): Promise<ZelavisDataResult>;
  disable(backendId: string): Promise<ZelavisDataResult>;
  /** Make a backend the one new Projects start on. */
  setDefault(backendId: string): Promise<ZelavisDataResult>;
}

export function createDeploymentBackendsClient(json: Json): ZelavisDeploymentBackendsClient {
  const base = "/runtime/deployment-backends";
  const act = (backendId: string, action: string): Promise<ZelavisDataResult> => json<ZelavisDataResult>(`${base}/${segment(backendId, "backend id")}/${action}`, { method: "POST", body: {} });
  return {
    list: () => json(base),
    detect: () => json(`${base}/detect`, { method: "POST", body: {} }),
    enable: (backendId) => act(backendId, "enable"),
    disable: (backendId) => act(backendId, "disable"),
    setDefault: (backendId) => act(backendId, "default"),
  };
}

/** What the Agent that runs this Platform's Project processes reports, over `/runtime/agent`. Same contract as `zelavis agent status`. */
export interface ZelavisAgentClient {
  status(): Promise<ZelavisDataResult>;
  operations(): Promise<ZelavisDataResult>;
  operation(operationId: string): Promise<ZelavisDataResult>;
}

export function createAgentClient(json: Json): ZelavisAgentClient {
  return {
    status: () => json("/runtime/agent"),
    operations: () => json("/runtime/agent/operations"),
    operation: (operationId) => json(`/runtime/agent/operations/${segment(operationId, "operation id")}`),
  };
}
