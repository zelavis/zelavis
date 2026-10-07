import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
import type {
  AuthAttemptRepository,
  AuthSecurityEventRepository,
} from "../contracts/repositories.js";
import type { AuthSecurityEvent } from "../domain/entities.js";
import { AuthRateLimitError, IdentityValidationError } from "../core/errors.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_BLOCK_MS = 15 * 60 * 1_000;

export interface AuthSecurityServiceOptions {
  attempts: AuthAttemptRepository;
  events: AuthSecurityEventRepository;
  maxAttempts?: number;
  windowMs?: number;
  blockMs?: number;
}

export interface AuthAttemptContext {
  provider: string;
  subjectHash: string;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new IdentityValidationError("Auth security limits must be positive integers.");
  }
  return value;
}

function sha256(value: string): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
  const input = new TextEncoder().encode(value);
  const bytes = new Uint8Array(input.byteLength);
  bytes.set(input);
  const digest = (yield* integrationValue(crypto.subtle.digest("SHA-256", bytes.buffer)));
  return (yield* integrationValue([...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")));
}));
  }

export class AuthSecurityService {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly blockMs: number;

  constructor(private readonly options: AuthSecurityServiceOptions) {
    this.maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
    this.blockMs = positiveInteger(options.blockMs, DEFAULT_BLOCK_MS);
  }

  private event(
    context: AuthAttemptContext,
    input: Omit<AuthSecurityEvent, "id" | "provider" | "subjectHash" | "occurredAt">,
  ): Promise<void> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    (yield* integrationValue(self.options.events.append({
      id: `security_event_${crypto.randomUUID()}`,
      provider: context.provider,
      subjectHash: context.subjectHash,
      occurredAt: new Date(),
      ...input,
    })));
  }));
  }

  beginAuthentication(
    provider: string,
    input: unknown,
    now = new Date(),
  ): Promise<AuthAttemptContext> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<AuthAttemptContext, IntegrationFailure> {
    const identifier = input && typeof input === "object" &&
      typeof (input as { identifier?: unknown }).identifier === "string"
      ? (input as { identifier: string }).identifier.trim().toLowerCase()
      : "unknown";
    const context = {
      provider,
      subjectHash: (yield* integrationValue(sha256(`${provider}\u0000${identifier}`))),
    };
    const state = (yield* integrationValue(self.options.attempts.findByKeyHash(context.subjectHash)));
    if (state?.blockedUntil && state.blockedUntil > now) {
      (yield* integrationValue(self.event(context, {
        type: "authentication.blocked",
        outcome: "blocked",
      })));
      throw new AuthRateLimitError(
        (state.blockedUntil.getTime() - now.getTime()) / 1_000,
      );
    }
    return context;
  }));
  }

  authenticationFailed(
    context: AuthAttemptContext,
    now = new Date(),
  ): Promise<void> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    (yield* integrationValue(self.options.attempts.mutate(context.subjectHash, (current) => {
      const cutoff = now.getTime() - self.windowMs;
      const failures = [
        ...(current?.failures ?? []).filter((failure) => failure.getTime() >= cutoff),
        now,
      ].slice(-self.maxAttempts);
      return {
        keyHash: context.subjectHash,
        failures,
        blockedUntil: failures.length >= self.maxAttempts
          ? new Date(now.getTime() + self.blockMs)
          : undefined,
        updatedAt: now,
      };
    })));
    (yield* integrationValue(self.event(context, {
      type: "authentication.failed",
      outcome: "failure",
    })));
  }));
  }

  authenticationSucceeded(
    context: AuthAttemptContext,
    accountId: string,
  ): Promise<void> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    (yield* integrationValue(self.options.attempts.mutate(context.subjectHash, () => null)));
    (yield* integrationValue(self.event(context, {
      type: "authentication.succeeded",
      outcome: "success",
      accountId,
    })));
  }));
  }

  listEvents(): Promise<AuthSecurityEvent[]> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<AuthSecurityEvent[], IntegrationFailure> {
    return (yield* integrationValue(((yield* integrationValue(self.options.events.list()))).sort(
      (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime(),
    )));
  }));
  }
}
