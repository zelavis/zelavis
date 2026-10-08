import { expect, test } from '@playwright/test'

const dashboardBasePath = (process.env.ZELAVIS_UI_BASE_PATH ?? '/').replace(/\/+$/, '')
const at = (path: string) => `${dashboardBasePath}${path}`

test.describe('fabric capacity', () => {
  test('@smoke the nodes panel explains how to add a machine', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(at('/server/fabric/nodes'))
    await expect(page.getByText('Fabric nodes')).toBeVisible()
    await expect(page.getByText('Add a machine you manage')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('@smoke the provider panel states what a token can do, or why cloud is unavailable', async ({ page }) => {
    await page.goto(at('/server/fabric/infrastructure/providers'))
    const connect = page.getByText('can create and delete machines in its cloud project')
    const unavailable = page.getByText('Cloud capacity is not available')
    await expect(connect.or(unavailable)).toBeVisible()
  })
})
