export interface DashboardStat {
  label: string;
  value: string;
  detail: string;
}

export interface DashboardPanel {
  eyebrow: string;
  title: string;
  description: string;
  items: readonly string[];
}

export interface DashboardView {
  slug: string;
  title: string;
  description: string;
  badge: string;
  stats: readonly DashboardStat[];
  panels: readonly DashboardPanel[];
}

export interface DashboardDefinition {
  title: string;
  subtitle: string;
  assetPath: string;
  views: readonly DashboardView[];
}

export interface DashboardServiceOptions {
  title?: string;
  subtitle?: string;
  assetPath?: string;
  basePath?: string;
  views?: readonly DashboardView[];
}
