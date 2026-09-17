import type { ZelavisDeploymentBackendCapabilities } from "./backends/registry.js";

/**
 * Whether an unmet isolation requirement refuses the Project or is reported.
 *
 * `required` is never downgraded: a backend that cannot prove it refuses
 * creation and start. `advisory` is reported on the Project record and never
 * changes where or whether it runs.
 */
export type ZelavisIsolationEnforcement = "required" | "advisory";

/** Boundary strength, weakest first. */
export type ZelavisIsolationBoundary = "process" | "os-container" | "microvm";

export type ZelavisIsolationDimension =
  | "filesystem"
  | "process"
  | "network";

/** A resource a backend can bound per Project. */
export type ZelavisResourceControl = "cpu" | "memory" | "pids" | "disk";

/**
 * A per-Project ceiling, in the unit its key names. Quantities are locked with
 * the recipe and handed to the driver in the recipe lock; they are a limit the
 * backend must enforce, not a reservation or a scheduling request.
 */
export interface ZelavisResourceLimitIntent {
  readonly limit: number;
  readonly enforcement: ZelavisIsolationEnforcement;
}

export interface ZelavisProjectResourceIntent {
  readonly cpuMillicores?: ZelavisResourceLimitIntent;
  readonly memoryMiB?: ZelavisResourceLimitIntent;
  readonly pids?: ZelavisResourceLimitIntent;
  readonly diskMiB?: ZelavisResourceLimitIntent;
}

/**
 * Isolation a Project recipe declares for the Projects created from it.
 *
 * Declared in the recipe's `package.json` under `zelavis.project.isolation` and
 * locked with the exact recipe version, so a Platform update never weakens the
 * intent of an existing Project. It states what must hold, never which backend
 * to use: backend choice remains administrator policy.
 */
export interface ZelavisProjectIsolationIntent {
  readonly boundary?: {
    readonly minimum: ZelavisIsolationBoundary;
    readonly enforcement: ZelavisIsolationEnforcement;
  };
  readonly filesystem?: ZelavisIsolationEnforcement;
  readonly process?: ZelavisIsolationEnforcement;
  readonly network?: ZelavisIsolationEnforcement;
  readonly resources?: ZelavisProjectResourceIntent;
}

export interface ZelavisProjectIsolationShortfall {
  readonly requirement:
    | "boundary"
    | ZelavisIsolationDimension
    | `resources.${keyof ZelavisProjectResourceIntent}`;
  readonly enforcement: ZelavisIsolationEnforcement;
  /** Boundary name, or `available` for a dimension. */
  readonly expected: string;
  /** What the assigned backend advertises; `unknown` when nothing describes it. */
  readonly actual: string;
}

export interface ZelavisProjectIsolationAssessment {
  readonly runtimeKind: string;
  /** Every `required` requirement holds. Advisory shortfalls do not affect it. */
  readonly satisfied: boolean;
  readonly shortfalls: readonly ZelavisProjectIsolationShortfall[];
}

const BOUNDARY_ORDER: readonly ZelavisIsolationBoundary[] = [
  "process",
  "os-container",
  "microvm",
];

const DIMENSION_CAPABILITY = {
  filesystem: "filesystemIsolation",
  process: "processIsolation",
  network: "networkIsolation",
} as const satisfies Record<
  ZelavisIsolationDimension,
  keyof ZelavisDeploymentBackendCapabilities
>;

const DIMENSIONS = Object.keys(DIMENSION_CAPABILITY) as ZelavisIsolationDimension[];

/** Resource key → backend control and the inclusive integer bounds accepted. */
const RESOURCE_LIMITS = {
  cpuMillicores: { control: "cpu", minimum: 10, maximum: 1_024_000 },
  memoryMiB: { control: "memory", minimum: 16, maximum: 16_777_216 },
  pids: { control: "pids", minimum: 8, maximum: 4_194_304 },
  diskMiB: { control: "disk", minimum: 16, maximum: 1_073_741_824 },
} as const satisfies Record<
  keyof ZelavisProjectResourceIntent,
  { control: ZelavisResourceControl; minimum: number; maximum: number }
>;

const RESOURCE_KEYS = Object.keys(RESOURCE_LIMITS) as (keyof ZelavisProjectResourceIntent)[];

function normalizeResourceIntent(value: unknown): ZelavisProjectResourceIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project isolation resources must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const resources: {
    -readonly [K in keyof ZelavisProjectResourceIntent]: ZelavisProjectResourceIntent[K];
  } = {};
  for (const key of Object.keys(raw)) {
    if (!RESOURCE_KEYS.includes(key as keyof ZelavisProjectResourceIntent)) {
      throw new Error(`Unknown Project resource limit "${key}".`);
    }
    const bounds = RESOURCE_LIMITS[key as keyof ZelavisProjectResourceIntent];
    const entry = raw[key] as Record<string, unknown> | null;
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((field) => field !== "limit" && field !== "enforcement") ||
      !Number.isSafeInteger(entry.limit) ||
      (entry.limit as number) < bounds.minimum ||
      (entry.limit as number) > bounds.maximum ||
      !isEnforcement(entry.enforcement)
    ) {
      throw new Error(
        `Project resource limit "${key}" must be { limit: integer ${bounds.minimum}..${bounds.maximum}, enforcement: required | advisory }.`,
      );
    }
    resources[key as keyof ZelavisProjectResourceIntent] = Object.freeze({
      limit: entry.limit as number,
      enforcement: entry.enforcement,
    });
  }
  return Object.keys(resources).length > 0 ? Object.freeze(resources) : undefined;
}

