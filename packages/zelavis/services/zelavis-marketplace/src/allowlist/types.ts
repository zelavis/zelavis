/**
 * The marketplace allow-list.
 *
 * The marketplace does not host code. Services live on npm and this list is the
 * set of them an installation may install: which packages, at exactly which
 * versions, with the digest each must have. Installing a service executes its
 * code with Platform authority, so "is this on the list" is the trust decision.
 * The list is a plain JSON file served over https from zelavis.com, so that
 * origin is the trust anchor, as it is for the installer. It can only move
 * forward, and it expires.
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
  readonly hostPackages?: readonly string[];
  readonly versions: readonly AllowlistVersion[];
  /** The version the marketplace offers by default; always one of `versions`. */
  readonly latest: string;
}

export interface Allowlist {
  readonly schemaVersion: 1;
  /**
   * Strictly increasing with every issued list. A client never accepts a lower
   * one than it has already seen, which is what stops an old list from being
   * replayed to re-open a service that was removed.
   */
  readonly sequence: number;
  readonly issuedAt: string;
  /** After this the list is no longer used to install anything new. */
  readonly expiresAt: string;
  readonly services: readonly AllowlistService[];
}

export const ALLOWLIST_MAX_BYTES = 512 * 1024;
