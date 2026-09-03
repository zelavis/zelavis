/**
 * The Frontend contract.
 *
 * A Frontend is what a Project serves to its visitors. It is deliberately not a
 * "theme": a theme implies presentation over a content model the host owns,
 * while a Frontend may be a complete application that brings its own routing
 * and data. The retired website service tried to be the former and could only
 * ever render one fixed shape.
 *
 * Two runtimes, and the difference is a trust and resource decision rather than
 * a packaging detail:
 *
 * - `static` — files the Platform serves directly. Reuses the existing service
 *   app definition, including its SPA and MPA modes.
 * - `server` — an application with its own process, reached through the
 *   Project runtime and Gateway like any other hosted workload.
 *
 * The runtime is **declared**, never inferred. Guessing from the presence of a
 * `start` script is ambiguous — plenty of static builds have one — and it would
 * make whether Zelavis spawns a process depend on a heuristic.
 */
import type {
  ZelavisServiceAppDefinition,
  ZelavisServiceAppMode,
} from "./definition.js";
import type { ZelavisPackageManifest } from "./manifest.js";

export type ZelavisFrontendRuntime = "static" | "server";

export interface ZelavisStaticFrontendManifest {
  readonly runtime: "static";
  /** Directory of built files, relative to the package root. */
  readonly bundle: string;
  /** SPA rewrites unmatched paths to the index; MPA resolves them as files. */
  readonly mode?: ZelavisServiceAppMode;
  /** Entry document. Defaults to `index.html`. */
  readonly indexHtml?: string;
  /**
   * Path this bundle's own asset references were built against, e.g.
   * `/assets/`.
   *
   * Declaring it lets one build serve from any mount: the Platform rewrites
   * references starting with this prefix to wherever the frontend is actually
   * mounted, so a bundle built for `/` works at `/zelavis` without rebuilding.
   * Omit it when the bundle uses relative references or is built for its mount.
   */
  readonly assetBase?: string;
  /**
   * Global the Platform defines on the served page, holding the path this
   * frontend is mounted at.
   *
   * Asset rewriting moves references; it cannot tell a client-side router
   * where it lives, because that is a value the bundle reads rather than a
   * path in the markup. Declaring a global name gets that value into the page
   * without the Platform knowing anything about the framework: the bundle
   * decides what to do with it.
   *
   * Without this a bundle must be built for a fixed mount, which is what kept
   * a frontend from being installable anywhere but the path it was built for.
   */
  readonly basePathGlobal?: string;
}

export interface ZelavisServerFrontendManifest {
  readonly runtime: "server";
  /**
   * Command that starts the application, as argv.
   *
   * Argv rather than a shell string: a shell string would need quoting rules
   * and would let a manifest smuggle shell metacharacters into process
   * spawning.
   */
  readonly start: readonly string[];
  /**
   * Environment variable through which the Platform tells the application which
   * port to bind. Defaults to `PORT`.
   */
  readonly portEnv?: string;
}

export type ZelavisFrontendManifest =
  | ZelavisStaticFrontendManifest
  | ZelavisServerFrontendManifest;

export class ZelavisFrontendManifestError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisFrontendManifestError";
  }
}

function invalid(name: string, detail: string): never {
  throw new ZelavisFrontendManifestError(
    `Invalid Zelavis frontend "${name}":\n${detail}`,
  );
}

/** Rejects a bundle path that escapes the package or is absolute. */
function assertContainedPath(name: string, field: string, value: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    invalid(name, `"frontend.${field}" must stay inside the package.`);
  }
}

/**
 * Validates and normalizes the `zelavis.frontend` block of a package manifest.
 *
 * Returns `undefined` when the package is not a frontend, so callers can use it
 * as a discriminator without a separate check.
 */
export function readFrontendManifest(
  manifest: ZelavisPackageManifest,
): ZelavisFrontendManifest | undefined {
  const zelavis = manifest.zelavis;
  if (!zelavis || zelavis.kind !== "frontend") return undefined;

  const name = manifest.name;
  const frontend = (zelavis as Record<string, unknown>).frontend;
  if (!frontend || typeof frontend !== "object" || Array.isArray(frontend)) {
    invalid(name, 'a frontend must declare a "zelavis.frontend" object.');
  }

  const declared = frontend as Record<string, unknown>;
  const runtime = declared.runtime;

  if (runtime !== "static" && runtime !== "server") {
    invalid(
      name,
      '"frontend.runtime" must be "static" or "server". It is declared rather than inferred, because a server frontend runs a process and a static one does not.',
    );
  }

  if (runtime === "static") {
    const bundle = typeof declared.bundle === "string" ? declared.bundle.trim() : "";
    if (!bundle) {
      invalid(name, 'a static frontend must declare "frontend.bundle".');
    }
    assertContainedPath(name, "bundle", bundle);

    const mode = declared.mode;
    if (mode !== undefined && mode !== "spa" && mode !== "mpa") {
      invalid(name, '"frontend.mode" must be "spa" or "mpa".');
    }

    const indexHtml =
      typeof declared.indexHtml === "string" ? declared.indexHtml.trim() : undefined;
    if (indexHtml) assertContainedPath(name, "indexHtml", indexHtml);

    const assetBase =
      typeof declared.assetBase === "string" ? declared.assetBase.trim() : undefined;
    if (assetBase !== undefined) {
      if (!assetBase.startsWith("/") || !assetBase.endsWith("/")) {
        invalid(
          name,
          '"frontend.assetBase" must be an absolute directory path such as "/assets/". It is matched at the start of a quoted reference, so a partial path would rewrite text that is not a reference.',
        );
      }
      if (assetBase === "/") {
        invalid(
          name,
          '"frontend.assetBase" must be more specific than "/". Rewriting every absolute reference would also rewrite links to API routes, which are not the bundle\'s to move.',
        );
      }
    }

    const basePathGlobal =
      typeof declared.basePathGlobal === "string"
        ? declared.basePathGlobal.trim()
        : undefined;
    if (basePathGlobal !== undefined) {
      // The name is written into a script on the served page, so it has to be
      // a plain identifier. Anything else would let a manifest close the
      // assignment and append statements of its own.
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(basePathGlobal)) {
        invalid(
          name,
          '"frontend.basePathGlobal" must be a plain JavaScript identifier such as "__ZELAVIS_BASE_PATH__". It is written into a script tag on the served page.',
        );
      }
    }

    return Object.freeze({
      runtime: "static" as const,
      bundle,
      ...(mode ? { mode } : {}),
      ...(indexHtml ? { indexHtml } : {}),
      ...(assetBase ? { assetBase } : {}),
      ...(basePathGlobal ? { basePathGlobal } : {}),
    });
  }

  const start = declared.start;
  if (
    !Array.isArray(start) ||
    start.length === 0 ||
    start.some((part) => typeof part !== "string" || part.trim() === "")
  ) {
    invalid(
      name,
      'a server frontend must declare "frontend.start" as a non-empty array of command arguments.',
    );
  }

  const portEnv =
    typeof declared.portEnv === "string" ? declared.portEnv.trim() : undefined;
  if (portEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(portEnv)) {
    invalid(name, '"frontend.portEnv" must be a valid environment variable name.');
  }

  return Object.freeze({
    runtime: "server" as const,
    start: Object.freeze([...(start as string[])].map((part) => part.trim())),
    ...(portEnv ? { portEnv } : {}),
  });
}

