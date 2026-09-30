/**
 * The Admin Agent's tool layer and its permission model.
 *
 * The agent is not a principal. It borrows the authority of the caller whose
 * message is being answered, and this module is where that borrowing is
 * enforced, not the prompt:
 *
 * - **Authorize at execution.** A tool call is checked against the caller's
 *   permissions with a scope built from the call's own arguments. What the
 *   thread, the prompt or an earlier turn said about scope is irrelevant.
 * - **Filter at advertisement.** The model is only shown tools the caller could
 *   plausibly use, so it does not propose actions that are certain to be refused.
 *   Advertisement is a convenience; execution is the gate.
 * - **Refusals are data.** A denied or invalid call returns a structured result
 *   the model can relay honestly, never an exception that ends the run.
 * - **Everything is audited** with principal, arguments and decision, and a
 *   call whose audit record cannot be written does not run.
 */
import {
  principalHasPermission,
  type ZelavisAccessScope,
  type ZelavisPrincipal,
} from "./core/index.js";
import {
  APPROVAL_TTL_MS,
  MAX_PENDING_APPROVALS_PER_THREAD,
  type AssistantApproval,
  type AssistantApprovalStore,
} from "./assistant-approvals.js";
import { redactSecrets } from "./assistant-redaction.js";
import type { ZelavisProjectManager } from "./project.js";
import type { ZelavisSystemStore } from "./system-store.js";

export interface AssistantToolRequirement {
  readonly permissions: readonly string[];
  readonly scope?: ZelavisAccessScope;
}

/** Thrown by a tool's `access` when its arguments are unusable. */
export class AssistantToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantToolArgumentError";
  }
}

export interface AssistantTool<TArgs = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments, as advertised to the model. */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Permissions the caller must hold, at any scope, for the tool to be shown. */
  readonly advertisedPermissions: readonly string[];
  /**
   * Authority these exact arguments require. Must throw
   * `AssistantToolArgumentError` rather than guess when they are malformed.
   */
  access(args: unknown): AssistantToolRequirement & { readonly parsed: TArgs };
  execute(args: TArgs, context: { readonly principal: ZelavisPrincipal }): Promise<unknown>;
  /** What this call is doing, in the operator's words, for the activity shown in chat. */
  describe?(args: TArgs): string;
  /**
   * Present on tools that change something. They never run from a model's call:
   * the call becomes a request a person approves, naming this target.
   */
  readonly mutation?: {
    readonly irreversible?: boolean;
    target(args: TArgs): { readonly kind: string; readonly id: string };
    /**
     * Pins the request to the target as it is now, and fails if there is none.
     * Checked again at approval, so the change cannot land on something else
     * that later took the same name.
     */
    fingerprint?(args: TArgs): Promise<string>;
  };
}

export type AssistantToolRefusalCode =
  | "unknown_tool"
  | "invalid_arguments"
  | "forbidden"
  | "audit_unavailable"
  | "approval_required"
  | "approval_unavailable"
  | "failed";

export type AssistantToolResult =
  | { readonly ok: true; readonly value: unknown; readonly truncated?: true }
  | {
      readonly ok: false;
      readonly refusal: {
        readonly code: AssistantToolRefusalCode;
        readonly tool: string;
        readonly message: string;
        readonly requires?: AssistantToolRequirement;
        /** Set with `approval_required`: the request awaiting a person's decision. */
        readonly approval?: {
          readonly id: string;
          readonly label: string;
          readonly irreversible: boolean;
          readonly target: { readonly kind: string; readonly id: string };
        };
      };
    };

export interface AssistantToolAuditRecord {
  readonly id: string;
  readonly at: string;
  readonly principalId: string;
  readonly tool: string;
  readonly arguments: string;
  readonly decision:
    | "allowed"
    | "denied"
    | "invalid"
    | "failed"
    | "pending_approval"
    | "executed";
  readonly reason?: string;
}

