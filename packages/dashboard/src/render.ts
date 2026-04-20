import type { DashboardDefinition, DashboardView } from "./contracts.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizePath(slug: string): string {
  return slug.length > 0 ? `/dashboard/${slug}` : "/dashboard";
}

function renderNavigation(
  definition: DashboardDefinition,
  activeView: DashboardView,
): string {
  return definition.views
    .map((view) => {
      const href = normalizePath(view.slug);
      const isActive = view.slug === activeView.slug;

      return `
        <a class="zelavis-nav-link${isActive ? " is-active" : ""}" href="${href}">
          <span class="zelavis-nav-title">${escapeHtml(view.title)}</span>
          <span class="zelavis-nav-badge">${escapeHtml(view.badge)}</span>
        </a>
      `;
    })
    .join("");
}

function renderStats(view: DashboardView): string {
  return view.stats
    .map(
      (stat) => `
        <article class="zelavis-stat-card">
          <p class="zelavis-stat-label">${escapeHtml(stat.label)}</p>
          <p class="zelavis-stat-value">${escapeHtml(stat.value)}</p>
          <p class="zelavis-stat-detail">${escapeHtml(stat.detail)}</p>
        </article>
      `,
    )
    .join("");
}

function renderPanels(view: DashboardView): string {
  return view.panels
    .map(
      (panel) => `
        <article class="zelavis-panel">
          <p class="zelavis-panel-eyebrow">${escapeHtml(panel.eyebrow)}</p>
          <h2>${escapeHtml(panel.title)}</h2>
          <p class="zelavis-panel-description">${escapeHtml(panel.description)}</p>
          <ul class="zelavis-panel-list">
            ${panel.items
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join("")}
          </ul>
        </article>
      `,
    )
    .join("");
}

export function renderDashboardDocument(
  definition: DashboardDefinition,
  activeView: DashboardView,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(activeView.title)} | ${escapeHtml(definition.title)}</title>
    <link rel="stylesheet" href="${escapeHtml(definition.assetPath)}" />
  </head>
  <body>
    <div class="zelavis-shell">
      <aside class="zelavis-sidebar">
        <a class="zelavis-brand" href="/dashboard">
          <span class="zelavis-brand-mark">z</span>
          <span>
            <strong>${escapeHtml(definition.title)}</strong>
            <small>${escapeHtml(definition.subtitle)}</small>
          </span>
        </a>
        <nav class="zelavis-nav">
          ${renderNavigation(definition, activeView)}
        </nav>
      </aside>
      <main class="zelavis-main">
        <header class="zelavis-hero">
          <span class="zelavis-hero-badge">${escapeHtml(activeView.badge)}</span>
          <h1>${escapeHtml(activeView.title)}</h1>
          <p>${escapeHtml(activeView.description)}</p>
        </header>
        <section class="zelavis-stats">
          ${renderStats(activeView)}
        </section>
        <section class="zelavis-panels">
          ${renderPanels(activeView)}
        </section>
      </main>
    </div>
  </body>
</html>`;
}
