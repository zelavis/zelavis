import { defineConfig, devices } from '@playwright/test'

function normalizeBasePath(path: string) {
  if (!path || path === '/') {
    return '/'
  }

  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`
  return `${withLeadingSlash.replace(/\/+$/, '')}/`
}

const dashboardBasePath = normalizeBasePath(
  process.env.ZELAVIS_UI_BASE_PATH ?? '/',
)
const webServerOrigin = 'http://127.0.0.1:3100'
const webServerCommand =
  dashboardBasePath === '/'
    ? 'pnpm exec vite dev --host 127.0.0.1 --port 3100'
    : `pnpm exec vite dev --host 127.0.0.1 --port 3100 --base ${dashboardBasePath}`

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  reporter: 'list',
  use: {
    baseURL: webServerOrigin,
    trace: 'on-first-retry',
  },
  webServer: {
    command: webServerCommand,
    reuseExistingServer: !process.env.CI,
    url: `${webServerOrigin}${dashboardBasePath === '/' ? '/' : dashboardBasePath}`,
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: {
          width: 1280,
          height: 900,
        },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
      },
    },
  ],
})