export interface AssistantToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface AssistantToolbox {
  /** Tools worth showing this caller. Not an authorization decision. */
  advertise(principal: ZelavisPrincipal): readonly AssistantToolDefinition[];
  run(
    principal: ZelavisPrincipal,
    call: { readonly name: string; readonly arguments: unknown },
    context?: { readonly threadId?: string },
  ): Promise<AssistantToolResult>;
  /** A short operator-language label for a call. Never throws and never authorizes. */
  describe(call: { readonly name: string; readonly arguments: unknown }): string;
  /** A person's decision on a change the Assistant asked to make. */
  resolveApproval(
    principal: ZelavisPrincipal,
    input: {
      readonly approvalId: string;
      readonly threadId: string;
      readonly decision: "approve" | "deny";
      /** The target's id, typed out, required to approve an irreversible change. */
      readonly confirm?: string;
    },
  ): Promise<AssistantApprovalResult>;
}

export type AssistantApprovalResult =
  | { readonly ok: true; readonly approval: AssistantApproval }
  | {
      readonly ok: false;
      readonly code:
        | "not_found"
        | "already_decided"
        | "expired"
        | "forbidden"
        | "confirmation_required"
        | "target_changed"
        | "audit_unavailable"
        | "failed";
      readonly message: string;
      readonly approval?: AssistantApproval;
    };


const MAX_ARGUMENT_AUDIT_CHARS = 4_096;
const MAX_RESULT_CHARS = 16_384;
const AUDIT_NAMESPACE = "assistant-audit";

function holdsAtAnyScope(principal: ZelavisPrincipal, permission: string): boolean {
  return Boolean(
    principal.permissions?.includes(permission) ||
      principal.permissions?.includes("*") ||
      principal.grants?.some(
        (grant) => grant.permission === permission || grant.permission === "*",
      ),
  );
}

function serializeArguments(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = '"[unserializable]"';
  }
  return text.length > MAX_ARGUMENT_AUDIT_CHARS
    ? `${text.slice(0, MAX_ARGUMENT_AUDIT_CHARS)}…`
    : text;
}

/** Persists audit records in the Platform System Store, one key per call. */
export function createAssistantToolAudit(
  store: ZelavisSystemStore,
): (record: AssistantToolAuditRecord) => Promise<void> {
  return async (record) => {
    await store.set(
      AUDIT_NAMESPACE,
      `${record.at}_${record.id}`,
      JSON.parse(JSON.stringify(record)),
    );
  };
}

