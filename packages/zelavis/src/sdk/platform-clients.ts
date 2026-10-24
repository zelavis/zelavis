// Clients for the Platform's own operations that were HTTP-only: the Fabric, the Assistant, deployment backends and the
// Agent's status. Each is a thin, typed map of method to route, over the SDK's `json` helper; bodies and answers are the
// Platform's own JSON, passed through, so the three forms (route, SDK, CLI) cannot say different things.
import { Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import type { FabricMigration, FabricNode, FabricPlacementPlan, FabricProjectPlacement, FabricProjectPlacementRequest, FabricSnapshot } from "../core/fabric/index.js";
import type { ZelavisDeploymentBackendPolicy, ZelavisDeploymentBackendSnapshot } from "../backends/registry.js";
import type { ZelavisAgentIdentity, ZelavisAgentOperationSummary } from "../core/agent/index.js";
import type { AssistantProviderStatus } from "../assistant-provider.js";
import type { ZelavisServiceActivationResult } from "../index.js";
import type { PublicServiceRegistryIdentity, ServiceExtensionPoint } from "../platform/service-registry-view.js";
import type { ZelavisAssistantMessage, ZelavisAssistantThread } from "../assistant.js";
import type { AssistantApproval } from "../assistant-approvals.js";
import type { AssistantAuditPage } from "../assistant-audit.js";
import type { ZelavisClientRequestOptions } from "./fetch.js";

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
  snapshot(): Promise<FabricSnapshot>;
  health(): Promise<{ readonly status: FabricSnapshot["status"]; readonly mode: FabricSnapshot["mode"]; readonly localNodeId: FabricSnapshot["localNodeId"]; readonly nodes: number }>;
  nodes(): Promise<{ readonly nodes: readonly FabricNode[] }>;
  node(nodeId: string): Promise<{ readonly node: FabricNode }>;
  placements(): Promise<{ readonly placements: readonly FabricProjectPlacement[] }>;
  placement(projectId: string): Promise<{ readonly placement: FabricProjectPlacement }>;
  /** Compute a placement plan without applying it: each request is `{ projectId, … }`, as the Fabric defines them. */
  plan(requests: readonly FabricProjectPlacementRequest[]): Promise<{ readonly plan: FabricPlacementPlan }>;
  migrations(): Promise<{ readonly migrations: readonly FabricMigration[] }>;
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

/** A model provider for the Platform or one Project: which one, which model, and the key (stored encrypted, never returned). */
export interface ZelavisAssistantProviderInput { readonly provider: string; readonly model: string; readonly apiKey: string }

/** The Assistant: threads, replies, approvals, providers and the audit trail, over `/runtime/assistant`. Same contract as `zelavis assistant`. */
export interface ZelavisAssistantClient {
  /** The trail of tool calls, newest first: `{ limit?, before?, principalId?, tool?, decision? }`. Needs `server.assistant.audit`. */
  audit(query?: { readonly limit?: number; readonly before?: string; readonly principalId?: string; readonly tool?: string; readonly decision?: string }): Promise<AssistantAuditPage>;
  /** The Platform's model provider, and whether it is set by code or by settings. */
  provider(): Promise<AssistantProviderStatus>;
  setProvider(input: ZelavisAssistantProviderInput): Promise<AssistantProviderStatus>;
  clearProvider(): Promise<AssistantProviderStatus>;
  /** A Project's own provider, which answers only that Project's chats. */
  projectProvider(projectId: string): Promise<AssistantProviderStatus>;
  setProjectProvider(projectId: string, input: ZelavisAssistantProviderInput): Promise<AssistantProviderStatus>;
  clearProjectProvider(projectId: string): Promise<AssistantProviderStatus>;
  threads(options?: { readonly projectId?: string }): Promise<{ readonly threads: readonly ZelavisAssistantThread[] }>;
  createThread(input?: { readonly title?: string; readonly projectId?: string }): Promise<{ readonly thread: ZelavisAssistantThread }>;
  thread(threadId: string): Promise<{ readonly thread: ZelavisAssistantThread; readonly approvals: readonly AssistantApproval[] }>;
  deleteThread(threadId: string): Promise<{ readonly deleted: boolean }>;
  /** Send a message and wait for the whole reply. */
  sendMessage(threadId: string, content: string): Promise<{ readonly thread: ZelavisAssistantThread; readonly userMessage: ZelavisAssistantMessage; readonly assistantMessage: ZelavisAssistantMessage }>;
  /** Send a message and read the reply as it is written. Reading ends with a `done` or an `error` event. */
  streamMessage(threadId: string, content: string): AsyncIterable<ZelavisAssistantEvent>;
  /** Approve or deny a change the Assistant asked to make; an irreversible one also needs `confirm`, the typed id. */
  decide(threadId: string, approvalId: string, input: { readonly decision: "approve" | "deny"; readonly confirm?: string }): Promise<{ readonly approval: AssistantApproval; readonly message: ZelavisAssistantMessage }>;
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
    streamMessage: (threadId, content) => streamEvents(() => request(`${thread(threadId)}/messages/stream`, { method: "POST", body: { content } })),
    decide: (threadId, approvalId, input) => json(`${thread(threadId)}/approvals/${segment(approvalId, "approval id")}`, { method: "POST", body: input }),
  };
}

