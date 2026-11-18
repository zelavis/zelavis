import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { integration, present } from "../../core/runtime/effect-boundary.js";
import type { ZelavisAccessRequirement, ZelavisEndpointGroup, ZelavisRouteResponse, ZelavisServerRoute } from "../../core/runtime/contracts.js";
import { loadPlatformMasterSecret } from "../../platform/master-secret.js";
import type { ZelavisSystemStore } from "../../system-store.js";
import {
  decodeEmailTestInput,
  EMAIL_SETTINGS_BODY_BYTES,
  EMAIL_TEST_BODY_BYTES,
  emailDeliveryPageJsonSchema,
  emailSettingsInputJsonSchema,
  emailSettingsJsonSchema,
  emailTestInputJsonSchema,
} from "./contracts.js";
import { EMAIL_ERROR_RESPONSES, EmailSettingsInvalid, type EmailError } from "./errors.js";
import { createEmailOutbox, createEmailWorker, type EmailOutboxApi, type EmailSend } from "./outbox.js";
import { createEmailSettingsStore, unavailable, type EmailSettingsStore } from "./settings.js";

/**
 * A runtime's email subsystem: its settings, its outbox and the worker that empties it, all in the runtime's own
 * System Store. The Platform and every native App compose one each, so an App's mail never shares settings, queue or
 * credentials with the Platform's. Other subsystems enqueue through `outbox`; operators reach the `/email` routes.
 */

export interface EmailSubsystemOptions {
  readonly store: ZelavisSystemStore;
  readonly authority: "platform" | "project";
  /** The Project an App runtime serves; its routes require `project.settings.manage` for exactly this Project. */
  readonly projectId?: string;
  /** The transport attempts go through; a runtime without one keeps settings but cannot send. */
  readonly send?: EmailSend;
  readonly now?: () => Date;
  /** The runtime's master secret; defaults to the one kept in `store`. */
  readonly secret?: () => string | PromiseLike<string>;
  /** The longest the worker waits between passes without being woken. */
  readonly idleMs?: number;
}

export interface EmailSubsystem {
  readonly outbox: EmailOutboxApi;
  readonly settings: EmailSettingsStore;
  readonly endpointGroup: ZelavisEndpointGroup<EmailOutboxApi>;
  /** Starts the delivery loop. The runtime stops it when it closes. */
  start(): { readonly stop: () => Promise<void> };
  /** One delivery pass now. */
  runOnce(): Promise<void>;
}

const noStore = { "cache-control": "no-store" };

const errorResponse = (error: EmailError): ZelavisRouteResponse => {
  const { status, code } = EMAIL_ERROR_RESPONSES[error._tag];
  return {
    status,
    headers: noStore,
    body: { error: error.message, code, ...(error._tag === "EmailSettingsConflict" ? { revision: error.revision } : {}) },
  };
};

const respond = <A>(status: number, program: Effect.Effect<A, EmailError>) => present(program.pipe(
  Effect.map((body): ZelavisRouteResponse => ({ status, headers: noStore, body })),
  Effect.catch((error) => Effect.succeed(errorResponse(error))),
));

/** Waits without holding the process open. */
const idle = (millis: number) => Effect.callback<void>((resume) => {
  const timer = setTimeout(() => resume(Effect.void), millis);
  (timer as { unref?: () => void }).unref?.();
  return Effect.sync(() => clearTimeout(timer));
});

const TEST_TEXT = "This is a test message from Zelavis. If it reached you, this runtime's email delivery works.";
const TEST_HTML = "<p>This is a test message from Zelavis. If it reached you, this runtime's email delivery works.</p>";

