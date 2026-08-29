import type { SessionRepository } from "../contracts/repositories.js";
import type { IssuedSession, Session } from "../domain/entities.js";
import { AuthValidationError } from "../core/errors.js";

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new AuthValidationError("Secure Web Crypto is required for sessions.");
  }
  return globalThis.crypto;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hashToken(token: string): Promise<string> {
  const digest = await requireCrypto().subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toBase64Url(new Uint8Array(digest));
}

export interface CreateSessionInput {
  accountId: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export class SessionService {
  constructor(private readonly repository: SessionRepository) {}

  async create(input: CreateSessionInput): Promise<IssuedSession> {
    if (!input.accountId) {
      throw new AuthValidationError("Session creation requires an accountId.");
    }

    if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) {
      throw new AuthValidationError("Session creation requires a valid expiry.");
    }
    const now = new Date();
    if (input.expiresAt <= now) {
      throw new AuthValidationError("Session expiry must be in the future.");
    }
    const tokenBytes = new Uint8Array(32);
    requireCrypto().getRandomValues(tokenBytes);
    const token = `zvs_${toBase64Url(tokenBytes)}`;
    const session = await this.repository.create({
      id: `session_${globalThis.crypto.randomUUID()}`,
      accountId: input.accountId,
      tokenHash: await hashToken(token),
      expiresAt: input.expiresAt,
      metadata: input.metadata,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { session, token };
  }

  async resolveToken(token: string, now = new Date()): Promise<Session | null> {
    if (!token) return null;
    const session = await this.repository.findByTokenHash(await hashToken(token));
    if (!session || session.status !== "active") return null;
    if (session.expiresAt <= now) {
      await this.repository.update({ ...session, status: "expired", updatedAt: now });
      return null;
    }
    return session;
  }

  async revoke(id: string): Promise<Session | null> {
    const session = await this.repository.findById(id);
    if (!session) return null;
    return this.repository.update({
      ...session,
      status: "revoked",
      updatedAt: new Date(),
    });
  }

  async rotate(id: string): Promise<IssuedSession | null> {
    const current = await this.repository.findById(id);
    const now = new Date();
    if (!current || current.status !== "active" || current.expiresAt <= now) {
      return null;
    }
    const lifetime = Math.max(1, current.expiresAt.getTime() - current.createdAt.getTime());
    const next = await this.create({
      accountId: current.accountId,
      expiresAt: new Date(now.getTime() + lifetime),
      metadata: current.metadata,
    });
    await this.revoke(current.id);
    return next;
  }

  async findById(id: string): Promise<Session | null> {
    return this.repository.findById(id);
  }

  async listByAccountId(accountId: string): Promise<Session[]> {
    return this.repository.listByAccountId(accountId);
  }
}