function isEnforcement(value: unknown): value is ZelavisIsolationEnforcement {
  return value === "required" || value === "advisory";
}

/**
 * Validates declared intent. Unknown keys are refused rather than ignored: a
 * misspelt requirement that silently vanished would run the Project weaker
 * than its author asked for.
 *
 * Throws a plain `Error`; callers attach their own error type.
 */
export function normalizeProjectIsolationIntent(
  value: unknown,
): ZelavisProjectIsolationIntent | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project isolation intent must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const intent: {
    -readonly [K in keyof ZelavisProjectIsolationIntent]: ZelavisProjectIsolationIntent[K];
  } = {};
  for (const key of Object.keys(raw)) {
    if (
      key !== "boundary" &&
      key !== "resources" &&
      !DIMENSIONS.includes(key as ZelavisIsolationDimension)
    ) {
      throw new Error(`Unknown Project isolation requirement "${key}".`);
    }
  }
  if (raw.boundary !== undefined) {
    const boundary = raw.boundary as Record<string, unknown> | null;
    if (
      !boundary ||
      typeof boundary !== "object" ||
      Array.isArray(boundary) ||
      Object.keys(boundary).some((key) => key !== "minimum" && key !== "enforcement") ||
      !BOUNDARY_ORDER.includes(boundary.minimum as ZelavisIsolationBoundary) ||
      !isEnforcement(boundary.enforcement)
    ) {
      throw new Error(
        `Project isolation boundary must be { minimum: ${BOUNDARY_ORDER.join(" | ")}, enforcement: required | advisory }.`,
      );
    }
    intent.boundary = Object.freeze({
      minimum: boundary.minimum as ZelavisIsolationBoundary,
      enforcement: boundary.enforcement,
    });
  }
  for (const dimension of DIMENSIONS) {
    const enforcement = raw[dimension];
    if (enforcement === undefined) continue;
    if (!isEnforcement(enforcement)) {
      throw new Error(
        `Project isolation requirement "${dimension}" must be "required" or "advisory".`,
      );
    }
    intent[dimension] = enforcement;
  }
  if (raw.resources !== undefined) {
    const resources = normalizeResourceIntent(raw.resources);
    if (resources) intent.resources = resources;
  }
  return Object.keys(intent).length > 0 ? Object.freeze(intent) : undefined;
}

/**
 * Compares declared intent with what a backend advertises.
 *
 * Only an `available` feature state satisfies a dimension; `planned` is a
 * statement of direction, not enforcement. With no capabilities to compare —
 * a host with no backend registry — every requirement is unmet: absence of a
 * description proves nothing.
 */
export function assessProjectIsolation(
  intent: ZelavisProjectIsolationIntent,
  runtimeKind: string,
  capabilities: ZelavisDeploymentBackendCapabilities | undefined,
): ZelavisProjectIsolationAssessment {
  const shortfalls: ZelavisProjectIsolationShortfall[] = [];
  if (intent.boundary) {
    const actual = capabilities?.isolationBoundary;
    if (
      !actual ||
      BOUNDARY_ORDER.indexOf(actual) < BOUNDARY_ORDER.indexOf(intent.boundary.minimum)
    ) {
      shortfalls.push({
        requirement: "boundary",
        enforcement: intent.boundary.enforcement,
        expected: intent.boundary.minimum,
        actual: actual ?? "unknown",
      });
    }
  }
  for (const dimension of DIMENSIONS) {
    const enforcement = intent[dimension];
    if (!enforcement) continue;
    const actual = capabilities?.[DIMENSION_CAPABILITY[dimension]];
    if (actual !== "available") {
      shortfalls.push({
        requirement: dimension,
        enforcement,
        expected: "available",
        actual: actual ?? "unknown",
      });
    }
  }
  for (const key of RESOURCE_KEYS) {
    const requested = intent.resources?.[key];
    if (!requested) continue;
    const actual = capabilities?.resourceControls[RESOURCE_LIMITS[key].control];
    if (actual !== "available") {
      shortfalls.push({
        requirement: `resources.${key}`,
        enforcement: requested.enforcement,
        expected: "available",
        actual: actual ?? "unknown",
      });
    }
  }
  return Object.freeze({
    runtimeKind,
    satisfied: shortfalls.every((shortfall) => shortfall.enforcement !== "required"),
    shortfalls: Object.freeze(shortfalls.map((shortfall) => Object.freeze(shortfall))),
  });
}
