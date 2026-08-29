import type {
  AuthAttemptRepository,
  AuthSecurityEventRepository,
} from "../contracts/repositories.js";
import type { AuthSecurityEvent } from "../domain/entities.js";
import { AuthRateLimitError, AuthValidationError } from "../core/errors.js";

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
    throw new AuthValidationError("Auth security limits must be positive integers.");
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const input = new TextEncoder().encode(value);
  const bytes = new Uint8Array(input.byteLength);
  bytes.set(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

  private async event(
    context: AuthAttemptContext,
    input: Omit<AuthSecurityEvent, "id" | "provider" | "subjectHash" | "occurredAt">,
  ): Promise<void> {
    await this.options.events.append({
      id: `security_event_${crypto.randomUUID()}`,
      provider: context.provider,
      subjectHash: context.subjectHash,
      occurredAt: new Date(),
      ...input,
    });
  }

  async beginAuthentication(
    provider: string,
    input: unknown,
    now = new Date(),
  ): Promise<AuthAttemptContext> {
    const identifier = input && typeof input === "object" &&
      typeof (input as { identifier?: unknown }).identifier === "string"
      ? (input as { identifier: string }).identifier.trim().toLowerCase()
      : "unknown";
    const context = {
      provider,
      subjectHash: await sha256(`${provider}\u0000${identifier}`),
    };
    const state = await this.options.attempts.findByKeyHash(context.subjectHash);
    if (state?.blockedUntil && state.blockedUntil > now) {
      await this.event(context, {
        type: "authentication.blocked",
        outcome: "blocked",
      });
      throw new AuthRateLimitError(
        (state.blockedUntil.getTime() - now.getTime()) / 1_000,
      );
    }
    return context;
  }

  async authenticationFailed(
    context: AuthAttemptContext,
    now = new Date(),
  ): Promise<void> {
    await this.options.attempts.mutate(context.subjectHash, (current) => {
      const cutoff = now.getTime() - this.windowMs;
      const failures = [
        ...(current?.failures ?? []).filter((failure) => failure.getTime() >= cutoff),
        now,
      ].slice(-this.maxAttempts);
      return {
        keyHash: context.subjectHash,
        failures,
        blockedUntil: failures.length >= this.maxAttempts
          ? new Date(now.getTime() + this.blockMs)
          : undefined,
        updatedAt: now,
      };
    });
    await this.event(context, {
      type: "authentication.failed",
      outcome: "failure",
    });
  }

  async authenticationSucceeded(
    context: AuthAttemptContext,
    accountId: string,
  ): Promise<void> {
    await this.options.attempts.mutate(context.subjectHash, () => null);
    await this.event(context, {
      type: "authentication.succeeded",
      outcome: "success",
      accountId,
    });
  }

  async listEvents(): Promise<AuthSecurityEvent[]> {
    return (await this.options.events.list()).sort(
      (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime(),
    );
  }
}