/**
 * Projects a static frontend onto the existing service app definition.
 *
 * Static frontends deliberately reuse that machinery — bundles, SPA and MPA
 * resolution, and the shell — rather than growing a parallel file server.
 */
export function toServiceAppDefinition(
  frontend: ZelavisStaticFrontendManifest,
  options: { readonly mount?: string } = {},
): ZelavisServiceAppDefinition {
  return {
    mount: options.mount ?? "/",
    bundle: frontend.bundle,
    mode: frontend.mode ?? "spa",
    ...(frontend.indexHtml ? { indexHtml: frontend.indexHtml } : {}),
    ...(frontend.assetBase ? { assetBase: frontend.assetBase } : {}),
    ...(frontend.basePathGlobal
      ? { basePathGlobal: frontend.basePathGlobal }
      : {}),
  };
}

/**
 * Marketplace category every listed frontend carries.
 *
 * A well-known constant rather than a free-form string, so the dashboard can
 * offer "choose a frontend" without matching on prose.
 */
export const ZELAVIS_FRONTEND_MARKETPLACE_CATEGORY = "frontends";

/**
 * Package that a listed frontend must depend on to reach the Zelavis SDK.
 *
 * The SDK lives at the `zelavis/sdk` subpath, so the dependency is on the
 * package itself.
 */
const ZELAVIS_SDK_PACKAGE = "zelavis";

export class ZelavisFrontendListingError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisFrontendListingError";
  }
}

function dependsOnZelavis(manifest: ZelavisPackageManifest): boolean {
  for (const field of ["dependencies", "peerDependencies"] as const) {
    const declared = (manifest as Record<string, unknown>)[field];
    if (
      declared &&
      typeof declared === "object" &&
      !Array.isArray(declared) &&
      ZELAVIS_SDK_PACKAGE in (declared as Record<string, unknown>)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks the extra requirements a frontend must meet to be *listed* in the
 * marketplace.
 *
 * Deliberately separate from `readFrontendManifest`: a plain folder of HTML is
 * a perfectly valid frontend to upload and install, it simply cannot be listed.
 * Listing is a promise that the frontend integrates with Zelavis — that it can
 * consume the menu and content APIs rather than only rendering — and that
 * promise is only meaningful if it actually depends on the SDK.
 *
 * Throws on failure so a listing cannot be published with a silent gap.
 */
export function assertListableFrontend(
  manifest: ZelavisPackageManifest,
): ZelavisFrontendManifest {
  const frontend = readFrontendManifest(manifest);
  if (!frontend) {
    throw new ZelavisFrontendListingError(
      `"${manifest.name}" is not a frontend: it must declare "zelavis.kind": "frontend".`,
    );
  }

  const categories = manifest.zelavis?.marketplace &&
    typeof manifest.zelavis.marketplace === "object"
    ? (manifest.zelavis.marketplace as { categories?: unknown }).categories
    : undefined;

  const listed =
    Array.isArray(categories) &&
    categories.includes(ZELAVIS_FRONTEND_MARKETPLACE_CATEGORY);

  if (!listed) {
    throw new ZelavisFrontendListingError(
      `Frontend "${manifest.name}" must list the "${ZELAVIS_FRONTEND_MARKETPLACE_CATEGORY}" marketplace category to be published.`,
    );
  }

  if (!dependsOnZelavis(manifest)) {
    throw new ZelavisFrontendListingError(
      `Frontend "${manifest.name}" must depend on "${ZELAVIS_SDK_PACKAGE}" to be published.\n` +
        "A listed frontend is expected to use the Zelavis SDK — the menu and content APIs — rather than only rendering. " +
        "A frontend that does not integrate can still be uploaded and installed; it just cannot be listed.",
    );
  }

  return frontend;
}
