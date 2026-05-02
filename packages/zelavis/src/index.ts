import {
  authService as createAuthService,
  AuthDomainError,
  AuthNotFoundError,
  AuthValidationError,
  type AuthServiceOptions,
} from "@zelavis/auth";
import {
  createDatabase,
  createDatabaseServerService,
  DatabaseConflictError,
  DatabaseRevisionMismatchError,
  DatabaseValidationError,
  type CreateDatabaseOptions,
  type DatabaseApi,
  type DatabaseJsonObject,
  DatabaseNotFoundError,
} from "@zelavis/database";
import {
  createMappedJsonErrorResponse,
  defineServerService,
  zelavisServer as mountZelavisServer,
  type ZelavisServerErrorStatusRule,
  type ZelavisAnyServiceInput,
  type ZelavisServerErrorHandler,
  type ZelavisServerRuntime,
  type ZelavisServerService,
} from "@zelavis/server";
import {
  embeddedDashboardAssets,
  embeddedDashboardShell,
  type EmbeddedDashboardAsset,
} from "./generated/dashboard-assets.js";

export * from "@zelavis/database";
export {
  defineServerService,
  type ZelavisAnyServiceInput,
  type ZelavisServerErrorHandler,
  type ZelavisServerRoute,
  type ZelavisServerRuntime,
  type ZelavisServerService,
} from "@zelavis/server";

export type ZelavisAuthCoreServiceOptions = boolean | AuthServiceOptions;

export interface ZelavisDashboardCoreServiceOptions {
  title?: string;
  subtitle?: string;
  assetPath?: string;
  clientRoutes?: readonly string[];
  devServerUrl?: string;
  settingsStore?: ZelavisDashboardSettingsStore;
}

export type ZelavisDashboardCoreServiceInput =
  | boolean
  | ZelavisDashboardCoreServiceOptions;

export interface ZelavisWebsiteAction {
  label: string;
  href: string;
  variant?: "primary" | "secondary";
}

export interface ZelavisWebsiteCard {
  title: string;
  description: string;
  href?: string;
}

export interface ZelavisWebsitePage {
  path: string;
  title: string;
  kicker?: string;
  headline?: string;
  description?: string;
  actions?: readonly ZelavisWebsiteAction[];
  cards?: readonly ZelavisWebsiteCard[];
}

export interface ZelavisWebsitePagesStore {
  read: () =>
    | Promise<readonly ZelavisWebsitePage[]>
    | readonly ZelavisWebsitePage[];
  write: (
    pages: readonly ZelavisWebsitePage[],
  ) => Promise<readonly ZelavisWebsitePage[]> | readonly ZelavisWebsitePage[];
}

export interface ZelavisWebsiteCoreServiceOptions {
  pagesStore?: ZelavisWebsitePagesStore;
}

export type ZelavisWebsiteCoreServiceInput =
  | boolean
  | ZelavisWebsiteCoreServiceOptions;

class ZelavisDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisDomainError";
  }
}

class ZelavisValidationError extends ZelavisDomainError {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisValidationError";
  }
}

class ZelavisConflictError extends ZelavisDomainError {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisConflictError";
  }
}

function parseStoredDashboardSettingsUpdate(
  input: Record<string, unknown>,
): ZelavisDashboardSettingsUpdate {
  const update: ZelavisDashboardSettingsUpdate = {};

  if ("rootPath" in input) {
    if (typeof input.rootPath !== "string") {
      throw new ZelavisValidationError(
        "Stored dashboard root path must be a string.",
      );
    }

    update.rootPath = normalizeEditableRootPath(input.rootPath);
  }

  if ("theme" in input) {
    if (!isDashboardThemeMode(input.theme)) {
      throw new ZelavisValidationError(
        'Stored dashboard theme must be one of "light", "dark", or "auto".',
      );
    }

    update.theme = input.theme;
  }

  if ("pageBuilderEnabled" in input) {
    if (!isBoolean(input.pageBuilderEnabled)) {
      throw new ZelavisValidationError(
        "Stored page builder enabled must be a boolean.",
      );
    }

    update.pageBuilderEnabled = input.pageBuilderEnabled;
  }

  return update;
}

export type ZelavisDatabaseCoreServiceOptions =
  | boolean
  | CreateDatabaseOptions
  | DatabaseApi
  | Promise<DatabaseApi>;

export interface ZelavisCoreServicesOptions {
  auth?: ZelavisAuthCoreServiceOptions;
  dashboard?: ZelavisDashboardCoreServiceInput;
  database?: ZelavisDatabaseCoreServiceOptions;
  website?: ZelavisWebsiteCoreServiceInput;
}

export interface ZelavisApiOptions {
  prefix?: string;
  version?: string;
}

export type ZelavisDashboardThemeMode = "light" | "dark" | "auto";

export interface ZelavisDashboardSettings {
  rootPath: string;
  pendingRootPath?: string;
  apiBasePath: string;
  theme: ZelavisDashboardThemeMode;
  pageBuilderEnabled: boolean;
  persistence: "runtime" | "read-only";
  editable: {
    rootPath: boolean;
    theme: boolean;
    pageBuilder: boolean;
  };
  restartRequired: boolean;
}

export interface ZelavisDashboardSettingsUpdate {
  rootPath?: string;
  theme?: ZelavisDashboardThemeMode;
  pageBuilderEnabled?: boolean;
}

