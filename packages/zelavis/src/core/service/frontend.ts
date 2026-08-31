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

    return Object.freeze({
      runtime: "static" as const,
      bundle,
      ...(mode ? { mode } : {}),
      ...(indexHtml ? { indexHtml } : {}),
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
  };
}
