import type { AccountRepository, SessionRepository } from "../contracts/repositories.js";
import type { IssuedSession, Session } from "../domain/entities.js";
import { IdentityValidationError } from "../core/errors.js";

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new IdentityValidationError("Secure Web Crypto is required for sessions.");
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

/**
 * Sessions, with two guarantees that hold when requests arrive together.
 *
 * **A session token can be rotated exactly once.** Rotation consumes the old
 * session with an atomic compare-and-transition before issuing the next, so two
 * racing rotations yield one new session and one refusal. Consuming first means
 * a crash in between leaves the caller signed out, never with two live tokens.
 *
 * **Revoke-all is not outrun by a session being issued.** Each account carries
 * a `sessionEpoch`; a session is valid only while its own epoch matches. Revoke
 * all bumps the epoch atomically, so a session created or rotated at the same
 * moment, holding the old epoch, dies with the rest.
 */
export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly accounts: Pick<AccountRepository, "findById" | "mutate">,
  ) {}

  private async currentEpoch(accountId: string): Promise<number> {
    return (await this.accounts.findById(accountId))?.sessionEpoch ?? 0;
  }

  async create(input: CreateSessionInput): Promise<IssuedSession> {
    if (!input.accountId) {
      throw new IdentityValidationError("Session creation requires an accountId.");
    }

    return this.issue(input, await this.currentEpoch(input.accountId));
  }

  private async issue(input: CreateSessionInput, epoch: number): Promise<IssuedSession> {
    if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) {
      throw new IdentityValidationError("Session creation requires a valid expiry.");
    }
    const now = new Date();
    if (input.expiresAt <= now) {
      throw new IdentityValidationError("Session expiry must be in the future.");
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
      epoch,
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
    // Issued before the account's sessions were last revoked.
    if ((session.epoch ?? 0) !== (await this.currentEpoch(session.accountId))) return null;
    return session;
  }

  async revoke(id: string): Promise<Session | null> {
    return this.repository.mutate(id, (session) =>
      session ? { ...session, status: "revoked", updatedAt: new Date() } : null,
    );
  }

  async rotate(id: string): Promise<IssuedSession | null> {
    const now = new Date();
    const current = await this.repository.findById(id);
    if (!current || current.status !== "active" || current.expiresAt <= now) {
      return null;
    }
    const epoch = current.epoch ?? 0;
    if (epoch !== (await this.currentEpoch(current.accountId))) return null;

    // Exactly one caller flips active -> revoked; the mutation can run again
    // if another writer lands first, so the outcome is decided on each pass.
    let consumed = false;
    await this.repository.mutate(id, (session) => {
      consumed = false;
      if (!session || session.status !== "active" || session.expiresAt <= now) return session;
      consumed = true;
      return { ...session, status: "revoked", updatedAt: new Date() };
    });
    if (!consumed) return null;

    const lifetime = Math.max(1, current.expiresAt.getTime() - current.createdAt.getTime());
    // Stamped with the epoch it was rotated from, not a fresh read: a revoke-all
    // that lands in between must still invalidate it.
    const next = await this.issue(
      {
        accountId: current.accountId,
        expiresAt: new Date(now.getTime() + lifetime),
        metadata: current.metadata,
      },
      epoch,
    );
    if (epoch !== (await this.currentEpoch(current.accountId))) {
      await this.revoke(next.session.id);
      return null;
    }
    return next;
  }

  async findById(id: string): Promise<Session | null> {
    return this.repository.findById(id);
  }

  async listByAccountId(accountId: string): Promise<Session[]> {
    return this.repository.listByAccountId(accountId);
  }

  async revokeAll(
    accountId: string,
    options: { exceptSessionId?: string } = {},
  ): Promise<Session[]> {
    // The invalidation itself: one atomic step, so nothing issued from an
    // earlier epoch can outlive it.
    let epoch: number | undefined;
    await this.accounts.mutate(accountId, (account) => {
      epoch = undefined;
      if (!account) return account;
      epoch = (account.sessionEpoch ?? 0) + 1;
      return { ...account, sessionEpoch: epoch, updatedAt: new Date() };
    });

    // The session the caller is keeping moves to the new epoch. Not atomic with
    // the bump, so it is briefly unusable, which is the safe direction; a second
    // revoke-all landing after it bumps past it again and correctly ends it.
    if (options.exceptSessionId && epoch !== undefined) {
      const keptEpoch = epoch;
      await this.repository.mutate(options.exceptSessionId, (session) =>
        session && session.status === "active" && session.accountId === accountId
          ? { ...session, epoch: keptEpoch, updatedAt: new Date() }
          : session,
      );
    }

    // Status is kept accurate for listings and the returned set.
    const sessions = await this.repository.listByAccountId(accountId);
    const revoked: Session[] = [];
    for (const session of sessions) {
      if (
        session.status !== "active" ||
        session.id === options.exceptSessionId
      ) {
        continue;
      }
      const updated = await this.revoke(session.id);
      if (updated) revoked.push(updated);
    }
    return revoked;
  }
}
