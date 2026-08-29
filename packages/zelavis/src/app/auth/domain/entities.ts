import type { ZelavisPrincipalGrant } from "../../../core/index.js";

export interface Account {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified: boolean;
  roles?: readonly string[];
  permissions?: readonly string[];
  grants?: readonly ZelavisPrincipalGrant[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  accountId: string;
  /** SHA-256 digest of the high-entropy client token. The token is never stored. */
  tokenHash: string;
  status: "active" | "revoked" | "expired";
  expiresAt: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssuedSession {
  session: Session;
  /** Returned only when the session is issued. */
  token: string;
}

export interface Credential {
  id: string;
  accountId: string;
  provider: string;
  identifier: string;
  secretHash?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthAttemptState {
  keyHash: string;
  failures: readonly Date[];
  blockedUntil?: Date;
  updatedAt: Date;
}

export interface AuthAuthorizationFlow {
  stateHash: string;
  provider: string;
  mode: "login" | "link";
  accountId?: string;
  redirectUri: string;
  codeVerifier: string;
  nonce: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface AuthSecurityEvent {
  id: string;
  type: "authentication.succeeded" | "authentication.failed" | "authentication.blocked";
  outcome: "success" | "failure" | "blocked";
  provider: string;
  /** Hash of the provider and normalized identifier; raw identifiers are not stored. */
  subjectHash: string;
  accountId?: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}
