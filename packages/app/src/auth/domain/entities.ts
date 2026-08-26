export interface Account {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  accountId: string;
  status: "active" | "revoked" | "expired";
  expiresAt: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
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
