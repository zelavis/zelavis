import { expect, test } from '@playwright/test'

test('desktop dashboard sidebar does not overlap', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await page.goto('/')
  await expect(page.getByRole('complementary', { name: 'Dashboard navigation' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Zelavis' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()

  const nav = page.getByRole('complementary', { name: 'Dashboard navigation' })
  const links = nav.locator('a')
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

  await page.goto('/database')
  await expect(page.getByRole('button', { name: 'Toggle Sidebar' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Multi-model database' })).toBeVisible()

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

test('overview nav is only active on the overview route', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await page.goto('/database')

  await expect(page.getByRole('heading', { name: 'Multi-model database' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Overview' })).not.toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('link', { name: 'Database' })).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test('services are reachable from the settings area', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await page.goto('/settings')

  const sidebar = page.getByRole('complementary', { name: 'Dashboard navigation' })
  await expect(sidebar.getByRole('link', { name: 'Services' })).toBeVisible()
  await page.getByRole('link', { name: 'Open' }).click()
  await expect(page.getByRole('heading', { name: 'Runtime services' })).toBeVisible()
  await expect(page).toHaveURL(/\/services$/)
})

test('settings shows read-only root path controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: 'Runtime Settings' })).toBeVisible()
  await expect(page.getByLabel('Path')).toHaveValue('/zelavis')
  await expect(page.getByRole('button', { name: 'Save' }).first()).toBeDisabled()
})

test('dashboard shows a not found page inside the shell', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await page.goto('/not-a-dashboard-route')

  await expect(page.getByRole('link', { name: 'Zelavis' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dashboard route not found' })).toBeVisible()
  await expect(page.locator('main').getByRole('link', { name: 'Settings' })).toBeVisible()
})

test('footer shows the runtime config source', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await page.goto('/')

  await expect(page.locator('footer')).toContainText('/zelavis/api/v1')
  await expect(page.locator('footer')).toContainText(/embedded|endpoint|fallback/)
})
