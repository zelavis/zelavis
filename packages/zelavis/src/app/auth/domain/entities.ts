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
