import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { ZelavisServerRoute } from "../../core/index.js";
import { ACCOUNT_ACCESS_BODY_BYTES, normalizeDelegatedAccess, projectAccountAccessProof } from "../access/access.js";
import { type AdministrationContext, managePermission, manageScope } from "../access/delegation.js";
import type { AuthAuthenticator } from "../core/authenticator.js";
import type { createInvitationAcceptance } from "../invitations/accept.js";
import { type createInvitations, invitationGatewayDigest, INVITATION_PAGE_LIMIT } from "../invitations/invitations.js";
import { AcceptInvitationInputSchema, CreateInvitationInputSchema, INVITATION_ID, InvitationPageSchema, PublicInvitationSchema } from "../invitations/tables.js";
import { callOf } from "./core.js";
import { errorBody, noStore, respond } from "./errors.js";
import { type SessionTransport, signInResponse } from "./session-transport.js";
import { userErrorResponse } from "./user-errors.js";

const strict = { onExcessProperty: "error" } as const;
const schemaFor = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema, strict).schema;

export function decodeInvitationInput(body: unknown) {
  const decoded = Schema.decodeUnknownExit(CreateInvitationInputSchema, strict)(body);
  return Exit.isSuccess(decoded) ? { email: decoded.value.email, access: normalizeDelegatedAccess(decoded.value.access) } : undefined;
}

const invitationSchema = schemaFor(PublicInvitationSchema);
export const invitationOperations = [
  { action: "list", method: "GET", path: "/invitations", summary: "List invitations", status: 200,
    responseSchema: schemaFor(InvitationPageSchema), query: true },
  { action: "create", method: "POST", path: "/invitations", summary: "Send an invitation", status: 201,
    responseSchema: invitationSchema, requestSchema: schemaFor(CreateInvitationInputSchema) },
  { action: "resend", method: "POST", path: "/invitations/:id/resend", summary: "Resend an invitation", status: 202,
    responseSchema: invitationSchema, hasId: true },
  { action: "revoke", method: "DELETE", path: "/invitations/:id", summary: "Revoke an invitation", status: 200,
    responseSchema: invitationSchema, hasId: true },
] as const;

export function invitationOperationSpec(operation: typeof invitationOperations[number], gateway = false): Pick<ZelavisServerRoute, "spec" | "maxRequestBodyBytes" | "invalidJsonBodyCode"> {
  const { action, status, summary, responseSchema } = operation;
  return {
    ...("requestSchema" in operation ? { maxRequestBodyBytes: ACCOUNT_ACCESS_BODY_BYTES, invalidJsonBodyCode: "invalid_invitation_input" } : {}),
    spec: {
      operationId: gateway ? `projectInvitations.${action}` : `authInvitations.${action}`,
      summary,
      tags: gateway ? ["runtime", "auth"] : ["auth"],
      pathParams: {
        ...(gateway ? { projectId: { type: "string", required: true } } : {}),
        ...("hasId" in operation ? { id: { type: "string", required: true } } : {}),
      },
      ...("query" in operation ? { queryParams: {
        limit: { type: "integer", description: "Page size, 1 to 100 (default 50)." },
        after: { type: "string", description: "The next cursor of the previous page." },
      } } : {}),
      ...("requestSchema" in operation ? { requestBody: { required: true, schema: operation.requestSchema } } : {}),
      responses: {
        [status]: { description: summary, schema: responseSchema },
        400: { description: "Invalid invitation or request" },
        403: { description: "Invitation administration or delegation forbidden" },
        409: { description: "Email delivery or Project unavailable" },
        429: { description: "Pending invitation limit reached" },
        503: { description: "Invitation store busy" },
      },
    },
  };
}

const REFUSALS = {
  account_access_forbidden: [403, "The caller cannot manage or delegate this invitation access."],
  invalid_invitation: [400, "This invitation is invalid or no longer available."],
  invalid_invitation_input: [400, "Enter a valid email address and invitation access."],
  invalid_invitation_page: [400, "Enter a valid invitation page size and cursor."],
  invitation_credentials_required: [400, "Choose a username and password to accept the invitation."],
  invitation_requires_sign_in: [409, "Sign in to the account that owns the invited email address."],
  invitation_limit: [429, "This runtime has reached its pending invitation limit."],
  invitation_rate_limited: [429, "Too many invitation attempts. Try again later."],
  email_unavailable: [409, "Email delivery is not available on this runtime."],
  username_taken: [409, "That username is taken."],
  role_not_found: [404, "The invitation assigns a role that does not exist."],
  role_expansion_limit: [400, "The invitation access would expand to more permissions and grants than an account may hold."],
  invitation_access_limit: [409, "The invitation would give the account more role assignments than it may hold."],
} as const;

