import * as React from 'react'

export type ThemeMode = 'light' | 'dark' | 'auto'

const THEME_STORAGE_KEY = 'theme'

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'auto'
}

export function getStoredThemeMode(): ThemeMode {
  return getStoredThemeModeOverride() ?? 'auto'
}

export function getStoredThemeModeOverride(): ThemeMode | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)

  return isThemeMode(stored) ? stored : undefined
}

export function resolveThemeMode(mode: ThemeMode) {
  if (typeof window === 'undefined') {
    return 'light'
  }

  if (mode !== 'auto') {
    return mode
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function applyThemeMode(mode: ThemeMode) {
  const resolved = resolveThemeMode(mode)
  const root = document.documentElement

  root.classList.remove('light', 'dark')
  root.classList.add(resolved)

  if (mode === 'auto') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', mode)
  }

  root.style.colorScheme = resolved
}

export function persistThemeMode(mode: ThemeMode) {
  window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  applyThemeMode(mode)
}

export function useThemeMode(defaultMode: ThemeMode = 'auto') {
  const [mode, setMode] = React.useState<ThemeMode>(
    () => getStoredThemeModeOverride() ?? defaultMode,
  )

  React.useEffect(() => {
    const nextMode = getStoredThemeModeOverride() ?? defaultMode
    setMode(nextMode)
    applyThemeMode(nextMode)
  }, [defaultMode])

  React.useEffect(() => {
    if (mode !== 'auto') {
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyThemeMode('auto')

    media.addEventListener('change', onChange)

    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [mode])

  const updateMode = React.useCallback((nextMode: ThemeMode) => {
    setMode(nextMode)
    persistThemeMode(nextMode)
  }, [])

  return [mode, updateMode] as const
}

export function useResolvedThemeMode(mode: ThemeMode) {
  const [resolvedMode, setResolvedMode] = React.useState(() =>
    resolveThemeMode(mode),
  )

  React.useEffect(() => {
    setResolvedMode(resolveThemeMode(mode))

    if (mode !== 'auto') {
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setResolvedMode(resolveThemeMode('auto'))

    media.addEventListener('change', onChange)

    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [mode])

  return resolvedMode
}