export interface ZelavisDashboardSettingsStore {
  read: () =>
    | Promise<ZelavisDashboardSettingsUpdate | undefined>
    | ZelavisDashboardSettingsUpdate
    | undefined;
  write: (
    update: ZelavisDashboardSettingsUpdate,
  ) => Promise<ZelavisDashboardSettingsUpdate> | ZelavisDashboardSettingsUpdate;
}

export interface ZelavisServerOptions {
  rootPath?: string;
  api?: ZelavisApiOptions;
  services?: readonly ZelavisAnyServiceInput[];
  coreServices?: ZelavisCoreServicesOptions;
  servicePrefixes?: Record<string, string>;
  pathOverrides?: Record<string, string>;
  onError?: ZelavisServerErrorHandler;
}

export interface ZelavisDatabaseDocumentStoreOptions {
  collection?: string;
  documentId?: string;
}

const DEFAULT_ZELAVIS_STATE_COLLECTION = "zelavis_system";
const DEFAULT_DASHBOARD_SETTINGS_DOCUMENT_ID = "dashboard.settings";
const DEFAULT_WEBSITE_PAGES_DOCUMENT_ID = "website.pages";

function readOptionalProcessEnv(name: string): string | undefined {
  const runtimeProcess = (
    globalThis as typeof globalThis & {
      process?: {
        env?: Record<string, string | undefined>;
        versions?: {
          node?: string;
        };
      };
    }
  ).process;

  return runtimeProcess?.env?.[name];
}

function normalizePathPart(part: string | undefined): string {
  if (!part) {
    return "";
  }

  const trimmed = part.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizePath(path: string | undefined, fallback: string): string {
  if (path === undefined) {
    return fallback;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed === "/") {
    return "/";
  }

  const normalized = normalizePathPart(trimmed);
  return normalized ? `/${normalized}` : fallback;
}

function normalizeEditableRootPath(
  path: string | undefined,
): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  return normalizePath(path, "/");
}

