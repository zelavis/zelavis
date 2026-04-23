import type {
  DashboardSettings as RuntimeDashboardSettings,
  RuntimeConfig,
} from '#/lib/runtime-api'
import type { ThemeMode } from '#/lib/theme'

export type DashboardSettings = RuntimeDashboardSettings

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  rootPath: '/zelavis',
  apiBasePath: '/zelavis/api/v1',
  theme: 'auto',
  persistence: 'read-only',
  editable: {
    rootPath: false,
    theme: false,
  },
  restartRequired: false,
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
  remoteSettings?: RuntimeDashboardSettings,
): DashboardSettings {
  const rootPath = normalizeRootPath(
    runtimeConfig?.rootPath || DEFAULT_DASHBOARD_SETTINGS.rootPath,
  )

  if (remoteSettings) {
    return {
      ...remoteSettings,
      theme,
    }
  }

  return {
    rootPath,
    apiBasePath:
      runtimeConfig?.api.basePath ??
      (rootPath === '/' ? '/api/v1' : `${rootPath}/api/v1`),
    theme,
    persistence: 'read-only',
    editable: {
      rootPath: false,
      theme: false,
    },
    restartRequired: false,
  }
}
