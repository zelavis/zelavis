import { expect, test } from '@playwright/test'

test('desktop dashboard top bar does not overlap', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')

  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Zelavis' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()

  const header = page.locator('header')
  const nav = header.locator('nav')
  const links = header.locator('a')

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
  await expect(page.getByRole('link', { name: 'Zelavis' })).toBeVisible()
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