function joinPathParts(...parts: (string | undefined)[]): string {
  const normalized = parts.map(normalizePathPart).filter(Boolean);
  return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeExternalUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function isDashboardThemeMode(
  value: unknown,
): value is ZelavisDashboardThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function readBodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

const zelavisErrorRules: readonly ZelavisServerErrorStatusRule[] = [
  {
    matches: (error) =>
      error instanceof TypeError ||
      error instanceof AuthValidationError ||
      error instanceof DatabaseValidationError ||
      error instanceof ZelavisValidationError,
    status: 400,
  },
  {
    matches: (error) =>
      error instanceof DatabaseNotFoundError ||
      error instanceof AuthNotFoundError,
    status: 404,
  },
  {
    matches: (error) =>
      error instanceof DatabaseRevisionMismatchError ||
      error instanceof DatabaseConflictError ||
      error instanceof ZelavisConflictError,
    status: 409,
  },
  {
    matches: (error) =>
      error instanceof AuthDomainError || error instanceof ZelavisDomainError,
    status: 400,
  },
];

function zelavisErrorResponse(error: unknown, fallback = 500) {
  return createMappedJsonErrorResponse(error, zelavisErrorRules, fallback);
}

function createMemoryDashboardSettingsStore(): ZelavisDashboardSettingsStore {
  let settings: ZelavisDashboardSettingsUpdate = {};

  return {
    read: () => settings,
    write(update) {
      settings = {
        ...settings,
        ...update,
      };

      return settings;
    },
  };
}

function createMemoryWebsitePagesStore(
  initialPages: readonly ZelavisWebsitePage[],
): ZelavisWebsitePagesStore {
  let pages = [...initialPages];

  return {
    read: () => pages,
    write(nextPages) {
      pages = [...nextPages];
      return pages;
    },
  };
}

async function ensureDatabaseCollection(
  database: DatabaseApi,
  name: string,
): Promise<void> {
  if (await database.documents.collectionExists({ name })) {
    return;
  }

  try {
    await database.documents.createCollection({
      name,
      metadata: {
        internal: true,
        managedBy: "zelavis",
      },
    });
  } catch (error) {
    if (await database.documents.collectionExists({ name })) {
      return;
    }

    throw error;
  }
}

function normalizeStoredWebsiteAction(
  value: unknown,
): ZelavisWebsiteAction | undefined {
  const input = readBodyObject(value);
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const href = typeof input.href === "string" ? input.href.trim() : "";
  const variant =
    input.variant === "primary" || input.variant === "secondary"
      ? input.variant
      : undefined;

  if (!label || !href) {
    return undefined;
  }

  return {
    label,
    href,
    ...(variant ? { variant } : {}),
  };
}

function normalizeStoredWebsiteCard(
  value: unknown,
): ZelavisWebsiteCard | undefined {
  const input = readBodyObject(value);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  const href =
    typeof input.href === "string" && input.href.trim()
      ? input.href.trim()
      : undefined;

  if (!title || !description) {
    return undefined;
  }

  return {
    title,
    description,
    ...(href ? { href } : {}),
  };
}

function parseStoredWebsiteAction(value: unknown): ZelavisWebsiteAction {
  const action = normalizeStoredWebsiteAction(value);
  if (!action) {
    throw new ZelavisValidationError(
      "Stored website actions require a label and href.",
    );
  }

  return action;
}

function parseStoredWebsiteCard(value: unknown): ZelavisWebsiteCard {
  const card = normalizeStoredWebsiteCard(value);
  if (!card) {
    throw new ZelavisValidationError(
      "Stored website cards require a title and description.",
    );
  }

  return card;
}

function normalizeStoredWebsitePage(
  value: unknown,
): ZelavisWebsitePage | undefined {
  const input = readBodyObject(value);
  const path = normalizePath(
    typeof input.path === "string" ? input.path : undefined,
    "",
  );
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const kicker =
    typeof input.kicker === "string" && input.kicker.trim()
      ? input.kicker.trim()
      : undefined;
  const headline =
    typeof input.headline === "string" && input.headline.trim()
      ? input.headline.trim()
      : undefined;
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : undefined;
  const actions = Array.isArray(input.actions)
    ? input.actions
        .map((action) => normalizeStoredWebsiteAction(action))
        .filter((action): action is ZelavisWebsiteAction => Boolean(action))
    : undefined;
  const cards = Array.isArray(input.cards)
    ? input.cards
        .map((card) => normalizeStoredWebsiteCard(card))
        .filter((card): card is ZelavisWebsiteCard => Boolean(card))
    : undefined;

  if (!path || !title) {
    return undefined;
  }

  return {
    path,
    title,
    ...(kicker ? { kicker } : {}),
    ...(headline ? { headline } : {}),
    ...(description ? { description } : {}),
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(cards && cards.length > 0 ? { cards } : {}),
  };
}

function parseStoredWebsitePage(value: unknown): ZelavisWebsitePage {
  const input = readBodyObject(value);
  const page = normalizeStoredWebsitePage(value);

  if (!page) {
    throw new ZelavisValidationError(
      "Stored website pages require a path and title.",
    );
  }

  if ("actions" in input && !Array.isArray(input.actions)) {
    throw new ZelavisValidationError(
      "Stored website page actions must be an array.",
    );
  }

  if ("cards" in input && !Array.isArray(input.cards)) {
    throw new ZelavisValidationError(
      "Stored website page cards must be an array.",
    );
  }

  const actions = Array.isArray(input.actions)
    ? input.actions.map((action) => parseStoredWebsiteAction(action))
    : undefined;
  const cards = Array.isArray(input.cards)
    ? input.cards.map((card) => parseStoredWebsiteCard(card))
    : undefined;

  return {
    ...page,
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(cards && cards.length > 0 ? { cards } : {}),
  };
}

function parseStoredWebsitePages(value: unknown): ZelavisWebsitePage[] {
  const input = readBodyObject(value);

  if (!("pages" in input)) {
    return [];
  }

  if (!Array.isArray(input.pages)) {
    throw new ZelavisValidationError(
      "Stored website pages must be an array.",
    );
  }

  return input.pages.map((page) => parseStoredWebsitePage(page));
}

function normalizeWebsitePages(
  pages: readonly ZelavisWebsitePage[],
): ZelavisWebsitePage[] {
  return pages
    .map((page) => normalizeStoredWebsitePage(page))
    .filter((page): page is ZelavisWebsitePage => Boolean(page));
}

function serializeWebsitePage(page: ZelavisWebsitePage): DatabaseJsonObject {
  return {
    path: page.path,
    title: page.title,
    ...(page.kicker ? { kicker: page.kicker } : {}),
    ...(page.headline ? { headline: page.headline } : {}),
    ...(page.description ? { description: page.description } : {}),
    ...(page.actions
      ? {
          actions: page.actions.map((action) => ({
            label: action.label,
            href: action.href,
            ...(action.variant ? { variant: action.variant } : {}),
          })),
        }
      : {}),
    ...(page.cards
      ? {
          cards: page.cards.map((card) => ({
            title: card.title,
            description: card.description,
            ...(card.href ? { href: card.href } : {}),
          })),
        }
      : {}),
  };
}

async function readDatabaseDocument(
  database: DatabaseApi,
  options: Required<ZelavisDatabaseDocumentStoreOptions>,
) {
  await ensureDatabaseCollection(database, options.collection);
  return database.documents.findById({
    collection: options.collection,
    id: options.documentId,
  });
}

async function readValidatedDatabaseDocumentData<T>(
  database: DatabaseApi,
  options: Required<ZelavisDatabaseDocumentStoreOptions>,
  parse: (value: unknown) => T,
): Promise<T> {
  const document = await readDatabaseDocument(database, options);
  return parse(document?.data);
}

async function writeDatabaseDocument(
  database: DatabaseApi,
  options: Required<ZelavisDatabaseDocumentStoreOptions>,
  data: DatabaseJsonObject,
): Promise<void> {
  await ensureDatabaseCollection(database, options.collection);
  const current = await database.documents.findById({
    collection: options.collection,
    id: options.documentId,
  });

  if (current) {
    await database.documents.update({
      collection: options.collection,
      id: options.documentId,
      data,
      mode: "replace",
    });
    return;
  }

  await database.documents.insert({
    collection: options.collection,
    id: options.documentId,
    data,
  });
}

export function createDatabaseDashboardSettingsStore(
  database: DatabaseApi,
  options: ZelavisDatabaseDocumentStoreOptions = {},
): ZelavisDashboardSettingsStore {
  const documentOptions = {
    collection: options.collection ?? DEFAULT_ZELAVIS_STATE_COLLECTION,
    documentId: options.documentId ?? DEFAULT_DASHBOARD_SETTINGS_DOCUMENT_ID,
  };

  return {
    async read() {
      return readValidatedDatabaseDocumentData(
        database,
        documentOptions,
        (value) => parseStoredDashboardSettingsUpdate(readBodyObject(value)),
      );
    },
    async write(update) {
      const next = {
        ...((await this.read()) ?? {}),
        ...update,
      };

      await writeDatabaseDocument(database, documentOptions, {
        kind: "dashboard-settings",
        ...next,
      });

      return next;
    },
  };
}

export function createDatabaseWebsitePagesStore(
  database: DatabaseApi,
  options: ZelavisDatabaseDocumentStoreOptions = {},
): ZelavisWebsitePagesStore {
  const documentOptions = {
    collection: options.collection ?? DEFAULT_ZELAVIS_STATE_COLLECTION,
    documentId: options.documentId ?? DEFAULT_WEBSITE_PAGES_DOCUMENT_ID,
  };

  return {
    async read() {
      return readValidatedDatabaseDocumentData(
        database,
        documentOptions,
        parseStoredWebsitePages,
      );
    },
    async write(pages) {
      const normalizedPages = normalizeWebsitePages(pages);

      await writeDatabaseDocument(database, documentOptions, {
        kind: "website-pages",
        pages: normalizedPages.map((page) => serializeWebsitePage(page)),
      });

      return normalizedPages;
    },
  };
}

function resolveDashboardSettingsStore(
  option: ZelavisDashboardCoreServiceInput | undefined,
  fallbackStore?: ZelavisDashboardSettingsStore,
): ZelavisDashboardSettingsStore | undefined {
  const dashboardOption = option ?? true;

  if (dashboardOption === false) {
    return undefined;
  }

  if (dashboardOption === true) {
    return fallbackStore ?? createMemoryDashboardSettingsStore();
  }

  return (
    dashboardOption.settingsStore ??
    fallbackStore ??
    createMemoryDashboardSettingsStore()
  );
}

function readDashboardSettingsUpdate(
  body: unknown,
): ZelavisDashboardSettingsUpdate {
  const input = readBodyObject(body);

  try {
    return parseStoredDashboardSettingsUpdate(input);
  } catch (error) {
    if (!(error instanceof ZelavisValidationError)) {
      throw error;
    }

    const normalizedMessage = error.message
      .replace(/^Stored dashboard /, "")
      .replace(/^Stored page builder enabled/, "Page builder enabled")
      .replace(/^Stored dashboard theme/, "Theme")
      .replace(/^Stored dashboard root path/, "Root path");

    throw new ZelavisValidationError(
      normalizedMessage.charAt(0).toUpperCase() + normalizedMessage.slice(1),
    );
  }
}

function readRequestUrl(request: unknown): string | undefined {
  if (!request || typeof request !== "object") {
    return undefined;
  }

  const candidate =
    "originalUrl" in request && typeof request.originalUrl === "string"
      ? request.originalUrl
      : "url" in request && typeof request.url === "string"
        ? request.url
        : undefined;

  return candidate && candidate.length > 0 ? candidate : undefined;
}

function stripRootPath(pathname: string, rootPath: string): string {
  if (pathname === rootPath) {
    return "/";
  }

  if (pathname.startsWith(`${rootPath}/`)) {
    return pathname.slice(rootPath.length) || "/";
  }

  return pathname || "/";
}

function createDashboardDevRedirect(
  context: {
    query: URLSearchParams;
    request: unknown;
  },
  options: {
    devServerUrl: string;
    rootPath: string;
    fallbackPath: string;
  },
) {
  const requestUrl = readRequestUrl(context.request);
  const parsed = requestUrl
    ? new URL(requestUrl, "http://127.0.0.1")
    : undefined;
  const pathname = stripRootPath(
    parsed?.pathname ?? options.fallbackPath,
    options.rootPath,
  );
  const search =
    parsed?.search ??
    (() => {
      const query = context.query.toString();
      return query ? `?${query}` : "";
    })();

  return {
    status: 307,
    headers: {
      location: `${options.devServerUrl}${pathname}${search}`,
      "cache-control": "no-cache",
    },
  };
}

const defaultDashboardClientRoutes = [
  "/agents",
  "/auth",
  "/builder",
  "/builder/pages",
  "/commerce",
  "/content",
  "/database",
  "/marketplace",
  "/services",
  "/settings",
  "/users",
] as const;

interface DashboardAsset {
  path: string;
  contentType: string;
  cacheControl: string;
  kind: "text" | "base64";
  content: string;
}

function collectDashboardAssets(): DashboardAsset[] {
  return [...embeddedDashboardAssets]
    .map((asset: EmbeddedDashboardAsset) => ({
      path: asset.path,
      contentType: asset.contentType,
      cacheControl: asset.cacheControl,
      kind: asset.kind,
      content: asset.content,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function prefixDashboardAssetReferences(
  content: string,
  rootPath: string,
): string {
  const prefix = rootPath === "/" ? "" : rootPath;

  return content
    .replace(
      /\b(href|src|action)="\/(?!\/)([^"]*)"/g,
      (_match, attribute, path) => {
        return `${attribute}="${prefix}/${path}"`;
      },
    )
    .replaceAll('"/assets/', `"${prefix}/assets/`)
    .replaceAll("'/assets/", `'${prefix}/assets/`)
    .replaceAll("`/assets/", `\`${prefix}/assets/`)
    .replaceAll('"assets/', `"${prefix}/assets/`)
    .replaceAll("'assets/", `'${prefix}/assets/`)
    .replaceAll("`assets/", `\`${prefix}/assets/`);
}

function shouldPrefixDashboardAsset(asset: DashboardAsset): boolean {
  return (
    asset.contentType.startsWith("text/") ||
    asset.contentType.startsWith("application/json") ||
    asset.path.endsWith(".js") ||
    asset.path.endsWith(".mjs")
  );
}

function readDashboardAsset(
  asset: DashboardAsset,
  rootPath: string,
): Uint8Array | string {
  function decodeBase64(base64: string): Uint8Array {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const sanitized = base64.replace(/=+$/, "");
    const output: number[] = [];

    for (let index = 0; index < sanitized.length; index += 4) {
      const c1 = alphabet.indexOf(sanitized[index] ?? "A");
      const c2 = alphabet.indexOf(sanitized[index + 1] ?? "A");
      const c3 = alphabet.indexOf(sanitized[index + 2] ?? "A");
      const c4 = alphabet.indexOf(sanitized[index + 3] ?? "A");
      const value = (c1 << 18) | (c2 << 12) | ((c3 & 63) << 6) | (c4 & 63);

      output.push((value >> 16) & 0xff);
      if (sanitized[index + 2] !== undefined) {
        output.push((value >> 8) & 0xff);
      }
      if (sanitized[index + 3] !== undefined) {
        output.push(value & 0xff);
      }
    }

    return Uint8Array.from(output);
  }

  if (!shouldPrefixDashboardAsset(asset)) {
    return asset.kind === "text" ? asset.content : decodeBase64(asset.content);
  }

  return prefixDashboardAssetReferences(asset.content, rootPath);
}

function injectDashboardRuntimeConfig(html: string, config: unknown): string {
  const script = `<script>window.__ZELAVIS_RUNTIME_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c")};</script>`;
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
}

function renderWebsitePage(page: ZelavisWebsitePage): string {
  const title = escapeHtml(page.title);
  const kicker = page.kicker
    ? `<span class="kicker">${escapeHtml(page.kicker)}</span>`
    : "";
  const headline = escapeHtml(page.headline ?? page.title);
  const description = page.description
    ? `<p>${escapeHtml(page.description)}</p>`
    : "";
  const actions =
    page.actions && page.actions.length > 0
      ? `<div class="actions">${page.actions
          .map((action) => {
            const variantClass = action.variant === "primary" ? " primary" : "";
            return `<a class="button${variantClass}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;
          })
          .join("")}</div>`
      : "";
  const cards =
    page.cards && page.cards.length > 0
      ? `<section class="grid">${page.cards
          .map((card) => {
            const content = `<h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.description)}</p>`;

            if (!card.href) {
              return `<article class="card">${content}</article>`;
            }

            return `<a class="card card-link" href="${escapeHtml(card.href)}">${content}</a>`;
          })
          .join("")}</section>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #09090b;
        --panel: #111114;
        --muted: #a1a1aa;
        --text: #fafafa;
        --accent: #8b5cf6;
        --border: #27272a;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        background: radial-gradient(circle at top, #18181b 0%, var(--bg) 50%);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: 100%;
        max-width: 72rem;
        margin: 0 auto;
        padding: 5rem 1.5rem;
      }

      .hero {
        padding: 2rem 0 3rem;
      }

      .kicker {
        display: inline-block;
        margin-bottom: 1rem;
        padding: 0.375rem 0.625rem;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: #c4b5fd;
        background: rgba(139, 92, 246, 0.1);
        font-size: 0.875rem;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.5rem, 8vw, 4.75rem);
        line-height: 1;
      }

      p {
        color: var(--muted);
        font-size: 1.05rem;
        line-height: 1.7;
        max-width: 44rem;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.875rem;
        margin-top: 2rem;
      }

      a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.75rem;
        padding: 0.9rem 1.1rem;
        text-decoration: none;
        font-weight: 600;
        border: 1px solid var(--border);
        color: var(--text);
        background: var(--panel);
      }

      a.button.primary {
        background: var(--accent);
        border-color: var(--accent);
      }

      .grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
        margin-top: 2rem;
      }

      .card {
        border: 1px solid var(--border);
        border-radius: 1rem;
        padding: 1rem;
        background: rgba(17, 17, 20, 0.8);
        text-decoration: none;
      }

      .card-link {
        color: inherit;
      }

      .card h2 {
        margin: 0 0 0.5rem;
        font-size: 1rem;
      }

      .card p {
        margin: 0;
        font-size: 0.95rem;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        ${kicker}
        <h1>${headline}</h1>
        ${description}
        ${actions}
      </section>
      ${cards}
    </main>
  </body>
</html>`;
}

function createWebsitePageRouteId(path: string): string {
  const normalized = normalizePathPart(path);
  return normalized
    ? `website.page.${normalized.replaceAll("/", ".")}`
    : "website.page.home";
}

function isReservedWebsitePath(path: string, rootPath: string): boolean {
  return (
    path === rootPath ||
    path.startsWith(`${rootPath}/`) ||
    path === "/api" ||
    path.startsWith("/api/")
  );
}

function isDatabaseApi(value: unknown): value is DatabaseApi {
  return Boolean(
    value &&
    typeof value === "object" &&
    "documents" in value &&
    "driver" in value &&
    "capabilities" in value,
  );
}

async function resolveDatabaseCoreService(
  option: ZelavisDatabaseCoreServiceOptions | undefined,
): Promise<DatabaseApi | undefined> {
  const databaseOption = option ?? true;

  if (databaseOption === false) {
    return undefined;
  }

  if (databaseOption === true) {
    return createDatabase();
  }

  const resolvedDatabaseOption = await databaseOption;
  return isDatabaseApi(resolvedDatabaseOption)
    ? resolvedDatabaseOption
    : await createDatabase(resolvedDatabaseOption);
}

async function resolveAuthCoreService(
  option: ZelavisAuthCoreServiceOptions | undefined,
): Promise<ZelavisServerService<any> | undefined> {
  const authOption = option ?? true;

  if (authOption === false) {
    return undefined;
  }

  return createAuthService(authOption === true ? {} : authOption);
}

async function resolveDashboardCoreService(
  option: ZelavisDashboardCoreServiceInput | undefined,
  context: {
    apiPrefix: string;
    apiVersion: string;
    rootPath: string;
    serviceNames: readonly string[];
    settingsStore?: ZelavisDashboardSettingsStore;
    websiteEnabled: boolean;
  },
): Promise<ZelavisServerService<any> | undefined> {
  const dashboardOption = option ?? true;

  if (dashboardOption === false) {
    return undefined;
  }

  const options = dashboardOption === true ? {} : dashboardOption;
  const title = options.title ?? "zelavis";
  const subtitle = options.subtitle ?? "Backend, dashboard, and core services.";
  const rootPath = context.rootPath;
  const settingsStore =
    context.settingsStore ??
    options.settingsStore ??
    createMemoryDashboardSettingsStore();
  const devServerUrl = normalizeExternalUrl(
    options.devServerUrl ?? readOptionalProcessEnv("ZELAVIS_UI_DEV_SERVER"),
  );
  const assets = devServerUrl ? [] : collectDashboardAssets();
  const clientRoutes = [
    ...new Set(
      (options.clientRoutes ?? defaultDashboardClientRoutes)
        .map((route) => normalizePath(route, "/"))
        .filter((route) => route !== "/"),
    ),
  ];
  const config = {
    name: "zelavis",
    rootPath,
    api: {
      prefix: context.apiPrefix,
      version: context.apiVersion,
      basePath: joinPathParts(rootPath, context.apiPrefix, context.apiVersion),
    },
    dashboard: {
      title,
      clientRoutes,
      assetRoot: joinPathParts(rootPath, "assets"),
    },
    services: context.serviceNames.map((name) => ({
      name,
      core:
        name === "dashboard" ||
        name === "auth" ||
        name === "database" ||
        name === "website",
      apiPath:
        name === "website"
          ? "/"
          : name === "dashboard"
            ? rootPath
            : joinPathParts(
                rootPath,
                context.apiPrefix,
                context.apiVersion,
                name,
              ),
    })),
  };
  const readDashboardSettings = async (): Promise<ZelavisDashboardSettings> => {
    const stored = parseStoredDashboardSettingsUpdate(
      readBodyObject((await settingsStore.read()) ?? {}),
    );
    const storedRootPath = normalizeEditableRootPath(stored.rootPath);
    const pendingRootPath =
      storedRootPath && storedRootPath !== rootPath
        ? storedRootPath
        : undefined;
    const theme = isDashboardThemeMode(stored.theme) ? stored.theme : "auto";
    const pageBuilderEnabled = isBoolean(stored.pageBuilderEnabled)
      ? stored.pageBuilderEnabled
      : false;

    return {
      rootPath,
      pendingRootPath,
      apiBasePath: joinPathParts(
        rootPath,
        context.apiPrefix,
        context.apiVersion,
      ),
      theme,
      pageBuilderEnabled,
      persistence: "runtime",
      editable: {
        rootPath: true,
        theme: true,
        pageBuilder: context.websiteEnabled,
      },
      restartRequired: Boolean(pendingRootPath),
    };
  };
  const shell = embeddedDashboardShell
    ? injectDashboardRuntimeConfig(
        prefixDashboardAssetReferences(embeddedDashboardShell, rootPath),
        config,
      )
    : undefined;
  const shellHandler = ({
    query,
    request,
  }: {
    query: URLSearchParams;
    request: unknown;
  }) => {
    if (devServerUrl) {
      return createDashboardDevRedirect(
        { query, request },
        {
          devServerUrl,
          rootPath,
          fallbackPath: "/",
        },
      );
    }

    if (!shell) {
      return {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p><p>Dashboard assets have not been built yet.</p></body></html>`,
      };
    }

    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
      body: shell,
    };
  };
  const dashboardFallbackHandler = ({
    params,
    query,
    request,
  }: {
    params: Record<string, string>;
    query: URLSearchParams;
    request: unknown;
  }) => {
    const path = params.path ?? "";

    if (devServerUrl) {
      return createDashboardDevRedirect(
        { query, request },
        {
          devServerUrl,
          rootPath,
          fallbackPath: path ? `/${path}` : "/",
        },
      );
    }

    if (
      path === "api" ||
      path.startsWith("api/") ||
      path === "assets" ||
      path.startsWith("assets/")
    ) {
      return {
        status: 404,
        body: {
          error: "Not found",
        },
      };
    }

    return shellHandler({ query, request });
  };

  return defineServerService({
    name: "dashboard",
    basePath: "/",
    service: {
      title,
      subtitle,
      assetRoot: joinPathParts(rootPath, "assets"),
    },
    api: {
      v1: [
        {
          id: "dashboard.view.overview",
          method: "GET",
          path: "/",
          handler: shellHandler,
        },
        ...clientRoutes.map((route) => ({
          id: `dashboard.view${route.replaceAll("/", ".")}`,
          method: "GET" as const,
          path: route,
          handler: ({
            query,
            request,
          }: {
            query: URLSearchParams;
            request: unknown;
          }) =>
            devServerUrl
              ? createDashboardDevRedirect(
                  { query, request },
                  {
                    devServerUrl,
                    rootPath,
                    fallbackPath: route,
                  },
                )
              : shellHandler({ query, request }),
        })),
        {
          id: "dashboard.config",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/config",
          ),
          handler: () => ({
            status: 200,
            body: config,
          }),
        },
        {
          id: "dashboard.settings.read",
          method: "GET",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/settings",
          ),
          handler: async () => {
            try {
              return {
                status: 200,
                body: await readDashboardSettings(),
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "dashboard.settings.update",
          method: "PATCH",
          path: joinPathParts(
            context.apiPrefix,
            context.apiVersion,
            "dashboard/settings",
          ),
          handler: async ({ body }: { body: unknown }) => {
            try {
              const update = readDashboardSettingsUpdate(body);
              await settingsStore.write(update);

              return {
                status: 200,
                body: await readDashboardSettings(),
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        ...assets.map((asset) => ({
          id: `dashboard.assets${asset.path.replaceAll("/", ".")}`,
          method: "GET" as const,
          path: asset.path,
          handler: () => ({
            status: 200,
            headers: {
              "content-type": asset.contentType,
              "cache-control": asset.cacheControl,
            },
            body: readDashboardAsset(asset, rootPath),
          }),
        })),
        {
          id: "dashboard.view.fallback",
          method: "GET",
          path: "/*path",
          handler: dashboardFallbackHandler,
        },
      ],
    },
  });
}

async function resolveWebsiteCoreService(
  option: ZelavisWebsiteCoreServiceInput | undefined,
  context: {
    rootPath: string;
    apiPrefix: string;
    apiVersion: string;
    pagesStore?: ZelavisWebsitePagesStore;
  },
): Promise<ZelavisServerService<any> | undefined> {
  const websiteOption = option ?? true;

  if (websiteOption === false) {
    return undefined;
  }

  const options = websiteOption === true ? {} : websiteOption;
  const pagesStore =
    options.pagesStore ??
    context.pagesStore ??
    createMemoryWebsitePagesStore([]);

  async function readPages(): Promise<ZelavisWebsitePage[]> {
    return [...((await pagesStore.read()) ?? [])].map((page) => ({
      ...page,
      path: normalizePath(page.path, "/"),
    }));
  }

  async function writePages(
    pages: readonly ZelavisWebsitePage[],
  ): Promise<readonly ZelavisWebsitePage[]> {
    return pagesStore.write(
      pages.map((page) => ({
        ...page,
        path: normalizePath(page.path, "/"),
      })),
    );
  }

  return defineServerService({
    name: "website",
    basePath: "/",
    service: {
      pages: [],
    },
    api: {
      v1: [
        {
          id: "website.pages.list",
          method: "GET",
          path: joinPathParts(
            context.rootPath,
            context.apiPrefix,
            context.apiVersion,
            "website/pages",
          ),
          handler: async () => {
            try {
              return {
                status: 200,
                body: {
                  pages: await readPages(),
                },
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "website.pages.create",
          method: "POST",
          path: joinPathParts(
            context.rootPath,
            context.apiPrefix,
            context.apiVersion,
            "website/pages",
          ),
          handler: async ({ body }: { body: unknown }) => {
            try {
              const input = readBodyObject(body);
              const title =
                typeof input.title === "string" ? input.title.trim() : "";
              const path = normalizePath(
                typeof input.path === "string" ? input.path : undefined,
                "",
              );
              const headline =
                typeof input.headline === "string" && input.headline.trim()
                  ? input.headline.trim()
                  : undefined;
              const description =
                typeof input.description === "string" && input.description.trim()
                  ? input.description.trim()
                  : undefined;

              if (!title) {
                throw new ZelavisValidationError(
                  "Website pages require a title.",
                );
              }

              if (!path) {
                throw new ZelavisValidationError(
                  "Website pages require a path.",
                );
              }

              if (isReservedWebsitePath(path, context.rootPath)) {
                throw new ZelavisValidationError(
                  "That path is reserved by Zelavis.",
                );
              }

              const pages = await readPages();
              if (pages.some((page) => page.path === path)) {
                throw new ZelavisConflictError(
                  "A website page already exists for that path.",
                );
              }

              const page: ZelavisWebsitePage = {
                path,
                title,
                headline,
                description,
              };

              await writePages([...pages, page]);

              return {
                status: 201,
                body: page,
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
        {
          id: "website.page.dynamic",
          method: "GET",
          path: "/*path",
          handler: async ({ params }: { params: Record<string, string> }) => {
            try {
              const pages = await readPages();
              const requestPath = normalizePath(params.path, "/");
              const hasHomePage = pages.some((entry) => entry.path === "/");

              if (requestPath === context.rootPath) {
                return {
                  status: 404,
                  body: {
                    error: "Not found",
                  },
                };
              }

              if (!hasHomePage) {
                if (requestPath === "/") {
                  return {
                    status: 307,
                    headers: {
                      location: context.rootPath,
                      "cache-control": "no-cache",
                    } as Record<string, string>,
                  };
                }

                return {
                  status: 404,
                  body: {
                    error: "Not found",
                  },
                };
              }

              const page = pages.find((entry) => entry.path === requestPath);
              if (!page) {
                return {
                  status: 404,
                  body: {
                    error: "Not found",
                  },
                };
              }

              return {
                status: 200,
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "cache-control": "no-cache",
                } as Record<string, string>,
                body: renderWebsitePage(page),
              };
            } catch (error) {
              return zelavisErrorResponse(error, 400);
            }
          },
        },
      ],
    },
  });
}

function createServicePrefixes(
  services: readonly ZelavisServerService<any>[],
  options: {
    rootPath: string;
    mountPrefix: string;
    apiPrefix: string;
    apiVersion: string;
    overrides?: Record<string, string>;
  },
): Record<string, string> {
  const prefixes: Record<string, string> = {};
  const mountAtRoot = options.mountPrefix === "/";

  for (const service of services) {
    if (service.name === "website") {
      prefixes[service.name] = "/";
      continue;
    }

    if (service.name === "dashboard") {
      prefixes[service.name] = mountAtRoot ? options.rootPath : "/";
      continue;
    }

    prefixes[service.name] = mountAtRoot
      ? joinPathParts(
          options.rootPath,
          options.apiPrefix,
          options.apiVersion,
          service.name,
        )
      : joinPathParts(options.apiPrefix, options.apiVersion, service.name);
  }

  return {
    ...prefixes,
    ...options.overrides,
  };
}

export async function zelavis(
  options: ZelavisServerOptions = {},
): Promise<ZelavisServerRuntime<unknown>> {
  const rootPath = normalizePath(options.rootPath, "/zelavis");
  const apiPrefix = normalizePath(options.api?.prefix, "/api");
  const apiVersion = normalizePathPart(options.api?.version ?? "v1");
  const services = await Promise.all(options.services ?? []);
  const hasAuthService = services.some((service) => service.name === "auth");
  const hasDashboardService = services.some(
    (service) => service.name === "dashboard",
  );
  const hasWebsiteService = services.some(
    (service) => service.name === "website",
  );
  const hasDatabaseService = services.some(
    (service) => service.name === "database",
  );
  const providedDatabaseService = services.find(
    (service) => service.name === "database" && isDatabaseApi(service.service),
  );
  const authService = hasAuthService
    ? undefined
    : await resolveAuthCoreService(options.coreServices?.auth);
  const databaseApi = hasDatabaseService
    ? undefined
    : await resolveDatabaseCoreService(options.coreServices?.database);
  const databaseService = databaseApi
    ? createDatabaseServerService(databaseApi)
    : undefined;
  const resolvedDatabaseApi =
    (providedDatabaseService?.service as DatabaseApi | undefined) ??
    databaseApi;
  const dashboardSettingsStore = resolveDashboardSettingsStore(
    options.coreServices?.dashboard,
    resolvedDatabaseApi
      ? createDatabaseDashboardSettingsStore(resolvedDatabaseApi)
      : undefined,
  );
  const websiteCoreOptions = options.coreServices?.website;
  const websiteService = hasWebsiteService
    ? undefined
    : await resolveWebsiteCoreService(websiteCoreOptions, {
        rootPath,
        apiPrefix,
        apiVersion,
        pagesStore: resolvedDatabaseApi
          ? createDatabaseWebsitePagesStore(resolvedDatabaseApi)
          : undefined,
      });
  const coreServices = [databaseService, authService, websiteService].filter(
    (service): service is ZelavisServerService<any> => Boolean(service),
  );
  const websiteEnabled = hasWebsiteService || Boolean(websiteService);
  const serviceNames = [
    ...(hasDashboardService || options.coreServices?.dashboard === false
      ? []
      : ["dashboard"]),
    ...coreServices.map((service) => service.name),
    ...services.map((service) => service.name),
  ];
  const dashboardService = hasDashboardService
    ? undefined
    : await resolveDashboardCoreService(options.coreServices?.dashboard, {
        apiPrefix,
        apiVersion,
        rootPath,
        serviceNames,
        settingsStore: dashboardSettingsStore,
        websiteEnabled,
      });
  const finalServices = [...coreServices, ...services, dashboardService].filter(
    (service): service is ZelavisServerService<any> => Boolean(service),
  );
  const mountPrefix = websiteEnabled ? "/" : rootPath;

  return mountZelavisServer({
    ...options,
    prefix: mountPrefix,
    version: "v1",
    services: finalServices,
    servicePrefixes: createServicePrefixes(finalServices, {
      rootPath,
      mountPrefix,
      apiPrefix,
      apiVersion,
      overrides: options.servicePrefixes,
    }),
  });
}