export const invitationError = (code: keyof typeof REFUSALS, retryAfterMs?: number) => {
  const [status, message] = REFUSALS[code];
  return errorBody(status, code, message, retryAfterMs === undefined ? {} : {
    "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });
};

export function defineInvitationRoutes(options: {
  readonly management: ReturnType<typeof createInvitations>;
  readonly accept: ReturnType<typeof createInvitationAcceptance>;
  readonly context: AdministrationContext;
  readonly transport: SessionTransport;
  readonly authenticator: AuthAuthenticator;
}): ReadonlyArray<ZelavisServerRoute> {
  const { management, context: administration } = options;
  const scope = manageScope(administration);
  return [
    ...invitationOperations.map<ZelavisServerRoute>((operation) => ({
      ...invitationOperationSpec(operation),
      id: `auth.invitations.${operation.action}`,
      method: operation.method,
      path: operation.path,
      access: { permissions: [managePermission(administration)], ...(scope === undefined ? {} : { scope }) },
      handler: (context) => respond(Effect.gen(function* () {
        const { params, body, principal, query } = context;
        const id = params.id;
        if ("hasId" in operation && !INVITATION_ID.test(id ?? "")) return invitationError("invalid_invitation");
        const input = operation.action === "create" ? decodeInvitationInput(body) : undefined;
        if (operation.action === "create" && input === undefined) return invitationError("invalid_invitation_input");
        const path = operation.path.replace(":id", id ?? "");
        const actor = { principal, digest: yield* invitationGatewayDigest(operation.method, path, input) };
        const call = callOf(context);
        if (operation.action === "list") {
          const rawLimit = query.get("limit");
          const rawAfter = query.get("after");
          const limit = rawLimit === null ? 50 : /^\d{1,3}$/u.test(rawLimit) ? Number(rawLimit) : NaN;
          const cursor = rawAfter === null ? undefined : /^(\d{1,16}(?:\.\d{1,10})?):([0-9a-f]{32})$/u.exec(rawAfter);
          const createdAt = cursor?.[1] === undefined ? undefined : Number(cursor[1]);
          const id = cursor?.[2];
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > INVITATION_PAGE_LIMIT ||
              (rawAfter !== null && (createdAt === undefined || createdAt > Number.MAX_SAFE_INTEGER || id === undefined))) {
            return invitationError("invalid_invitation_page");
          }
          const result = yield* management.list(call, actor, limit, createdAt === undefined || id === undefined ? undefined : { createdAt, id });
          return result.ok ? { status: 200, headers: noStore, body: result.page } : invitationError(result.code);
        }
        const result = operation.action === "create" && input !== undefined ? yield* management.create(call, actor, input)
          : operation.action === "resend" ? yield* management.resend(call, actor, id)
          : yield* management.revoke(call, actor, id);
        return result.ok ? { status: operation.status, headers: noStore, body: result.invitation } : invitationError(result.code);
      })),
    })),
    {
      id: "auth.invitations.accept",
      method: "POST",
      path: "/invitations/accept",
      maxRequestBodyBytes: 4096,
      invalidJsonBodyCode: "invalid_invitation",
      spec: {
        operationId: "acceptInvitation",
        summary: "Accept an invitation",
        tags: ["auth"],
        requestBody: { required: true, schema: schemaFor(AcceptInvitationInputSchema) },
        responses: {
          200: { description: "Signed-in session or MFA challenge" },
          400: { description: "Invalid invitation or credentials" },
          401: { description: "Refresh an expired access token" },
          409: { description: "The invited account must sign in or the username is taken" },
          429: { description: "Too many attempts" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const { body, request, principal } = context;
        if (principal !== undefined && projectAccountAccessProof(principal) !== undefined) return invitationError("invalid_invitation");
        const decoded = Schema.decodeUnknownExit(AcceptInvitationInputSchema, strict)(body);
        if (Exit.isFailure(decoded)) return invitationError("invalid_invitation");
        const result = yield* options.accept(callOf(context), decoded.value);
        if (result.ok) return signInResponse(options.transport, request, result.outcome);
        if (result.code === "invitation_requires_sign_in" && principal === undefined && options.authenticator.expiredToken(request)) {
          return errorBody(401, "access_token_expired", "The access token expired; refresh the session.");
        }
        if (result.code === "invalid_credentials_input") return userErrorResponse(result.userError);
        return invitationError(result.code, result.code === "invitation_rate_limited" ? result.retryAfterMs : undefined);
      })),
    },
  ];
}