/** Reads a `text/event-stream` body as events: `event: name` then `data: json`, a blank line ending each. The request is made when reading starts. */
function streamEvents(open: () => Promise<Response>): AsyncIterable<ZelavisAssistantEvent> {
  return {
    [Symbol.asyncIterator]() {
      const decoder = new TextDecoder();
      const queue: ZelavisAssistantEvent[] = [];
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let buffer = "";
      let finished = false;
      const parse = (block: string): ZelavisAssistantEvent | undefined => {
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length === 0) return undefined;
        const text = data.join("\n");
        return Effect.runSync(Effect.try({ try: () => ({ event, data: JSON.parse(text) as unknown }), catch: () => text }).pipe(Effect.orElseSucceed(() => ({ event, data: text as unknown }))));
      };
      const connect = Effect.gen(function* () {
        const response = yield* integration(open);
        if (!response.ok || !response.body) {
          const body = yield* integration(() => response.clone().json() as Promise<{ error?: string }>).pipe(Effect.orElseSucceed(() => undefined));
          return yield* Effect.fail(new Error(body?.error ?? `The Assistant stream answered ${response.status}.`));
        }
        reader = response.body.getReader();
      });
      const fill = Effect.gen(function* () {
        if (reader === undefined) yield* connect;
        while (queue.length === 0 && !finished) {
          const chunk = yield* integration(() => reader!.read());
          if (chunk.done) {
            finished = true;
            const rest = parse(buffer);
            if (rest) queue.push(rest);
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
            const parsed = parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            if (parsed) queue.push(parsed);
          }
        }
      });
      return {
        next: () => present(fill.pipe(Effect.map((): IteratorResult<ZelavisAssistantEvent> => queue.length > 0 ? { done: false, value: queue.shift()! } : { done: true, value: undefined }))),
        return: () => {
          finished = true;
          return present(integration(() => reader?.cancel()).pipe(Effect.orElseSucceed(() => undefined), Effect.map((): IteratorResult<ZelavisAssistantEvent> => ({ done: true, value: undefined }))));
        },
      };
    },
  };
}

/** What registering or changing a service answers: the registry as it now is, and whether the change is live. */
export interface ZelavisServiceChange { readonly services: readonly PublicServiceRegistryIdentity[]; readonly activation: ZelavisServiceActivationResult }
export interface ZelavisServiceRegistration { readonly specifier: string; readonly name?: string; readonly status?: "available" | "installed"; readonly source?: string; readonly order?: number }

/** The service registry beyond the list `client.marketplace.services()` returns, over `/runtime/services`. Same contract as `zelavis services`. */
export interface ZelavisServicesClient {
  /** Register an ESM service: `{ specifier, name?, status?: "available" | "installed", source?, order? }`. */
  register(input: ZelavisServiceRegistration): Promise<ZelavisServiceChange>;
  /** Install or disable a registered service, or change its order: `{ status?, order? }`. */
  update(name: string, input: { readonly status?: "available" | "installed"; readonly order?: number }): Promise<ZelavisServiceChange>;
  /** Services that extend another, grouped by what they extend; `owner` limits it to one service. */
  extensions(owner?: string): Promise<{ readonly extensionPoints: readonly ServiceExtensionPoint[] }>;
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
  list(): Promise<{ readonly policy: ZelavisDeploymentBackendPolicy; readonly backends: readonly ZelavisDeploymentBackendSnapshot[] }>;
  /** Look again for what this host can run. */
  detect(): Promise<{ readonly backends: readonly ZelavisDeploymentBackendSnapshot[] }>;
  enable(backendId: string): Promise<{ readonly policy: ZelavisDeploymentBackendPolicy }>;
  disable(backendId: string): Promise<{ readonly policy: ZelavisDeploymentBackendPolicy }>;
  /** Make a backend the one new Projects start on. */
  setDefault(backendId: string): Promise<{ readonly policy: ZelavisDeploymentBackendPolicy }>;
}

export function createDeploymentBackendsClient(json: Json): ZelavisDeploymentBackendsClient {
  const base = "/runtime/deployment-backends";
  const act = (backendId: string, action: string): Promise<{ readonly policy: ZelavisDeploymentBackendPolicy }> => json<{ readonly policy: ZelavisDeploymentBackendPolicy }>(`${base}/${segment(backendId, "backend id")}/${action}`, { method: "POST", body: {} });
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
  status(): Promise<{ readonly identity: ZelavisAgentIdentity; readonly operations: readonly ZelavisAgentOperationSummary[] }>;
  operations(): Promise<{ readonly operations: readonly ZelavisAgentOperationSummary[] }>;
  operation(operationId: string): Promise<{ readonly operation: ZelavisAgentOperationSummary }>;
}

export function createAgentClient(json: Json): ZelavisAgentClient {
  return {
    status: () => json("/runtime/agent"),
    operations: () => json("/runtime/agent/operations"),
    operation: (operationId) => json(`/runtime/agent/operations/${segment(operationId, "operation id")}`),
  };
}
