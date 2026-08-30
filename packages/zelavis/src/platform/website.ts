/**
 * Website content shapes and rendering for the Platform's built-in site.
 *
 * Pure functions: parsing and normalizing persisted page content, and rendering
 * a page to HTML. Extracted from the Platform composition so the content model
 * can be read and tested without loading the whole runtime.
 */
import type { DatabaseJsonObject } from "../app/db/index.js";
import {
  normalizePath,
  readBodyObject,
  ZelavisValidationError,
} from "./shared.js";
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

export function parseStoredWebsitePages(value: unknown): ZelavisWebsitePage[] {
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

export function normalizeWebsitePages(
  pages: readonly ZelavisWebsitePage[],
): ZelavisWebsitePage[] {
  return pages
    .map((page) => normalizeStoredWebsitePage(page))
    .filter((page): page is ZelavisWebsitePage => Boolean(page));
}

export function serializeWebsitePage(page: ZelavisWebsitePage): DatabaseJsonObject {
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


/** Escapes text interpolated into rendered page HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderWebsitePage(page: ZelavisWebsitePage): string {
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


export function isReservedWebsitePath(path: string, rootPath: string): boolean {
  return (
    path === rootPath ||
    path.startsWith(`${rootPath}/`) ||
    path === "/api" ||
    path.startsWith("/api/")
  );
}