export function createEmailSubsystem(options: EmailSubsystemOptions): EmailSubsystem {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const idleMs = options.idleMs ?? 15_000;
  let cachedSecret: string | undefined;
  const loadSecret = options.secret ?? (() => loadPlatformMasterSecret(store));
  const secret = Effect.suspend(() => cachedSecret !== undefined
    ? Effect.succeed(cachedSecret)
    : integration(loadSecret).pipe(
        Effect.tap((value) => Effect.sync(() => { cachedSecret = value; })),
        Effect.mapError(() => unavailable("The runtime's master secret is unavailable.")),
      ));
  const settings = createEmailSettingsStore(store, secret, now);
  const signals = Effect.runSync(Queue.sliding<true>(1));
  const outbox = createEmailOutbox({
    store, secret, settings, now, canSend: options.send !== undefined,
    wake: () => { Queue.offerUnsafe(signals, true); },
  });
  const worker = options.send ? createEmailWorker({ store, secret, settings, send: options.send, now }) : undefined;

  const pass = worker
    ? worker.pass.pipe(Effect.catchCause((cause) => Effect.as(Effect.logError("An email delivery pass failed", cause), Number.POSITIVE_INFINITY)))
    : Effect.succeed(Number.POSITIVE_INFINITY);

  const access: ZelavisAccessRequirement = options.authority === "platform"
    ? { permissions: ["system.settings.manage"], scope: { type: "system" } }
    : {
        permissions: ["project.settings.manage"],
        ...(options.projectId ? { scope: { type: "project", projectId: options.projectId } } : {}),
      };
  const tags = ["email"];
  const routes: readonly ZelavisServerRoute<EmailOutboxApi>[] = [
    {
      id: "email.settings.get",
      method: "GET",
      path: "/settings",
      access,
      spec: {
        operationId: "emailSettings",
        summary: "Read the runtime's email delivery settings",
        description: "The SMTP password is never returned; `smtp.hasPassword` says whether one is stored.",
        tags,
        responses: {
          200: { description: "Email settings and revision", schema: emailSettingsJsonSchema },
          503: { description: "Email unavailable" },
        },
      },
      handler: () => respond(200, settings.view()),
    },
    {
      id: "email.settings.set",
      method: "PUT",
      path: "/settings",
      access,
      maxRequestBodyBytes: EMAIL_SETTINGS_BODY_BYTES,
      invalidJsonBodyCode: "invalid_email_settings",
      spec: {
        operationId: "setEmailSettings",
        summary: "Update the runtime's email delivery settings",
        description: "Pass `expectedRevision` from the last read. An absent `smtp.password` keeps the stored one for the same host and username; `\"\"` removes it.",
        tags,
        requestBody: { required: true, schema: emailSettingsInputJsonSchema },
        responses: {
          200: { description: "Updated email settings", schema: emailSettingsJsonSchema },
          400: { description: "Invalid email settings" },
          409: { description: "Settings revision has changed" },
          413: { description: `Request exceeds ${EMAIL_SETTINGS_BODY_BYTES} bytes` },
          503: { description: "Email unavailable" },
        },
      },
      handler: ({ body }) => respond(200, settings.update(body)),
    },
    {
      id: "email.test.send",
      method: "POST",
      path: "/test",
      access,
      maxRequestBodyBytes: EMAIL_TEST_BODY_BYTES,
      invalidJsonBodyCode: "invalid_email_settings",
      spec: {
        operationId: "sendTestEmail",
        summary: "Queue a test message to one address",
        description: "Answers once the message is queued; follow it in the deliveries listing.",
        tags,
        requestBody: { required: true, schema: emailTestInputJsonSchema },
        responses: {
          202: { description: "Queued delivery id" },
          400: { description: "Invalid address" },
          409: { description: "Email is disabled" },
          429: { description: "Too many deliveries waiting" },
          503: { description: "Email unavailable" },
        },
      },
      handler: ({ body }) => respond(202, Effect.gen(function* () {
        const input = yield* Effect.try({
          try: () => decodeEmailTestInput(body),
          catch: () => new EmailSettingsInvalid({ message: "A test email needs one valid address in `to`." }),
        });
        return yield* outbox.enqueue({ to: input.to, kind: "test", subject: "Zelavis test email", text: TEST_TEXT, html: TEST_HTML });
      })),
    },
    {
      id: "email.deliveries.list",
      method: "GET",
      path: "/deliveries",
      access,
      spec: {
        operationId: "listEmailDeliveries",
        summary: "List this runtime's email deliveries, oldest first",
        description: "Recipients and states only; message content is never returned. Delivered and failed entries are kept for seven days.",
        tags,
        queryParams: {
          limit: { type: "integer", description: "Page size, 1-100 (default 50)." },
          after: { type: "string", description: "The `next` cursor of the previous page." },
        },
        responses: {
          200: { description: "A page of deliveries", schema: emailDeliveryPageJsonSchema },
          400: { description: "Invalid limit or cursor" },
          503: { description: "Email unavailable" },
        },
      },
      handler: ({ query }) => respond(200, Effect.gen(function* () {
        const rawLimit = query.get("limit");
        const limit = rawLimit === null ? 50 : /^\d{1,3}$/u.test(rawLimit) ? Number(rawLimit) : 0;
        if (limit < 1 || limit > 100) return yield* new EmailSettingsInvalid({ message: "`limit` must be between 1 and 100." });
        const after = query.get("after");
        return yield* outbox.list({ limit, ...(after === null ? {} : { after }) });
      })),
    },
  ];

  return {
    outbox,
    settings,
    endpointGroup: { id: "email", basePath: "/email", api: { v1: routes }, context: outbox, origin: { type: "subsystem", subsystem: "email" } },
    runOnce: () => present(Effect.asVoid(pass)),
    start: () => {
      const running = Effect.runFork(Effect.gen(function* () {
        for (;;) {
          const next = yield* pass;
          const wait = Math.max(0, Math.min(idleMs, next - now().getTime()));
          yield* Effect.raceFirst(Queue.take(signals), idle(wait));
        }
      }));
      return { stop: () => present(Fiber.interrupt(running)) };
    },
  };
}
