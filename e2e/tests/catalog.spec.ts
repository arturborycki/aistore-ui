import { expect, test } from '@playwright/test'
import { login, shot, watchConsole } from './helpers'

test('login is required and the session is httpOnly', async ({ page, context }) => {
  const check = watchConsole(page)
  await page.goto('/c/local/warehouses')
  await expect(page).toHaveURL(/\/login\?returnTo=/)
  await shot(page, '01-login')
  await page.getByLabel('Username').fill('alice')
  await page.getByLabel('Password').fill('wrong')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('not accepted')
  await page.getByLabel('Password').fill('alice-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/c\/local\/warehouses$/)
  const cookies = await context.cookies()
  expect(cookies).toHaveLength(1)
  expect(cookies[0].httpOnly).toBe(true)
  expect(cookies[0].sameSite).toBe('Strict')
  expect(await page.evaluate(() => document.cookie)).toBe('')
  check()
})

test('overview, warehouse grid with server-side sort and search', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await expect(page.getByText('Largest warehouses')).toBeVisible()
  await expect(page.getByRole('button', { name: /iot-telemetry/ }).first()).toBeVisible()
  await shot(page, '02-overview')

  await page.getByRole('link', { name: 'Warehouses' }).first().click()
  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(4)
  await page.getByRole('button', { name: 'Size' }).click()
  await expect(rows.first()).toContainText('iot-telemetry')
  await shot(page, '03-warehouses')
  await page.getByLabel('Search warehouses').fill('ml')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('ml-features')
  check()
})

test('create, browse, edit and delete with step-up', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local/warehouses')

  // Create a warehouse
  await page.getByRole('button', { name: 'New warehouse' }).click()
  await page.getByLabel('Name', { exact: true }).fill('e2e-lake')
  await page.getByRole('button', { name: 'Create warehouse' }).click()
  await expect(page).toHaveURL(/\/wh\/e2e-lake$/)
  await expect(page.getByRole('heading', { name: 'e2e-lake' })).toBeVisible()

  // Create nested namespaces
  await page.getByRole('button', { name: 'New namespace' }).click()
  await page.getByLabel('Name', { exact: true }).fill('finance')
  await page.getByRole('button', { name: 'Create namespace' }).click()
  await expect(page).toHaveURL(/\/ns\/finance$/)
  await page.getByRole('tab', { name: 'Child namespaces' }).click()
  await page.getByRole('button', { name: 'New child namespace' }).click()
  await page.getByLabel('Name', { exact: true }).fill('q3')
  await page.getByRole('button', { name: 'Create namespace' }).click()
  await expect(page.getByRole('heading', { name: 'q3' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('finance')

  // Properties: add and save
  await page.getByRole('tab', { name: /Properties/ }).click()
  await page.getByRole('button', { name: 'Add property' }).click()
  await page.getByLabel('Property key').last().fill('owner')
  await page.getByLabel(/Value for owner/).fill('finance-team')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Properties saved')).toBeVisible()
  await shot(page, '04-namespace-properties')

  // Access helper
  await page.getByRole('tab', { name: 'Access' }).click()
  await expect(page.getByText('arn:aws:s3tables:::bucket/e2e-lake', { exact: true })).toBeVisible()
  await shot(page, '05-access')

  // Delete leaf, then parent namespace
  for (const leaf of ['q3', 'finance']) {
    await page.getByRole('button', { name: 'Namespace actions' }).click()
    await page.getByRole('menuitem', { name: /Delete namespace/ }).click()
    await page.getByLabel(/Type/).fill(leaf)
    await page.getByRole('button', { name: 'Delete namespace' }).click()
    await expect(page.getByText('Namespace deleted').first()).toBeVisible()
  }
  await expect(page).toHaveURL(/\/wh\/e2e-lake$/)

  // Deleting the warehouse requires step-up (password re-entry), then retries automatically.
  await page.getByRole('button', { name: 'Warehouse actions' }).click()
  await page.getByRole('menuitem', { name: /Delete warehouse/ }).click()
  await page.getByLabel(/Type/).fill('e2e-lake')
  await page.getByRole('button', { name: 'Delete warehouse' }).click()
  await expect(page.getByRole('dialog', { name: "Confirm it's you" })).toBeVisible()
  await shot(page, '06-step-up')
  await page.getByLabel(/Password for alice/).fill('alice-password')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('Warehouse deleted')).toBeVisible()
  await expect(page).toHaveURL(/\/warehouses$/)
  check()
})

test('read-only user is denied by AIStor and told which permission is missing', async ({ page }) => {
  await login(page, 'bob', 'bob-password')
  await page.goto('/c/local/warehouses')
  await page.getByRole('button', { name: 'New warehouse' }).click()
  await page.getByLabel('Name', { exact: true }).fill('bobs-lake')
  await page.getByRole('button', { name: 'Create warehouse' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Access Denied')
  await page.keyboard.press('Escape')
  // Bob cannot see everyone's activity.
  await page.goto('/c/local/activity')
  await expect(page.getByRole('tab', { name: 'Everyone' })).toHaveCount(0)
})

test('activity records changes; dark mode; command palette; logout', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local/activity')
  await page.getByRole('tab', { name: 'Everyone' }).click()
  await expect(page.locator('tbody tr').first()).toBeVisible()
  await shot(page, '07-activity')

  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await page.keyboard.press('Escape')
  await page.goto('/c/local/wh/analytics')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('treeitem', { name: /analytics/ }).first().waitFor()
  await shot(page, '08-warehouse-dark')

  await page.keyboard.press('Control+k')
  await page.getByPlaceholder(/Jump to/).fill('marketing')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/ns\/marketing$/)
  await shot(page, '09-namespace-dark')

  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
  check()
})
