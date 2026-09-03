import {
  type ZelavisMenuFixedActionScope,
  type ZelavisRuntimeServiceMenuDefinition,
} from "../runtime/contracts.js";

const menuFixedActionScopes = [
  "local",
  "inherit",
  "replace",
  "clear",
] as const satisfies readonly ZelavisMenuFixedActionScope[];

function isBundleRelativeFilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return (
    !normalized.startsWith("/") &&
    segments.length > 0 &&
    segments.every((segment) => segment !== "." && segment !== "..")
  );
}

/**
 * One asset a service ships for its own `menu.page` files.
 *
 * A service installed from a package archive keeps its pages in the bundle
 * store. A service that ships inside the Platform, or is loaded from an already
 * resolved package rather than an uploaded archive, has no archive to unpack —
 * it declares its pages here instead. Both reach the dashboard through the same
 * service page asset route, so a page does not depend on how its service
 * arrived.
 */
export interface ZelavisServicePageAsset {
  /** Defaults to the type guessed from the asset path. */
  contentType?: string;
  cacheControl?: string;
  body: string | Uint8Array;
}

export interface ZelavisServiceMenuPageDefinition {
  id: string;
  title?: string;
  file: string;
  bundle?: string;
}

export type ZelavisServiceMenuDefinition = Omit<
  ZelavisRuntimeServiceMenuDefinition,
  "items"
> & {
  page?: ZelavisServiceMenuPageDefinition;
  items?: readonly ZelavisServiceMenuDefinition[];
};

/**
 * What a service is.
 *
 * Three kinds, because three is what the Platform actually distinguishes:
 *
 * - `frontend` — the face of an installation or a Project. Declares a
 *   `zelavis.frontend` block, is loaded from its manifest without executing
 *   JavaScript, and is routed to by the Gateway.
 * - `app` — a Project recipe: something a Project can be created from.
 * - `plugin` — code that extends the Platform. The default, and what
 *   everything else is.
 *
 * `core` used to be a fourth. It described who shipped a service rather than
 * what it is, which is what `scope` already carries — and nothing branched on
 * it. `web-app`, `website`, `dashboard-extension`, `provider`, and `template`
 * were the same: declared, documented, and never read. A provider is
 * discovered by its capability (`@zelavis/auth:credentials`), not by a label.
 *
 * This union is enforced at manifest validation. It drifted out of date once
 * already — it was missing `frontend`, the kind the Platform branches on most —
 * because nothing checked it.
 */
export type ZelavisServiceKind = "app" | "frontend" | "plugin";

export const ZELAVIS_SERVICE_KINDS: readonly ZelavisServiceKind[] =
  Object.freeze(["app", "frontend", "plugin"]);

export type ZelavisServiceCapability =
  | "web:app"
  | "web:site"
  | "api:routes"
  | "dashboard:menu"
  | "dashboard:settings"
  | "@zelavis/auth:credentials"
  | (string & {});

export interface ZelavisServiceMarketplaceMetadata {
  title?: string;
  summary?: string;
  description?: string;
  categories?: readonly string[];
  tags?: readonly string[];
}

export type ZelavisServiceScope = "system" | "extension";

export type ZelavisServiceAppMode = "spa" | "mpa";

export type ZelavisServiceAppDomainPolicy = "optional" | "required";

export interface ZelavisServiceAppShellRenderContext {
  request: Request;
  path: string;
}

export interface ZelavisServiceAppShellResult {
  status?: number;
  headers?: HeadersInit;
  body?: unknown;
}

export interface ZelavisServiceAppShellDefinition {
  render: (
    context: ZelavisServiceAppShellRenderContext,
  ) => ZelavisServiceAppShellResult | Promise<ZelavisServiceAppShellResult>;
}

