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
}

export type AssistantToolRefusalCode =
  | "unknown_tool"
  | "invalid_arguments"
  | "forbidden"
  | "audit_unavailable"
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
      };
    };

export interface AssistantToolAuditRecord {
  readonly id: string;
  readonly at: string;
  readonly principalId: string;
  readonly tool: string;
  readonly arguments: string;
  readonly decision: "allowed" | "denied" | "invalid" | "failed";
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
  ): Promise<AssistantToolResult>;
}

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
    advertise(principal) {
      return options.tools
        .filter((tool) =>
          // Offered when the caller holds every permission the tool can ask
          // for, at some scope. The exact scope is decided per call.
          tool.advertisedPermissions.every((p) => holdsAtAnyScope(principal, p)),
        )
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
    },

    async run(principal, call) {
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

      // Fail closed: an action that cannot be recorded does not happen.
      if (!(await record(principal, tool.name, call.arguments, "allowed"))) {
        return auditUnavailable(tool.name);
      }

      try {
        const value = await tool.execute(parsed, { principal });
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

function readProjectId(value: unknown): { projectId: string } {
  const projectId = readObject(value).projectId;
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 128) {
    throw new AssistantToolArgumentError("projectId must be a non-empty string.");
  }
  return { projectId: projectId.trim() };
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
  };
  return [listProjects, getProject, projectLogs];
}
