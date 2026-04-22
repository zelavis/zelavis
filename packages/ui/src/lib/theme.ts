import * as React from 'react'

export type ThemeMode = 'light' | 'dark' | 'auto'

const THEME_STORAGE_KEY = 'theme'

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'auto'
}

export function getStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'auto'
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)

  return isThemeMode(stored) ? stored : 'auto'
}

export function resolveThemeMode(mode: ThemeMode) {
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

export function useThemeMode() {
  const [mode, setMode] = React.useState<ThemeMode>('auto')

  React.useEffect(() => {
    const storedMode = getStoredThemeMode()
    setMode(storedMode)
    applyThemeMode(storedMode)
  }, [])

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
