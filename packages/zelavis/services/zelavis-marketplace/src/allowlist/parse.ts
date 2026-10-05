import { normalizeProjectManaged } from "zelavis";
import type { Allowlist, AllowlistService, AllowlistVersion } from "./types.js";

export class AllowlistFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistFormatError";
  }
}

const NPM_SCOPED = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const NPM_UNSCOPED = /^[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const KINDS = new Set(["app", "plugin", "frontend"]);
const MAX_SERVICES = 500;
const MAX_VERSIONS = 200;
const MAX_TEXT = 500;

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AllowlistFormatError(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT || /[\u0000-\u001f]/.test(value)) {
    throw new AllowlistFormatError(`${where} must be a short single-line string.`);
  }
  return value;
}

function texts(value: unknown, where: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) {
    throw new AllowlistFormatError(`${where} must be a list of at most 50 strings.`);
  }
  return value.map((entry, index) => text(entry, `${where}[${index}]`)!);
}

function instant(value: unknown, where: string): string {
  const raw = text(value, where)!;
  if (Number.isNaN(Date.parse(raw))) throw new AllowlistFormatError(`${where} must be a timestamp.`);
  return raw;
}

function parseVersion(value: unknown, where: string): AllowlistVersion {
  const input = record(value, where);
  const version = text(input.version, `${where}.version`)!;
  if (!EXACT_VERSION.test(version)) {
    throw new AllowlistFormatError(`${where}.version must be an exact version, not a range or tag.`);
  }
  const integrity = text(input.integrity, `${where}.integrity`)!;
  if (!INTEGRITY.test(integrity)) {
    throw new AllowlistFormatError(`${where}.integrity must be a sha512 integrity string.`);
  }
  const deprecated = text(input.deprecated, `${where}.deprecated`, false);
  return { version, integrity, ...(deprecated ? { deprecated } : {}) };
}

function parseService(value: unknown, where: string): AllowlistService {
  const input = record(value, where);
  const name = text(input.name, `${where}.name`)!;
  if (!NPM_SCOPED.test(name) && !NPM_UNSCOPED.test(name)) {
    throw new AllowlistFormatError(`${where}.name is not an npm package name.`);
  }
  const kind = input.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    throw new AllowlistFormatError(`${where}.kind must be app, plugin or frontend.`);
  }
  if (!Array.isArray(input.versions) || input.versions.length === 0 || input.versions.length > MAX_VERSIONS) {
    throw new AllowlistFormatError(`${where}.versions must list 1 to ${MAX_VERSIONS} versions.`);
  }
  const versions = input.versions.map((entry, index) => parseVersion(entry, `${where}.versions[${index}]`));
  if (new Set(versions.map((entry) => entry.version)).size !== versions.length) {
    throw new AllowlistFormatError(`${where}.versions repeats a version.`);
  }
  const latest = text(input.latest, `${where}.latest`)!;
  if (!versions.some((entry) => entry.version === latest)) {
    throw new AllowlistFormatError(`${where}.latest must be one of its versions.`);
  }
  const summary = text(input.summary, `${where}.summary`, false);
  const categories = texts(input.categories, `${where}.categories`);
  const tags = texts(input.tags, `${where}.tags`);
  const hostPackages = texts(input.hostPackages, `${where}.hostPackages`);
  if (hostPackages && (kind !== "app" || hostPackages.length > 8 || new Set(hostPackages).size !== hostPackages.length || hostPackages.some((set) => !/^[a-z][a-z0-9-]{0,31}$/.test(set)))) {
    throw new AllowlistFormatError(`${where}.hostPackages must be at most eight distinct named sets on a Project recipe.`);
  }
  let managed: AllowlistService["managed"];
  if (input.managed !== undefined) {
    if (kind !== "app") throw new AllowlistFormatError(`${where}.managed is only for Project recipes.`);
    try { managed = normalizeProjectManaged(input.managed); }
    catch (error) { throw new AllowlistFormatError(`${where}.managed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const runtimeKinds = texts(input.runtimeKinds, `${where}.runtimeKinds`);
  if (input.projectRuntime !== undefined && typeof input.projectRuntime !== "boolean") {
    throw new AllowlistFormatError(`${where}.projectRuntime must be true or false.`);
  }
  if (input.projectRuntime === true && kind !== "app") {
    throw new AllowlistFormatError(`${where}.projectRuntime is only for Project recipes (kind app).`);
  }
  return {
    name,
    kind: kind as AllowlistService["kind"],
    maintainer: text(input.maintainer, `${where}.maintainer`)!,
    title: text(input.title, `${where}.title`)!,
    ...(summary ? { summary } : {}),
    ...(categories ? { categories } : {}),
    ...(tags ? { tags } : {}),
    ...(hostPackages ? { hostPackages } : {}),
    ...(managed ? { managed } : {}),
    ...(runtimeKinds ? { runtimeKinds } : {}),
    ...(input.projectRuntime === true ? { projectRuntime: true } : {}),
    versions,
    latest,
  };
}

/** Validates an allow-list document strictly; anything unexpected is refused. */
export function parseAllowlist(value: unknown): Allowlist {
  const input = record(value, "The allow-list");
  if (input.schemaVersion !== 1) {
    throw new AllowlistFormatError("Unsupported allow-list schema version.");
  }
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1) {
    throw new AllowlistFormatError("sequence must be a positive integer.");
  }
  const issuedAt = instant(input.issuedAt, "issuedAt");
  const expiresAt = instant(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new AllowlistFormatError("expiresAt must be after issuedAt.");
  }
  if (!Array.isArray(input.services) || input.services.length > MAX_SERVICES) {
    throw new AllowlistFormatError(`services must be a list of at most ${MAX_SERVICES}.`);
  }
  const services = input.services.map((entry, index) => parseService(entry, `services[${index}]`));
  if (new Set(services.map((entry) => entry.name)).size !== services.length) {
    throw new AllowlistFormatError("services repeats a package name.");
  }
  return {
    schemaVersion: 1,
    sequence: input.sequence as number,
    issuedAt,
    expiresAt,
    services,
  };
}
