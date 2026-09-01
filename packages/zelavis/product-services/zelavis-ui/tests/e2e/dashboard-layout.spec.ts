import { expect, test, type Locator, type Page } from '@playwright/test'

import type { RuntimeConfig } from '../../app/lib/runtime-api'

function normalizeDashboardBasePath(path: string) {
  if (!path || path === '/') {
    return ''
  }

  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`
  return withLeadingSlash.replace(/\/+$/, '')
}

const dashboardBasePath = normalizeDashboardBasePath(
  process.env.ZELAVIS_UI_BASE_PATH ?? '/',
)
const e2eProjectId = process.env.ZELAVIS_E2E_PROJECT_ID
const projectLocalPaths = new Set([
  '/',
  '/auth',
  '/backend',
  '/content',
  '/database',
  '/extensions',
  '/marketplace',
  '/media',
  '/storage',
  '/users',
  '/website',
  '/workloads',
])

function scopeProjectPath(path: string) {
  if (!e2eProjectId) {
    return path
  }

  const url = new URL(path, 'http://zelavis.local')
  const root = `/${url.pathname.split('/').filter(Boolean)[0] ?? ''}`
  if (!projectLocalPaths.has(root)) {
    return path
  }

  const projectRoot = `/projects/${encodeURIComponent(e2eProjectId)}`
  const projectPath = url.pathname === '/' ? projectRoot : `${projectRoot}${url.pathname}`
  return `${projectPath}${url.search}`
}

function toDashboardPath(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (!dashboardBasePath) {
    return normalizedPath
  }

  if (normalizedPath === '/') {
    return `${dashboardBasePath}/`
  }

  return `${dashboardBasePath}${normalizedPath}`
}

async function gotoDashboard(page: Page, path: string) {
  await page.goto(toDashboardPath(scopeProjectPath(path)))
  await waitForDashboardHydration(page)
}

async function waitForDashboardHydration(page: Page) {
  await page.locator('html[data-zelavis-hydrated="true"]').waitFor()
}

function createMockRuntimeConfig(): RuntimeConfig {
  return {
    name: 'zelavis',
    rootPath: '/zelavis',
    api: {
      prefix: '/api',
      version: 'v1',
      basePath: '/zelavis/api/v1',
    },
    dashboard: {
      title: 'Zelavis Dashboard',
      clientRoutes: [],
      assetRoot: '/zelavis',
    },
    services: [
      {
        name: '@zelavis/ui',
        core: true,
        apiPath: '/zelavis',
        menu: {
          title: 'Dashboard',
          path: '/',
          surface: 'root',
        },
      },
      {
        name: '@zelavis/auth',
        core: true,
        apiPath: '/zelavis/api/v1/auth',
        menu: {
          title: 'Auth',
          path: '/auth',
          surface: 'core',
        },
      },
      {
        name: '@zelavis/db',
        core: true,
        apiPath: '/zelavis/api/v1/database',
        menu: {
          title: 'Database',
          path: '/database',
          surface: 'core',
        },
      },
    ],
    serviceRegistry: [],
    configSource: 'embedded' as const,
  }
}

async function getTranslateX(track: Locator) {
  return track.evaluate((element) => {
    const transform = getComputedStyle(element).transform

    if (transform === 'none') {
      return 0
    }

    return new DOMMatrixReadOnly(transform).m41
  })
}

test('@smoke desktop dashboard sidebar does not overlap', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')
  await expect(page.getByRole('navigation', { name: 'Dashboard navigation' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Zelavis Runtime/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()

  const appHeader = page.locator('[data-slot="sidebar-inset"] > header').first()
  await expect(appHeader.getByRole('link', { name: 'GitHub' })).toHaveCount(0)
  await expect(appHeader.getByRole('button', { name: /Theme mode/ })).toHaveCount(0)

  const nav = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const rootSlide = nav.locator('.swiper-slide-active').first()
  const links = rootSlide
    .getByRole('list')
    .first()
    .locator('a')
  await expect(nav).toBeVisible()

  const navOverflow = await nav.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  )
  expect(navOverflow).toBeLessThanOrEqual(1)

  const boxes = await links.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        text: element.textContent?.trim() ?? '',
      }
    }),
  )

  for (let index = 1; index < boxes.length; index += 1) {
    const previous = boxes[index - 1]
    const current = boxes[index]
    const sameRow =
      Math.max(previous.top, current.top) < Math.min(previous.bottom, current.bottom)

    if (sameRow) {
      expect(current.left, `${previous.text} overlaps ${current.text}`).toBeGreaterThanOrEqual(
        previous.right - 1,
      )
    }
  }

  const screenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath('dashboard-desktop.png'),
  })
  await testInfo.attach('dashboard desktop', {
    body: screenshot,
    contentType: 'image/png',
  })
})

test('mobile dashboard captures a stable stacked header', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile')

  await gotoDashboard(page, '/database')
  await expect(page.getByRole('button', { name: 'Toggle Sidebar' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Database' })).toBeVisible()

  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(pageOverflow).toBeLessThanOrEqual(1)

  const screenshot = await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath('dashboard-mobile.png'),
  })
  await testInfo.attach('dashboard mobile', {
    body: screenshot,
    contentType: 'image/png',
  })
})

test('@smoke mounted dev server can serve the dashboard from /zelavis/', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  test.skip(dashboardBasePath !== '/zelavis')

  await gotoDashboard(page, '/settings')

  await expect(page).toHaveURL(/\/zelavis\/settings$/)
  await expect(page.getByText('Configuration', { exact: true })).toBeVisible()
  await expect(page.locator('html[data-zelavis-hydrated="true"]')).toBeVisible()
})

test('@smoke database route restores the database sidebar panel', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/database')

  await expect(page.getByRole('heading', { name: 'Database' })).toBeVisible()
  const activeSlide = page
    .getByRole('navigation', { name: 'Dashboard navigation' })
    .locator('.swiper-slide-active')
    .first()

  await expect(activeSlide.getByRole('button', { name: 'Database', exact: true })).toBeVisible()
})

test('storage lives under the core slide for advanced runtime management', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/storage')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const activeSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(activeSlide.getByRole('button', { name: 'Core' })).toBeVisible()
  await expect(activeSlide.getByRole('link', { name: 'Auth', exact: true })).toBeVisible()
  await expect(activeSlide.getByRole('button', { name: 'Database', exact: true })).toBeVisible()
  await expect(activeSlide.getByRole('link', { name: 'Storage', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible()
  await expect(
    activeSlide.getByRole('link', { name: 'Storage', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
})

test('users is a top-level item on the first sidebar slide', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/users')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const rootSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(rootSlide.getByRole('link', { name: 'Users', exact: true })).toBeVisible()
  await expect(rootSlide.getByRole('button', { name: 'Core' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
})

test('content route restores the content types sidebar panel', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/content')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const activeSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(activeSlide.getByRole('button', { name: 'Content Types', exact: true })).toBeVisible()
  await expect(
    activeSlide.getByRole('link', { name: 'All Content Types', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Content Studio' })).toBeVisible()
})

test('content type sidebar parent opens entries view', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  const runtimeConfig = createMockRuntimeConfig()
  const dashboardSettings = {
    rootPath: '/zelavis',
    apiBasePath: '/zelavis/api/v1',
    theme: 'auto',
    pageBuilderEnabled: true,
    preferences: {
      content: {
        labels: {
          'blog-posts': 'Blog Posts',
        },
      },
    },
    persistence: 'runtime',
    editable: {
      rootPath: true,
      theme: true,
      pageBuilder: true,
    },
    restartRequired: false,
  }
  const collections = [
    {
      name: 'blog-posts',
      tenantId: 'default',
      createdAt: '2026-06-17T00:00:00.000Z',
      documentCount: 0,
      surface: 'content-studio',
      metadata: { kind: 'content-type' },
    },
  ]

  await page.addInitScript((config) => {
    ;(window as typeof window & { __ZELAVIS_RUNTIME_CONFIG__?: unknown }).__ZELAVIS_RUNTIME_CONFIG__ =
      config
  }, runtimeConfig)

  await page.route('**/zelavis/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()

    if (pathname === '/zelavis/api/v1/runtime/settings' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardSettings) })
      return
    }

    if (pathname === '/zelavis/api/v1/database/documents/collections' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ collections }),
      })
      return
    }

    if (pathname === '/zelavis/api/v1/database/schemas/collections' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          collections: [{ collection: 'blog-posts', activeVersion: 1, versions: [1] }],
        }),
      })
      return
    }

    if (pathname === '/zelavis/api/v1/database/documents/blog-posts/query' && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documents: [] }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    })
  })

  await gotoDashboard(page, '/content')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  await sidebar.getByRole('button', { name: 'Blog Posts', exact: true }).click()

  await expect(page).toHaveURL(/\/content\/blog-posts(?:\?sidebar=Content%2FBlog%2520Posts)?$/)
  await expect(page.getByText('No entries yet')).toBeVisible()
})

test('database slide lists logical tables', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/database')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const tablesSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(tablesSlide.getByRole('button', { name: 'Database', exact: true })).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Core Database' })).toBeVisible()
})

test('content studio creates a new type and opens the field builder', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  const runtimeConfig = createMockRuntimeConfig()
  const dashboardSettings = {
    rootPath: '/zelavis',
    apiBasePath: '/zelavis/api/v1',
    theme: 'auto',
    pageBuilderEnabled: true,
    preferences: {},
    persistence: 'runtime',
    editable: {
      rootPath: true,
      theme: true,
      pageBuilder: true,
    },
    restartRequired: false,
  }

  var createdCollectionName: string | undefined
  var createdSchemaFields: unknown[] | undefined

  await page.addInitScript((config) => {
    ;(window as typeof window & { __ZELAVIS_RUNTIME_CONFIG__?: unknown }).__ZELAVIS_RUNTIME_CONFIG__ =
      config
  }, runtimeConfig)

  await page.route('**/zelavis/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()

    const json = async () => JSON.parse(request.postData() ?? '{}') as Record<string, unknown>

    if (pathname === '/zelavis/api/v1/runtime/settings' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardSettings) })
      return
    }

    if (pathname === '/zelavis/api/v1/database/documents/collections' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          collections: createdCollectionName
            ? [
                {
                  name: createdCollectionName,
                  tenantId: 'default',
                  createdAt: '2026-05-26T00:00:00.000Z',
                  documentCount: 0,
                  surface: 'content-studio',
                },
              ]
            : [],
        }),
      })
      return
    }

    if (pathname === '/zelavis/api/v1/database/schemas/collections' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          collections: createdCollectionName
            ? [
                {
                  collection: createdCollectionName,
                  activeVersion: 1,
                  versions: [1],
                },
              ]
            : [],
        }),
      })
      return
    }

    if (pathname === '/zelavis/api/v1/database/documents/collections' && method === 'POST') {
      const body = await json()
      createdCollectionName = String(body.name)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: createdCollectionName,
          tenantId: 'default',
          createdAt: '2026-05-26T00:00:00.000Z',
          documentCount: 0,
          surface: 'content-studio',
        }),
      })
      return
    }

    if (
      pathname === `/zelavis/api/v1/database/schemas/${encodeURIComponent(createdCollectionName ?? 'animals')}` &&
      method === 'POST'
    ) {
      const body = await json()
      createdSchemaFields = body.fields as unknown[]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          collection: createdCollectionName,
          version: 1,
          active: true,
          fields: createdSchemaFields,
        }),
      })
      return
    }

    if (
      pathname === `/zelavis/api/v1/database/schemas/${encodeURIComponent(createdCollectionName ?? 'animals')}` &&
      method === 'GET'
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          collection: createdCollectionName ?? 'animals',
          schemas: createdSchemaFields
            ? [
                {
                  collection: createdCollectionName ?? 'animals',
                  version: 1,
                  active: true,
                  fields: createdSchemaFields,
                },
              ]
            : [],
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    })
  })

  await gotoDashboard(page, '/content/new')

  await page.getByLabel('Content type label').fill('Animals')
  await page.getByRole('button', { name: 'Create and Open Fields' }).click()

  await expect(page).toHaveURL(/\/content\/animals\/fields$/)
  await expect(page.getByText('Field builder', { exact: true })).toBeVisible()
})

test('database table creation revalidates sidebar tables', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  const runtimeConfig = createMockRuntimeConfig()
  const dashboardSettings = {
    rootPath: '/zelavis',
    apiBasePath: '/zelavis/api/v1',
    theme: 'auto',
    pageBuilderEnabled: true,
    preferences: {},
    persistence: 'runtime',
    editable: {
      rootPath: true,
      theme: true,
      pageBuilder: true,
    },
    restartRequired: false,
  }

  var createdCollectionName: string | undefined

  await page.addInitScript((config) => {
    ;(window as typeof window & { __ZELAVIS_RUNTIME_CONFIG__?: unknown }).__ZELAVIS_RUNTIME_CONFIG__ =
      config
  }, runtimeConfig)

  await page.route('**/zelavis/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()

    const collections = createdCollectionName
      ? [
          {
            name: createdCollectionName,
            tenantId: 'default',
            createdAt: '2026-05-26T00:00:00.000Z',
            documentCount: 0,
            metadata: {
              surface: 'database',
              kind: 'table',
            },
          },
        ]
      : []

    if (pathname === '/zelavis/api/v1/runtime/settings' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardSettings) })
      return
    }

    if (pathname === '/zelavis/api/v1/database/documents/collections' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ collections }),
      })
      return
    }

    if (pathname === '/zelavis/api/v1/database/schemas/collections' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ collections: [] }),
      })
      return
    }

    if (pathname === '/zelavis/api/v1/database/documents/collections' && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>
      createdCollectionName = String(body.name)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(collections[0] ?? {
          name: createdCollectionName,
          tenantId: 'default',
          createdAt: '2026-05-26T00:00:00.000Z',
          documentCount: 0,
          metadata: body.metadata,
        }),
      })
      return
    }

    if (pathname === '/zelavis/api/v1/database/documents/invoices/query' && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documents: [] }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    })
  })

  await gotoDashboard(page, '/database/new')

  await page.getByLabel('Table name').fill('invoices')
  await page.getByRole('button', { name: 'Create and Open Table' }).click()

  await expect(page).toHaveURL(/databaseTable=invoices/)

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const activeSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(activeSlide.getByRole('link', { name: 'invoices', exact: true })).toBeVisible()
})

test('content can navigate to the dedicated new content type route', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/content')

  await page.getByRole('link', { name: 'Create new Content Type' }).click()

  await expect(page).toHaveURL(/\/content\/new$/)
  await expect(page.getByRole('heading', { name: 'New Content Type' })).toBeVisible()
})

test('media gallery is a top-level item on the first sidebar slide', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/media')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const rootSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(rootSlide.getByRole('link', { name: 'Media Gallery', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Media Gallery' })).toBeVisible()
})

test('navigation can leave media gallery after visiting it', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/media')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  await sidebar.getByRole('link', { name: 'Users', exact: true }).click()

  await expect(page).toHaveURL(/\/users$/)
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Media Gallery' })).toHaveCount(0)
})

test('marketplace is a top-level item on the first sidebar slide', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/marketplace')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const rootSlide = sidebar.locator('.swiper-slide-active').first()

  // Nothing in the dashboard names the marketplace. This link exists only
  // because `@zelavis/marketplace` contributed it through the SDK, so it is
  // also the end-to-end check that the menu extension point works.
  await expect(rootSlide.getByRole('link', { name: 'Marketplace', exact: true })).toBeVisible()
})

test('@smoke marketplace renders the page its own service ships', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/marketplace')

  // The dashboard has no marketplace route. The page comes from the service,
  // through the service page frame, fetched from the service page asset route.
  const frame = page.locator('zelavis-service-frame')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute(
    'src',
    /runtime\/service-page-assets\/%40zelavis%2Fmarketplace\/.*marketplace\.html$/,
  )

  await expect(
    page.frameLocator('zelavis-service-frame iframe').getByRole('heading', {
      name: 'Marketplace',
    }),
  ).toBeVisible()
})

test('marketplace does not expose ecommerce in extensions before install', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  await expect(sidebar.getByRole('button', { name: 'Extensions', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Ecommerce', exact: true })).toHaveCount(0)
})

test('marketplace info opens a plugin details panel', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/marketplace')

  await page.getByRole('button', { name: 'Info' }).first().click()
  const sheet = page.getByRole('dialog', { name: 'Zelavis Ecommerce' })
  await expect(sheet.getByRole('heading', { name: 'Zelavis Ecommerce' })).toBeVisible()
  await expect(sheet.getByText('Extensions area with nested slides')).toBeVisible()
})

test('sidebar category rows drill down into sliding panels', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')
  await page.getByRole('button', { name: 'Backend' }).click()

  await expect(page.getByRole('button', { name: 'Database', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Auth', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Database', exact: true }).click()
  await expect(
    page.getByRole('navigation', { name: 'Dashboard navigation' }).locator('.swiper-slide-active'),
  ).toContainText('Database')

  await page.getByRole('button', { name: 'Database' }).click()
  await expect(
    page
      .getByRole('navigation', { name: 'Dashboard navigation' })
      .getByRole('button', { name: 'Backend', exact: true }),
  ).toBeVisible()
})

test('sidebar back works on route-owned panels without changing content', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/settings')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const activeSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(activeSlide.getByRole('link', { name: 'Runtime', exact: true })).toBeVisible()
  await activeSlide.getByRole('button', { name: 'Settings', exact: true }).click()

  await expect(sidebar.locator('.swiper-slide-active').first().getByRole('link', {
    name: 'Overview',
    exact: true,
  })).toBeVisible()
  await expect(page.getByText('Configuration', { exact: true })).toBeVisible()
})

test('sidebar shows a single platform label on the root panel', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  await expect(sidebar.getByText('Platform', { exact: true })).toHaveCount(1)
  await expect(
    sidebar.locator('.swiper-slide-active').getByText('Platform', { exact: true }),
  ).toBeVisible()
  await expect(sidebar.getByText('Help', { exact: true })).toBeVisible()
})

test('sidebar panels animate between slides', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const viewport = sidebar.locator('.swiper')
  const track = sidebar.locator('.swiper-wrapper')
  const viewportWidth = await viewport.evaluate((element) => element.clientWidth)

  await sidebar.getByRole('button', { name: 'Backend', exact: true }).click()
  await page.waitForTimeout(60)

  const translateX = await getTranslateX(track)

  expect(translateX).toBeLessThan(-1)
  expect(translateX).toBeGreaterThan(-viewportWidth + 1)

  await expect.poll(() => getTranslateX(track)).toBeLessThanOrEqual(-viewportWidth + 10)

  await sidebar.getByRole('button', { name: 'Backend', exact: true }).click()
  await page.waitForTimeout(60)

  const backTranslateX = await getTranslateX(track)

  expect(backTranslateX).toBeLessThan(-1)
  expect(backTranslateX).toBeGreaterThan(-viewportWidth + 1)

  await expect.poll(() => getTranslateX(track)).toBeGreaterThanOrEqual(-10)
})

test('sidebar back to platform returns the page to overview', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  let activeSlide = sidebar.locator('.swiper-slide-active').first()

  await activeSlide.getByRole('button', { name: 'Backend', exact: true }).click()
  activeSlide = sidebar.locator('.swiper-slide-active').first()
  await activeSlide.getByRole('button', { name: 'Database', exact: true }).click()
  activeSlide = sidebar.locator('.swiper-slide-active').first()
  await activeSlide.getByRole('link', { name: 'Create Table', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'New Table' })).toBeVisible()
  await activeSlide.getByRole('button', { name: 'Backend', exact: true }).click()
  activeSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(activeSlide.getByRole('button', { name: 'Platform', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'New Table' })).toBeVisible()
  await activeSlide.getByRole('button', { name: 'Platform', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Zelavis runtime' })).toBeVisible()
  const url = new URL(page.url())
  expect(url.pathname).toBe(toDashboardPath('/'))
  expect(url.search).toBe('')
})

test('sidebar panel state survives refresh through the router', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')
  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })

  await sidebar.getByRole('button', { name: 'Extensions', exact: true }).click()

  await expect(page).toHaveURL(/sidebar=Extensions/)
  await expect(page.getByRole('link', { name: 'Agents', exact: true })).toBeVisible()

  await page.reload()
  await waitForDashboardHydration(page)

  await expect(sidebar.getByRole('button', { name: 'Extensions', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Builder', exact: true })).toBeVisible()
})

test('sidebar route panels restore from the current route on refresh', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/database')

  await page.reload()
  await waitForDashboardHydration(page)

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const activeSlide = sidebar.locator('.swiper-slide-active').first()

  await expect(activeSlide.getByRole('button', { name: 'Database', exact: true })).toBeVisible()
})

test('sidebar has one internal link per dashboard route', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')

  const internalHrefs = await page
    .getByRole('navigation', { name: 'Dashboard navigation' })
    .locator('a[href^="/"]')
    .evaluateAll((links) =>
      links.map((link) => {
        const url = new URL(link.getAttribute('href') ?? '/', window.location.href)
        return `${url.pathname}${url.search}`
      }),
    )

  expect(internalHrefs).toEqual(Array.from(new Set(internalHrefs)))
})

test('desktop sidebar collapses to a rail and expands content', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  const sidebarState = page.locator('[data-slot="sidebar"]').first()
  const header = page.locator('body > div header').first()
  const expandedSidebar = await sidebar.boundingBox()
  const expandedHeader = await header.boundingBox()

  expect(expandedSidebar?.width).toBeGreaterThan(200)
  expect(expandedHeader?.x).toBeGreaterThan(200)

  await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
  await expect(sidebarState).toHaveAttribute('data-state', 'collapsed')
  await page.waitForTimeout(250)

  const collapsedSidebar = await sidebar.boundingBox()
  const collapsedHeader = await header.boundingBox()

  expect(collapsedSidebar?.width).toBeLessThan(100)
  expect(collapsedHeader?.x).toBeLessThan(expandedHeader?.x ?? 0)
})

test('services are reachable from the settings area', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/settings')

  const sidebar = page.getByRole('navigation', { name: 'Dashboard navigation' })
  await expect(sidebar.getByRole('link', { name: 'Services', exact: true })).toBeVisible()
  await page
    .locator('[data-slot="card"]')
    .filter({ hasText: 'Runtime Services' })
    .getByRole('link', { name: 'Open' })
    .click()
  await expect(page.getByRole('heading', { name: 'Runtime services' })).toBeVisible()
  await expect(page).toHaveURL(/\/services$/)
})

test('@smoke settings shows read-only root path controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/settings')

  await expect(page.getByText('Configuration', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Path')).toHaveValue('/zelavis')
  await expect(
    page.getByText(
      /Read-only until runtime settings storage is available\.|Runtime settings storage is available\. Root path changes apply after restart\./,
    ),
  ).toBeVisible()
})

test('appearance settings persist the dashboard theme', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/settings/appearance')

  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expect(page.getByText('Dashboard theme preferences for this browser.')).toBeVisible()
  await expect(page.locator('[data-slot="card-title"]').getByText('Preview')).toBeVisible()

  const themeSelect = page.getByRole('combobox', { name: 'Theme' })
  await themeSelect.click()
  await page.getByRole('option', { name: 'Dark' }).click()

  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByText('Current theme: dark')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('theme')))
    .toBe('dark')

  await themeSelect.click()
  await page.getByRole('option', { name: 'Light' }).click()

  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await expect(page.getByText('Current theme: light')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('theme')))
    .toBe('light')
})

test('dashboard shows a not found page inside the shell', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/not-a-dashboard-route')

  await expect(page.getByRole('button', { name: /Zelavis Runtime/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dashboard route not found' })).toBeVisible()
  await expect(page.locator('main').getByRole('link', { name: 'Settings' })).toBeVisible()
})

test('team switcher opens runtime teams', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')
  await page.getByRole('button', { name: /Zelavis Runtime/ }).click()

  await expect(page.getByRole('menuitem', { name: /Local/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Core/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Add team/ })).toBeVisible()
})

test('sidebar popovers use neutral shadcn hover states', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')

  const teamTrigger = page.getByRole('button', { name: /Zelavis Runtime/ })
  await teamTrigger.click()

  const teamItem = page.getByRole('menuitem', { name: /Zelavis/ }).first()
  await expect(teamItem).toBeVisible()
  await teamItem.hover()

  const teamHover = await teamItem.evaluate((element) => {
    const styles = getComputedStyle(element)

    return {
      backgroundColor: styles.backgroundColor,
      color: styles.color,
    }
  })

  expect(teamHover).toEqual({
    backgroundColor: 'oklch(0.97 0 0)',
    color: 'oklch(0.205 0 0)',
  })

  const teamMenuScreenshot = await page
    .locator('[data-slot="dropdown-menu-content"]')
    .screenshot({
      path: testInfo.outputPath('team-switcher-popover.png'),
    })

  await testInfo.attach('team switcher popover', {
    body: teamMenuScreenshot,
    contentType: 'image/png',
  })

  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /Runtime dashboard/ }).click()

  const accountItem = page.getByRole('menuitem', { name: /Account/ })
  await expect(accountItem).toBeVisible()
  await accountItem.hover()

  const userHover = await accountItem.evaluate((element) => {
    const styles = getComputedStyle(element)

    return {
      backgroundColor: styles.backgroundColor,
      color: styles.color,
    }
  })

  expect(userHover).toEqual({
    backgroundColor: 'oklch(0.97 0 0)',
    color: 'oklch(0.205 0 0)',
  })

  const userMenuScreenshot = await page
    .locator('[data-slot="dropdown-menu-content"]')
    .screenshot({
      path: testInfo.outputPath('runtime-user-popover.png'),
    })

  await testInfo.attach('runtime user popover', {
    body: userMenuScreenshot,
    contentType: 'image/png',
  })
})

test('sidebar popovers use neutral shadcn hover states in dark mode', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))
  await gotoDashboard(page, '/')

  await expect(page.locator('html')).toHaveClass(/dark/)

  await page.getByRole('button', { name: /Zelavis Runtime/ }).click()

  const teamItem = page.getByRole('menuitem', { name: /Zelavis/ }).first()
  await expect(teamItem).toBeVisible()
  await teamItem.hover()

  const teamHover = await teamItem.evaluate((element) => {
    const styles = getComputedStyle(element)

    return {
      backgroundColor: styles.backgroundColor,
      color: styles.color,
    }
  })

  expect(teamHover).toEqual({
    backgroundColor: 'oklch(0.269 0 0)',
    color: 'oklch(0.985 0 0)',
  })

  const teamMenuScreenshot = await page
    .locator('[data-slot="dropdown-menu-content"]')
    .screenshot({
      path: testInfo.outputPath('team-switcher-popover-dark.png'),
    })

  await testInfo.attach('team switcher popover dark', {
    body: teamMenuScreenshot,
    contentType: 'image/png',
  })
})

test('@smoke overview shows the scoped runtime config source', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await gotoDashboard(page, '/')

  await expect(
    page.getByText(/\/runtime\/projects\/dashboard-e2e\/proxy\/zelavis\/api\/v1/).first(),
  ).toBeVisible()
})