export interface ZelavisServiceAppDefinition {
  mount?: string;
  domainPolicy?: ZelavisServiceAppDomainPolicy;
  bundle?: string;
  indexHtml?: string;
  mode?: ZelavisServiceAppMode;
  shell?: ZelavisServiceAppShellDefinition;
  /**
   * Path this bundle's own asset references were built against, e.g.
   * `/assets/`.
   *
   * A static bundle is built for a fixed base, but an installation's root path
   * is a runtime setting — so the Platform rewrites references starting with
   * this prefix to wherever the bundle is actually mounted. Declaring it is
   * what lets one build serve from any mount, and what a manifest can express
   * where a render function would otherwise be required.
   */
  assetBase?: string;
  devUrl?: string;
  devUrlExcludePaths?: readonly string[];
}

export type ZelavisServiceCatalogSource = "official" | "community";
export type ZelavisServiceCatalogReviewStatus =
  | "official"
  | "reviewed"
  | "unreviewed"
  | "blocked";

export interface ZelavisServiceCatalogCompatibility {
  zelavis?: string;
  parentService?: string;
  service?: string;
}

export interface ZelavisServiceCatalogLinks {
  homepage?: string;
  repository?: string;
  documentation?: string;
  issues?: string;
}

export interface ZelavisServiceCatalogEntry {
  name: string;
  package: string;
  publisher: string;
  source: ZelavisServiceCatalogSource;
  title?: string;
  summary?: string;
  description?: string;
  version?: string;
  reviewStatus?: ZelavisServiceCatalogReviewStatus;
  verified?: boolean;
  compatibility?: ZelavisServiceCatalogCompatibility;
  links?: ZelavisServiceCatalogLinks;
  license?: string;
  tags?: readonly string[];
}

export function freezeMenu(
  menu: ZelavisServiceMenuDefinition,
): Readonly<ZelavisServiceMenuDefinition> {
  return Object.freeze({
    ...menu,
    page: menu.page
      ? Object.freeze({
          ...menu.page,
        })
      : menu.page,
    items: menu.items?.map(freezeMenu),
  });
}

function validateOptionalNumber(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer when provided.`);
  }
}

function validateOptionalBoolean(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean when provided.`);
  }
}

function validateOptionalMenuFixedActionScope(
  value: unknown,
  label: string,
): void {
  if (value === undefined) {
    return;
  }

  if (
    typeof value !== "string" ||
    !menuFixedActionScopes.includes(value as ZelavisMenuFixedActionScope)
  ) {
    throw new TypeError(
      `${label} must be "local", "inherit", "replace", or "clear" when provided.`,
    );
  }
}