export function createAssistantToolbox(options: {
  readonly tools: readonly AssistantTool<any>[];
  readonly audit: (record: AssistantToolAuditRecord) => Promise<void>;
  /** Without it, tools that change things are refused rather than run unasked. */
  readonly approvals?: AssistantApprovalStore;
}): AssistantToolbox {
  const byName = new Map<string, AssistantTool<any>>();
  for (const tool of options.tools) {
    if (byName.has(tool.name)) {
      throw new TypeError(`Duplicate Assistant tool "${tool.name}".`);
    }
    byName.set(tool.name, tool);
  }

  async function record(
    principal: ZelavisPrincipal,
    tool: string,
    args: unknown,
    decision: AssistantToolAuditRecord["decision"],
    reason?: string,
  ): Promise<boolean> {
    try {
      await options.audit({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        principalId: principal.id,
        tool,
        arguments: serializeArguments(args),
        decision,
        ...(reason ? { reason } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  return {
    describe(call) {
      const tool = byName.get(call.name);
      const fallback = call.name.replace(/[_-]+/g, " ").trim() || "Working";
      if (!tool?.describe) return fallback[0]!.toUpperCase() + fallback.slice(1);
      try {
        const label = tool.describe(tool.access(call.arguments).parsed);
        return label.length > 120 ? `${label.slice(0, 117)}…` : label;
      } catch {
        return fallback[0]!.toUpperCase() + fallback.slice(1);
      }
    },
    advertise(principal) {
      return options.tools
        .filter((tool) =>
          // Offered when the caller holds every permission the tool can ask
          // for, at some scope. The exact scope is decided per call.
          tool.advertisedPermissions.every((p) => holdsAtAnyScope(principal, p)),
        )
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
    },

    resolveApproval,

    async run(principal, call, context) {
      const tool = byName.get(call.name);
      if (!tool) {
        await record(principal, call.name, call.arguments, "invalid", "unknown tool");
        return {
          ok: false,
          refusal: { code: "unknown_tool", tool: call.name, message: `There is no tool named "${call.name}".` },
        };
      }

      let requirement: ReturnType<AssistantTool["access"]>;
      try {
        requirement = tool.access(call.arguments);
      } catch (error) {
        const message = error instanceof AssistantToolArgumentError
          ? error.message
          : "The arguments could not be read.";
        if (!(await record(principal, tool.name, call.arguments, "invalid", message))) {
          return auditUnavailable(tool.name);
        }
        return { ok: false, refusal: { code: "invalid_arguments", tool: tool.name, message } };
      }

      const { permissions, scope, parsed } = requirement;
      const allowed = permissions.every((permission) =>
        principalHasPermission(principal, permission, scope),
      );
      if (!allowed) {
        if (!(await record(principal, tool.name, call.arguments, "denied", "missing permission"))) {
          return auditUnavailable(tool.name);
        }
        return {
          ok: false,
          refusal: {
            code: "forbidden",
            tool: tool.name,
            message: "You do not have permission to do that.",
            requires: { permissions, ...(scope ? { scope } : {}) },
          },
        };
      }

      if (tool.mutation) {
        return requestApproval(principal, tool, parsed, call.arguments, context?.threadId);
      }

      // Fail closed: an action that cannot be recorded does not happen.
      if (!(await record(principal, tool.name, call.arguments, "allowed"))) {
        return auditUnavailable(tool.name);
      }

      try {
        const value = redactSecrets(await tool.execute(parsed, { principal }));
        const text = JSON.stringify(value) ?? "null";
        if (text.length > MAX_RESULT_CHARS) {
          return { ok: true, value: `${text.slice(0, MAX_RESULT_CHARS)}…`, truncated: true };
        }
        return { ok: true, value };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The tool failed.";
        await record(principal, tool.name, call.arguments, "failed", reason);
        return { ok: false, refusal: { code: "failed", tool: tool.name, message: reason } };
      }
    },
  };


  async function requestApproval(
    principal: ZelavisPrincipal,
    tool: AssistantTool<any>,
    parsed: unknown,
    rawArguments: unknown,
    threadId: string | undefined,
  ): Promise<AssistantToolResult> {
    const approvals = options.approvals;
    if (!approvals || !threadId) {
      await record(principal, tool.name, rawArguments, "denied", "approval unavailable");
      return {
        ok: false,
        refusal: {
          code: "approval_unavailable",
          tool: tool.name,
          message: "Changes cannot be requested here, so nothing was changed.",
        },
      };
    }
    const pending = (await approvals.listForThread(threadId)).filter(
      (approval) => approval.status === "pending" && Date.parse(approval.expiresAt) > Date.now(),
    );
    if (pending.length >= MAX_PENDING_APPROVALS_PER_THREAD) {
      return {
        ok: false,
        refusal: {
          code: "approval_unavailable",
          tool: tool.name,
          message: "Too many changes are already waiting for a decision. Decide those first.",
        },
      };
    }
    const target = tool.mutation!.target(parsed);
    let fingerprint: string | undefined;
    try {
      fingerprint = await tool.mutation!.fingerprint?.(parsed);
    } catch (error) {
      // Nothing to ask a person about: refuse instead of queueing a request
      // that cannot be carried out.
      const reason = error instanceof Error ? error.message : "The target could not be found.";
      await record(principal, tool.name, rawArguments, "failed", reason);
      return { ok: false, refusal: { code: "failed", tool: tool.name, message: reason } };
    }
    const now = Date.now();
    const approval: AssistantApproval = {
      id: `approval_${crypto.randomUUID().replaceAll("-", "")}`,
      threadId,
      principalId: principal.id,
      tool: tool.name,
      arguments: parsed,
      label: tool.describe?.(parsed) ?? tool.name,
      target,
      irreversible: tool.mutation!.irreversible === true,
      ...(fingerprint ? { fingerprint } : {}),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    if (!(await record(principal, tool.name, rawArguments, "pending_approval", approval.id))) {
      return auditUnavailable(tool.name);
    }
    await approvals.create(approval);
    return {
      ok: false,
      refusal: {
        code: "approval_required",
        tool: tool.name,
        message:
          "This changes something, so it has been sent to the operator for approval. " +
          "It has not run. Do not retry it; tell the operator what you asked to do.",
        approval: {
          id: approval.id,
          label: approval.label,
          irreversible: approval.irreversible,
          target: approval.target,
        },
      },
    };
  }

  async function resolveApproval(
    principal: ZelavisPrincipal,
    input: Parameters<AssistantToolbox["resolveApproval"]>[1],
  ): Promise<AssistantApprovalResult> {
    const approvals = options.approvals;
    const fail = (
      code: Extract<AssistantApprovalResult, { ok: false }>["code"],
      message: string,
      approval?: AssistantApproval,
    ): AssistantApprovalResult => ({ ok: false, code, message, ...(approval ? { approval } : {}) });

    const current = await approvals?.get(input.threadId, input.approvalId);
    // Someone else's request looks exactly like one that does not exist.
    if (!approvals || !current || current.principalId !== principal.id ||
        current.threadId !== input.threadId) {
      return fail("not_found", "There is no such request.");
    }
    if (current.status !== "pending") {
      return fail("already_decided", "That request has already been decided.", current);
    }
    if (Date.parse(current.expiresAt) <= Date.now()) {
      const expired = await approvals.decide(current.threadId, current.id, { status: "expired", outcome: "It was not decided in time." });
      return fail("expired", "That request expired. Ask again if you still want it.", expired ?? current);
    }

    const tool = byName.get(current.tool);
    if (input.decision === "deny") {
      if (!(await record(principal, current.tool, current.arguments, "denied", `approval ${current.id} denied`))) {
        return fail("audit_unavailable", "The decision could not be recorded, so it was not applied.");
      }
      const denied = await approvals.decide(current.threadId, current.id, { status: "denied", outcome: "Nothing was changed." });
      return denied ? { ok: true, approval: denied } : fail("already_decided", "That request has already been decided.");
    }

    if (current.irreversible && input.confirm !== current.target.id) {
      return fail("confirmation_required", `This cannot be undone. Type "${current.target.id}" to confirm.`, current);
    }

    // The second gate: approval never widens what the caller may do, so the
    // caller's permission is checked again, now, against the stored arguments.
    let permitted = false;
    try {
      const requirement = tool?.access(current.arguments);
      permitted = Boolean(requirement) && requirement!.permissions.every((permission) =>
        principalHasPermission(principal, permission, requirement!.scope));
    } catch {
      permitted = false;
    }
    if (!tool || !permitted) {
      await record(principal, current.tool, current.arguments, "denied", `approval ${current.id}: no longer permitted`);
      const refused = await approvals.decide(current.threadId, current.id, {
        status: "denied", outcome: "Not run: you no longer have permission for this.",
      });
      return fail("forbidden", "You no longer have permission to do that, so it was not run.", refused ?? current);
    }

    if (current.fingerprint !== undefined) {
      let now: string | undefined;
      try {
        now = await tool.mutation?.fingerprint?.(current.arguments);
      } catch {
        now = undefined;
      }
      if (now !== current.fingerprint) {
        const changed = await approvals.decide(current.threadId, current.id, {
          status: "denied", outcome: "Not run: the target changed since this was requested.",
        });
        await record(principal, current.tool, current.arguments, "denied", `approval ${current.id}: target changed`);
        return fail("target_changed", "The target changed since this was requested, so it was not run.", changed ?? current);
      }
    }

    // One winner: only the request that moves it out of `pending` goes on.
    // It is recorded as running before anything runs, so a crash cannot leave a
    // request that looks undecided while the change may have happened.
    const claimed = await approvals.decide(current.threadId, current.id, { status: "running", outcome: "Running…" });
    if (!claimed) return fail("already_decided", "That request has already been decided.");
    // Fail closed: a change that cannot be recorded does not happen.
    if (!(await record(principal, current.tool, current.arguments, "allowed", `approval ${current.id} approved`))) {
      const unrecorded = await settle(approvals, claimed, "failed", "Not run: the decision could not be recorded.");
      return fail("audit_unavailable", "The decision could not be recorded, so it was not applied.", unrecorded);
    }
    try {
      await tool.execute(current.arguments, { principal });
      await record(principal, current.tool, current.arguments, "executed", current.id);
      const done = await settle(approvals, claimed, "executed", `Done: ${current.label}.`);
      return { ok: true, approval: done };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The change failed.";
      await record(principal, current.tool, current.arguments, "failed", reason);
      const failed = await settle(approvals, claimed, "failed", reason);
      return fail("failed", reason, failed);
    }
  }

  async function settle(
    approvals: AssistantApprovalStore,
    approval: AssistantApproval,
    status: "executed" | "failed",
    outcome: string,
  ): Promise<AssistantApproval> {
    return (await approvals.finish(approval.threadId, approval.id, { status, outcome })) ?? { ...approval, status, outcome };
  }

  function auditUnavailable(tool: string): AssistantToolResult {
    return {
      ok: false,
      refusal: {
        code: "audit_unavailable",
        tool,
        message: "The action was not run because it could not be recorded.",
      },
    };
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistantToolArgumentError("Arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

/** Refuses arguments the tool does not define, rather than silently ignoring them. */
function requireOnly(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new AssistantToolArgumentError(`"${key}" is not an argument of this tool.`);
    }
  }
}

// Exactly the shape a Project id has: what a model invents or an attacker
// plants in data must never widen into another spelling of an id.
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

function readProjectId(value: unknown, extra: readonly string[] = []): { projectId: string } {
  const args = readObject(value);
  requireOnly(args, ["projectId", ...extra]);
  const projectId = args.projectId;
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new AssistantToolArgumentError("projectId must be a Project id such as my-project.");
  }
  return { projectId };
}

/** Read-only Project tools. Each carries the same requirement as its HTTP route. */
export function createProjectReadTools(
  projects: () => ZelavisProjectManager | undefined,
): readonly AssistantTool<any>[] {
  const manager = () => {
    const value = projects();
    if (!value) throw new Error("Project management is unavailable on this installation.");
    return value;
  };
  const projectIdSchema = {
    type: "object",
    properties: { projectId: { type: "string" } },
    required: ["projectId"],
    additionalProperties: false,
  } as const;

  const listProjects: AssistantTool<Record<string, never>> = {
    name: "list_projects",
    description: "List the Projects on this installation.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    advertisedPermissions: ["projects.list"],
    access: () => ({ permissions: ["projects.list"], scope: { type: "system" }, parsed: {} }),
    execute: async () => ({ projects: await manager().list() }),
    describe: () => "Listing Projects",
  };
  const getProject: AssistantTool<{ projectId: string }> = {
    name: "get_project",
    description: "Read one Project's configuration and runtime status.",
    parameters: projectIdSchema,
    advertisedPermissions: ["project.view"],
    access: (args) => {
      const parsed = readProjectId(args);
      return {
        permissions: ["project.view"],
        scope: { type: "project", projectId: parsed.projectId },
        parsed,
      };
    },
    execute: async ({ projectId }) => {
      const project = await manager().get(projectId);
      if (!project) throw new Error(`Project "${projectId}" was not found.`);
      return { project };
    },
    describe: ({ projectId }) => `Reading Project ${projectId}`,
  };
  const projectLogs: AssistantTool<{ projectId: string }> = {
    name: "project_logs",
    description: "Read a Project's recent runtime logs.",
    parameters: projectIdSchema,
    advertisedPermissions: ["project.logs.read"],
    access: (args) => {
      const parsed = readProjectId(args);
      return {
        permissions: ["project.logs.read"],
        scope: { type: "project", projectId: parsed.projectId },
        parsed,
      };
    },
    execute: async ({ projectId }) => ({ logs: await manager().logs(projectId) }),
    describe: ({ projectId }) => `Reading logs for ${projectId}`,
  };
  return [listProjects, getProject, projectLogs];
}

/** Reaches into a Project runtime with the caller's authority and nothing more. */
export type AssistantProjectReader = (input: {
  readonly projectId: string;
  readonly principal: ZelavisPrincipal;
  readonly method: "GET" | "POST";
  /** Path inside the Project runtime. */
  readonly path: string;
  readonly query?: URLSearchParams;
  readonly body?: unknown;
}) => Promise<{ readonly status: number; readonly body: unknown }>;

const APP_TENANT = "zelavis-app";
const MAX_ROWS = 20;
const MAX_COLLECTIONS = 100;

function readName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AssistantToolArgumentError(`${label} must be a plain identifier.`);
  }
  return value;
}

async function readFromProject(
  reader: AssistantProjectReader,
  input: Parameters<AssistantProjectReader>[0],
): Promise<any> {
  const result = await reader(input);
  if (result.status !== 200) {
    const detail =
      result.body && typeof result.body === "object" &&
      typeof (result.body as { error?: unknown }).error === "string"
        ? (result.body as { error: string }).error
        : `The Project answered ${result.status}.`;
    throw new Error(detail);
  }
  return result.body;
}

/** Platform-wide status, from what the caller can already list. */
export function createPlatformStatusTool(
  projects: () => ZelavisProjectManager | undefined,
): AssistantTool<Record<string, never>> {
  return {
    name: "platform_status",
    description: "Summarize this installation: how many Projects there are and their runtime states.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    advertisedPermissions: ["projects.list"],
    access: () => ({ permissions: ["projects.list"], scope: { type: "system" }, parsed: {} }),
    execute: async () => {
      const manager = projects();
      if (!manager) throw new Error("Project management is unavailable on this installation.");
      const all = await manager.list();
      const byStatus: Record<string, number> = {};
      for (const project of all) {
        const status = project.runtime?.status ?? "unknown";
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      }
      return { runtime: manager.runtime, projects: { total: all.length, byStatus } };
    },
    describe: () => "Checking platform status",
  };
}

/**
 * Read-only views of a Project's database. Each call is authorized here against
 * the caller's `project.view` for that Project, then forwarded with only the
 * database read authority the caller actually holds, so the Project enforces it
 * a second time. Row contents are the Project's data: the model is told to treat
 * them as data, and nothing here can write.
 */
export function createProjectDatabaseTools(
  reader: AssistantProjectReader,
): readonly AssistantTool<any>[] {
  const viewOf = (projectId: string): AssistantToolRequirement => ({
    permissions: ["project.view"],
    scope: { type: "project", projectId },
  });

  // The tenant is fixed, never an argument. Identity records (accounts,
  // credentials, sessions) live in service tenants of the same database, and
  // anything this tool returns is sent to the model provider.
  const listCollections: AssistantTool<{ projectId: string }> = {
    name: "list_collections",
    description: "List the collections (tables) in a Project's database.",
    parameters: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      additionalProperties: false,
    },
    advertisedPermissions: ["project.view"],
    access: (args) => {
      const parsed = readProjectId(args);
      return { ...viewOf(parsed.projectId), parsed };
    },
    execute: async ({ projectId }, { principal }) => {
      const body = await readFromProject(reader, {
        projectId, principal, method: "GET",
        path: "zelavis/api/v1/database/documents/collections",
        query: new URLSearchParams({ tenantId: APP_TENANT }),
      });
      const collections = Array.isArray(body?.collections) ? body.collections : [];
      return {
        collections: collections.slice(0, MAX_COLLECTIONS).map((c: { name?: unknown }) => c.name),
        ...(collections.length > MAX_COLLECTIONS ? { truncated: true } : {}),
      };
    },
    describe: ({ projectId }) => `Listing collections in ${projectId}`,
  };

  const readCollection: AssistantTool<{
    projectId: string; collection: string; limit: number;
  }> = {
    name: "read_collection",
    description: `Read up to ${MAX_ROWS} records from one collection (table) in a Project's database.`,
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        collection: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_ROWS },
      },
      required: ["projectId", "collection"],
      additionalProperties: false,
    },
    advertisedPermissions: ["project.view"],
    access: (args) => {
      const { projectId } = readProjectId(args, ["collection", "limit"]);
      const input = args as { collection?: unknown; limit?: unknown };
      const limit = input.limit === undefined ? 10 : input.limit;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_ROWS) {
        throw new AssistantToolArgumentError(`limit must be an integer from 1 to ${MAX_ROWS}.`);
      }
      const parsed = {
        projectId,
        collection: readName(input.collection, "collection"),
        limit: limit as number,
      };
      return { ...viewOf(projectId), parsed };
    },
    execute: async ({ projectId, collection, limit }, { principal }) => {
      const body = await readFromProject(reader, {
        projectId, principal, method: "POST",
        path: `zelavis/api/v1/database/documents/${encodeURIComponent(collection)}/query`,
        body: { tenantId: APP_TENANT, limit },
      });
      const documents = Array.isArray(body?.documents) ? body.documents : [];
      return {
        collection,
        records: documents.slice(0, limit).map((d: { id?: unknown; data?: unknown }) => ({
          id: d.id, data: d.data,
        })),
      };
    },
    describe: ({ projectId, collection }) => `Reading ${collection} in ${projectId}`,
  };
  return [listCollections, readCollection];
}

