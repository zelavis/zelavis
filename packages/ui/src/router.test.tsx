// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'

import { getRouter } from './router'

afterEach(() => {
  window.__ZELAVIS_RUNTIME_CONFIG__ = undefined
  window.history.replaceState(null, '', '/')
})

test('router rewrites runtime root paths for mounted dashboard routes', () => {
  window.__ZELAVIS_RUNTIME_CONFIG__ = {
    name: 'zelavis',
    rootPath: '/zelavis',
    api: {
      prefix: '/api',
      version: 'v1',
      basePath: '/zelavis/api/v1',
    },
    dashboard: {
      title: 'zelavis',
      clientRoutes: ['/database', '/settings'],
      assetRoot: '/zelavis/assets',
    },
    services: [],
    plugins: [],
  }
  window.history.replaceState(null, '', '/zelavis/database')

  const router = getRouter()
  const settings = router.buildLocation({
    to: '/settings',
  })

  expect(router.latestLocation.pathname).toBe('/database')
  expect(settings.pathname).toBe('/settings')
  expect(settings.publicHref).toBe('/zelavis/settings')
})