export function validateServiceMenu(
  menu: ZelavisServiceMenuDefinition,
  path = menu.title,
): void {
  validateOptionalNumber(menu.order, `Service menu order for "${path}"`);
  validateOptionalBoolean(menu.fixed, `Service menu fixed flag for "${path}"`);
  validateOptionalNumber(menu.fixedOrder, `Service menu fixedOrder for "${path}"`);
  validateOptionalMenuFixedActionScope(
    menu.fixedActionScope,
    `Service menu fixedActionScope for "${path}"`,
  );

  if ("page" in menu && menu.page !== undefined) {
    if (!menu.page || typeof menu.page !== "object") {
      throw new TypeError(
        `Service menu page metadata for "${path}" must be an object.`,
      );
    }

    if (!menu.page.id || typeof menu.page.id !== "string") {
      throw new TypeError(
        `Service menu page metadata for "${path}" must include a string id.`,
      );
    }

    if (
      "file" in menu.page &&
      menu.page.file !== undefined &&
      typeof menu.page.file !== "string"
    ) {
      throw new TypeError(
        `Service menu page metadata for "${path}" file must be a string when provided.`,
      );
    }

    if (
      "file" in menu.page &&
      typeof menu.page.file === "string" &&
      !isBundleRelativeFilePath(menu.page.file)
    ) {
      throw new TypeError(
        `Service menu page metadata for "${path}" file must be a bundle-relative path.`,
      );
    }

    if (
      "bundle" in menu.page &&
      menu.page.bundle !== undefined &&
      typeof menu.page.bundle !== "string"
    ) {
      throw new TypeError(
        `Service menu page metadata for "${path}" bundle must be a string when provided.`,
      );
    }

    if (
      "title" in menu.page &&
      menu.page.title !== undefined &&
      typeof menu.page.title !== "string"
    ) {
      throw new TypeError(
        `Service menu page metadata for "${path}" title must be a string when provided.`,
      );
    }

    if (!menu.page.file) {
      throw new TypeError(
        `Service menu page metadata for "${path}" must include a page.file HTML entry.`,
      );
    }
  }

  if ("dynamicItems" in menu && menu.dynamicItems !== undefined) {
    if (!menu.dynamicItems || typeof menu.dynamicItems !== "object") {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" must be an object.`,
      );
    }

    if (
      !menu.dynamicItems.path ||
      typeof menu.dynamicItems.path !== "string"
    ) {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" must include a string path.`,
      );
    }

    if (
      "emptyTitle" in menu.dynamicItems &&
      menu.dynamicItems.emptyTitle !== undefined &&
      typeof menu.dynamicItems.emptyTitle !== "string"
    ) {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" emptyTitle must be a string when provided.`,
      );
    }

    if (
      "emptyPath" in menu.dynamicItems &&
      menu.dynamicItems.emptyPath !== undefined &&
      typeof menu.dynamicItems.emptyPath !== "string"
    ) {
      throw new TypeError(
        `Service menu dynamicItems metadata for "${path}" emptyPath must be a string when provided.`,
      );
    }
  }

  if (menu.items) {
    if (!Array.isArray(menu.items)) {
      throw new TypeError(
        `Service menu items metadata for "${path}" must be an array.`,
      );
    }

    for (const [index, item] of menu.items.entries()) {
      if (!item || typeof item !== "object") {
        throw new TypeError(
          `Service menu items[${index}] metadata for "${path}" must be an object.`,
        );
      }

      const itemPath = `${path} > ${item.title ?? `items[${index}]`}`;

      if (!item.title || typeof item.title !== "string") {
        throw new TypeError(
          `Service menu items metadata for "${itemPath}" must include a string title.`,
        );
      }

      if (
        "path" in item &&
        item.path !== undefined &&
        typeof item.path !== "string"
      ) {
        throw new TypeError(
          `Service menu items metadata path for "${itemPath}" must be a string when provided.`,
        );
      }

      if (
        item.path === undefined &&
        (!item.items || item.items.length === 0)
      ) {
        throw new TypeError(
          `Service menu items metadata for "${itemPath}" must include a path or nested items.`,
        );
      }

      validateServiceMenu(item, itemPath);
    }
  }
}

export function freezeServiceApp(
  app: ZelavisServiceAppDefinition,
): Readonly<ZelavisServiceAppDefinition> {
  return Object.freeze({
    ...app,
    devUrlExcludePaths: app.devUrlExcludePaths
      ? Object.freeze([...app.devUrlExcludePaths])
      : undefined,
  });
}