/**
 * Changes to a Project's lifecycle. None of them runs from the model's call:
 * each becomes a request a person approves, naming the Project by id.
 */
export function createProjectLifecycleTools(
  projects: () => ZelavisProjectManager | undefined,
): readonly AssistantTool<any>[] {
  const manager = () => {
    const value = projects();
    if (!value) throw new Error("Project management is unavailable on this installation.");
    return value;
  };
  const schema = {
    type: "object",
    properties: { projectId: { type: "string" } },
    required: ["projectId"],
    additionalProperties: false,
  } as const;

  function lifecycle(input: {
    name: string;
    description: string;
    permission: string;
    verb: string;
    irreversible?: boolean;
    run(id: string): Promise<unknown>;
  }): AssistantTool<{ projectId: string }> {
    return {
      name: input.name,
      description: input.description,
      parameters: schema,
      advertisedPermissions: [input.permission],
      access: (args) => {
        const parsed = readProjectId(args);
        return {
          permissions: [input.permission],
          scope: { type: "project", projectId: parsed.projectId },
          parsed,
        };
      },
      describe: ({ projectId }) => `${input.verb} Project ${projectId}`,
      mutation: {
        ...(input.irreversible ? { irreversible: true } : {}),
        target: ({ projectId }) => ({ kind: "project", id: projectId }),
        // Pinned to this Project's creation time: deleting and recreating a
        // Project under the same name must not inherit an earlier approval.
        fingerprint: async ({ projectId }) => {
          const project = await manager().get(projectId);
          if (!project) throw new Error(`Project "${projectId}" was not found.`);
          return `${project.id}@${project.createdAt}`;
        },
      },
      execute: async ({ projectId }) => input.run(projectId),
    };
  }

  return [
    lifecycle({
      name: "start_project",
      description: "Ask to start a stopped Project. A person must approve it.",
      permission: "project.runtime.manage",
      verb: "Start",
      run: (id) => manager().start(id),
    }),
    lifecycle({
      name: "stop_project",
      description: "Ask to stop a running Project. A person must approve it.",
      permission: "project.runtime.manage",
      verb: "Stop",
      run: (id) => manager().stop(id),
    }),
    lifecycle({
      name: "restart_project",
      description: "Ask to restart a Project. A person must approve it.",
      permission: "project.runtime.manage",
      verb: "Restart",
      run: (id) => manager().restart(id),
    }),
    lifecycle({
      name: "delete_project",
      description:
        "Ask to permanently delete a Project and all its data. A person must approve it and type the Project id.",
      permission: "project.delete",
      verb: "Delete",
      irreversible: true,
      run: async (id) => {
        if (!(await manager().remove(id))) throw new Error(`Project "${id}" was not found.`);
      },
    }),
  ];
}
