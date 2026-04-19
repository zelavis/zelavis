export const defaultDashboardStyles = `
:root {
  color-scheme: light;
  --zelavis-bg: #f3efe7;
  --zelavis-surface: rgba(255, 251, 245, 0.88);
  --zelavis-surface-strong: #fffdf8;
  --zelavis-border: rgba(41, 37, 36, 0.12);
  --zelavis-border-strong: rgba(41, 37, 36, 0.22);
  --zelavis-text: #1c1917;
  --zelavis-text-soft: #57534e;
  --zelavis-accent: #b45309;
  --zelavis-accent-soft: rgba(180, 83, 9, 0.14);
  --zelavis-shadow: 0 18px 40px rgba(28, 25, 23, 0.08);
  --zelavis-radius-lg: 24px;
  --zelavis-radius-md: 18px;
  --zelavis-radius-sm: 12px;
  font-family:
    "Iowan Old Style",
    "Palatino Linotype",
    "Book Antiqua",
    Georgia,
    serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background:
    radial-gradient(circle at top left, rgba(180, 83, 9, 0.18), transparent 24rem),
    linear-gradient(180deg, #f8f5ef 0%, var(--zelavis-bg) 100%);
  color: var(--zelavis-text);
}

a {
  color: inherit;
  text-decoration: none;
}

.zelavis-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 288px minmax(0, 1fr);
}

.zelavis-sidebar {
  padding: 24px;
  border-right: 1px solid var(--zelavis-border);
  background: rgba(255, 252, 247, 0.72);
  backdrop-filter: blur(10px);
}

.zelavis-brand {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 14px;
  margin-bottom: 28px;
  align-items: center;
}

.zelavis-brand-mark {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  background: linear-gradient(135deg, #1c1917, #44403c);
  color: #fff;
  font-size: 1.4rem;
  text-transform: uppercase;
}

.zelavis-brand strong,
.zelavis-brand small {
  display: block;
}

.zelavis-brand small {
  margin-top: 4px;
  color: var(--zelavis-text-soft);
  line-height: 1.4;
}

.zelavis-nav {
  display: grid;
  gap: 10px;
}

.zelavis-nav-link {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid transparent;
  border-radius: var(--zelavis-radius-sm);
  background: transparent;
  transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
}

.zelavis-nav-link:hover,
.zelavis-nav-link:focus-visible {
  background: rgba(255, 255, 255, 0.5);
  border-color: var(--zelavis-border);
  transform: translateX(2px);
}

.zelavis-nav-link.is-active {
  background: var(--zelavis-surface-strong);
  border-color: var(--zelavis-border-strong);
  box-shadow: var(--zelavis-shadow);
}

.zelavis-nav-title {
  font-weight: 700;
}

.zelavis-nav-badge,
.zelavis-hero-badge,
.zelavis-panel-eyebrow {
  font-family: ui-monospace, "SFMono-Regular", "SF Mono", Consolas, monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.72rem;
}

.zelavis-nav-badge,
.zelavis-hero-badge {
  color: var(--zelavis-accent);
}

.zelavis-main {
  padding: 32px;
}

.zelavis-hero {
  padding: 28px;
  border: 1px solid var(--zelavis-border);
  border-radius: var(--zelavis-radius-lg);
  background: var(--zelavis-surface);
  box-shadow: var(--zelavis-shadow);
}

.zelavis-hero h1 {
  margin: 10px 0 12px;
  font-size: clamp(2rem, 4vw, 3.5rem);
  line-height: 0.98;
}

.zelavis-hero p,
.zelavis-stat-detail,
.zelavis-panel-description {
  color: var(--zelavis-text-soft);
  line-height: 1.6;
}

.zelavis-stats {
  margin-top: 24px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.zelavis-stat-card,
.zelavis-panel {
  border: 1px solid var(--zelavis-border);
  border-radius: var(--zelavis-radius-md);
  background: var(--zelavis-surface);
  box-shadow: var(--zelavis-shadow);
}

.zelavis-stat-card {
  padding: 22px;
}

.zelavis-stat-label {
  margin: 0;
  color: var(--zelavis-text-soft);
}

.zelavis-stat-value {
  margin: 12px 0 10px;
  font-size: clamp(1.8rem, 3vw, 2.8rem);
  font-weight: 700;
}

.zelavis-stat-detail {
  margin: 0;
}

.zelavis-panels {
  margin-top: 24px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.zelavis-panel {
  padding: 24px;
}

.zelavis-panel h2 {
  margin: 10px 0 12px;
  font-size: 1.5rem;
}

.zelavis-panel-eyebrow {
  color: var(--zelavis-accent);
}

.zelavis-panel-list {
  margin: 18px 0 0;
  padding-left: 18px;
  color: var(--zelavis-text);
}

.zelavis-panel-list li + li {
  margin-top: 10px;
}

@media (max-width: 960px) {
  .zelavis-shell {
    grid-template-columns: 1fr;
  }

  .zelavis-sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--zelavis-border);
  }

  .zelavis-stats,
  .zelavis-panels {
    grid-template-columns: 1fr;
  }
}
`.trim();
