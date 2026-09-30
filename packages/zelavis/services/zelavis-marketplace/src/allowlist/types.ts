/**
 * The marketplace allow-list.
 *
 * The marketplace does not host code. Services live on npm and this list is the
 * set of them an installation may install: which packages, at exactly which
 * versions, with the digest each must have. Installing a service executes its
 * code with Platform authority, so "is this on the list" is the trust decision,
 * and everything else in this folder exists to make the answer trustworthy: the
 * list is signed, it can only move forward, and it may be fetched from several
 * places because a signed list is safe to fetch from anywhere.
 */

export type AllowlistServiceKind = "app" | "plugin" | "frontend";

export interface AllowlistVersion {
  /** Exact semver. A range or a tag is never an allow-listed version. */
  readonly version: string;
  /** npm subresource integrity of the published tarball (`sha512-…`). */
  readonly integrity: string;
  /** Set when a version should no longer be chosen; it stays installable. */
  readonly deprecated?: string;
}

export interface AllowlistService {
  /** Full npm package name, scope included. */
  readonly name: string;
  readonly kind: AllowlistServiceKind;
  /** Who maintains it: `zelavis` for the officially maintained services. */
  readonly maintainer: string;
  readonly title: string;
  readonly summary?: string;
  readonly categories?: readonly string[];
  readonly tags?: readonly string[];
  /** Runtime families a Project recipe supports. */
  readonly runtimeKinds?: readonly string[];
  /**
   * The list vouches that this recipe may provide the runtime its Projects run
   * under (its package ships host code that starts and stops processes). An
   * installation only lets a recipe do that when its allow-list entry says so.
   */
  readonly projectRuntime?: boolean;
  readonly versions: readonly AllowlistVersion[];
  /** The version the marketplace offers by default; always one of `versions`. */
  readonly latest: string;
}

export interface Allowlist {
  readonly schemaVersion: 1;
  /**
   * Strictly increasing with every issued list. A client never accepts a lower
   * one than it has already seen, which is what stops an old (validly signed)
   * list from being replayed to re-open a service that was removed.
   */
  readonly sequence: number;
  readonly issuedAt: string;
  /** After this the list is no longer used to install anything new. */
  readonly expiresAt: string;
  readonly services: readonly AllowlistService[];
}

/** What is published: the list, signed. Static JSON today, an API later. */
export interface AllowlistEnvelope {
  /** Identifies the trusted key that signed `payload`. */
  readonly keyId: string;
  /** base64url of the UTF-8 JSON of an `Allowlist`. */
  readonly payload: string;
  /** base64url Ed25519 signature over `SIGNING_CONTEXT + payload`. */
  readonly signature: string;
}

export const ALLOWLIST_SIGNING_CONTEXT = "zelavis-allowlist-v1\n";
export const ALLOWLIST_MAX_BYTES = 512 * 1024;