export function validateServiceApp(app: ZelavisServiceAppDefinition): void {
  if (!app || typeof app !== "object") {
    throw new TypeError("Service app metadata must be an object.");
  }

  if (app.mount !== undefined) {
    if (typeof app.mount !== "string") {
      throw new TypeError("Service app mount must be a string when provided.");
    }
    if (!app.mount.startsWith("/")) {
      throw new TypeError('Service app mount must start with "/".');
    }
  }

  if (app.mode !== undefined) {
    if (app.mode !== "spa" && app.mode !== "mpa") {
      throw new TypeError('Service app mode must be "spa" or "mpa" when provided.');
    }
  }

  if (app.domainPolicy !== undefined) {
    if (app.domainPolicy !== "optional" && app.domainPolicy !== "required") {
      throw new TypeError(
        'Service app domainPolicy must be "optional" or "required" when provided.',
      );
    }
  }

  if (app.bundle !== undefined && typeof app.bundle !== "string") {
    throw new TypeError("Service app bundle must be a string when provided.");
  }

  if (app.indexHtml !== undefined && typeof app.indexHtml !== "string") {
    throw new TypeError("Service app indexHtml must be a string when provided.");
  }

  if (app.devUrl !== undefined && typeof app.devUrl !== "string") {
    throw new TypeError("Service app devUrl must be a string when provided.");
  }

  if (app.shell !== undefined) {
    if (!app.shell || typeof app.shell !== "object") {
      throw new TypeError("Service app shell must be an object when provided.");
    }
    if (typeof app.shell.render !== "function") {
      throw new TypeError("Service app shell render must be a function.");
    }
  }
}

export function defineServiceCatalogEntry(
  entry: ZelavisServiceCatalogEntry,
): Readonly<ZelavisServiceCatalogEntry> {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("A service catalog entry object is required.");
  }

  if (!entry.name || typeof entry.name !== "string") {
    throw new TypeError("A service catalog entry must include a string name.");
  }

  if (!entry.package || typeof entry.package !== "string") {
    throw new TypeError("A service catalog entry must include a string package.");
  }

  if (!entry.publisher || typeof entry.publisher !== "string") {
    throw new TypeError(
      "A service catalog entry must include a string publisher.",
    );
  }

  if (entry.source !== "official" && entry.source !== "community") {
    throw new TypeError(
      'Service catalog source must be "official" or "community".',
    );
  }

  if (
    entry.reviewStatus !== undefined &&
    entry.reviewStatus !== "official" &&
    entry.reviewStatus !== "reviewed" &&
    entry.reviewStatus !== "unreviewed" &&
    entry.reviewStatus !== "blocked"
  ) {
    throw new TypeError(
      'Service catalog reviewStatus must be "official", "reviewed", "unreviewed", or "blocked" when provided.',
    );
  }

  if (entry.verified !== undefined && typeof entry.verified !== "boolean") {
    throw new TypeError(
      "A service catalog entry verified field must be boolean when provided.",
    );
  }

  if (entry.compatibility !== undefined) {
    if (!entry.compatibility || typeof entry.compatibility !== "object") {
      throw new TypeError(
        "A service catalog entry compatibility field must be an object.",
      );
    }
  }

  if (entry.links !== undefined) {
    if (!entry.links || typeof entry.links !== "object") {
      throw new TypeError("A service catalog entry links field must be an object.");
    }
  }

  if (entry.tags !== undefined && !Array.isArray(entry.tags)) {
    throw new TypeError("A service catalog entry tags field must be an array.");
  }

  return Object.freeze({
    ...entry,
    reviewStatus:
      entry.reviewStatus ??
      (entry.source === "official" ? "official" : "unreviewed"),
    verified: entry.verified ?? (entry.source === "official"),
    compatibility: entry.compatibility
      ? Object.freeze({ ...entry.compatibility })
      : undefined,
    links: entry.links ? Object.freeze({ ...entry.links }) : undefined,
    tags: entry.tags ? Object.freeze([...entry.tags]) : undefined,
  });
}

export function defineServiceCatalog(
  entries: readonly ZelavisServiceCatalogEntry[],
): readonly Readonly<ZelavisServiceCatalogEntry>[] {
  if (!Array.isArray(entries)) {
    throw new TypeError("A service catalog must be an array.");
  }

  const seen = new Set<string>();

  return Object.freeze(
    entries.map((entry) => {
      const normalized = defineServiceCatalogEntry(entry);

      if (seen.has(normalized.name)) {
        throw new TypeError(
          `Service catalog entries must use unique names. Duplicate: ${normalized.name}`,
        );
      }

      seen.add(normalized.name);

      return normalized;
    }),
  );
}
