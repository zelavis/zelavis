import type { RuntimeConfig } from '#/lib/runtime-api'
import type { ThemeMode } from '#/lib/theme'

export type DashboardSettingsPersistence = 'read-only' | 'runtime'

export interface DashboardSettings {
  rootPath: string
  apiBasePath: string
  theme: ThemeMode
  persistence: DashboardSettingsPersistence
}

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  rootPath: '/zelavis',
  apiBasePath: '/zelavis/api/v1',
  theme: 'auto',
  persistence: 'read-only',
}

export function normalizeRootPath(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''

  if (!trimmed || trimmed === '/') {
    return '/'
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

export function createDashboardSettings(
  runtimeConfig: RuntimeConfig | undefined,
  theme: ThemeMode,
): DashboardSettings {
  const rootPath = normalizeRootPath(
    runtimeConfig?.rootPath || DEFAULT_DASHBOARD_SETTINGS.rootPath,
  )

  return {
    rootPath,
    apiBasePath:
      runtimeConfig?.api.basePath ??
      (rootPath === '/' ? '/api/v1' : `${rootPath}/api/v1`),
    theme,
    persistence: 'read-only',
  }
}
