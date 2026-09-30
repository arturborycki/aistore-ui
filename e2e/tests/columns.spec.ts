import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { login, shot, watchConsole } from './helpers'

const NS = '/c/local/wh/analytics/ns/sales%1Forders'

async function axe(page: Page, name: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const report = r.violations.map((v) => `${name}: ${v.id} — ${v.help}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
  expect(report, report.join('\n')).toEqual([])
}

test('columns in the explorer tree and inline in the tables list', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(NS)
  const first = (await page.locator('tbody tr td:first-child span.font-mono').first().innerText()).trim()
  await page.getByRole('button', { name: `Show columns of ${first}` }).click()
  const inline = page.getByRole('table', { name: `Columns of ${first}` })
  await expect(inline.getByRole('link').first()).toBeVisible()

  const tree = page.getByRole('tree', { name: 'Catalog explorer' })
  const expand = tree.getByRole('button', { name: 'Expand orders', exact: true })
  if (await expand.count()) await expand.click()
  await tree.getByRole('button', { name: `Expand ${first}`, exact: true }).click()
  const colLink = tree.getByRole('link').filter({ hasText: /^order_id|^event_id|^entity_id/ }).first()
  await expect(colLink).toBeVisible()
  await shot(page, '40-tree-columns')
  await colLink.click()
  await expect(page).toHaveURL(/tab=schema&col=1/)
  await expect(page.getByRole('complementary', { name: /^Column / })).toBeVisible()
  check()
})

test('schema statistics, column details and the Files tab', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(NS)
  const first = (await page.locator('tbody tr td:first-child span.font-mono').first().innerText()).trim()
  await page.goto(`${NS}/t/${first}?tab=schema`)
  const grid = page.getByRole('treegrid', { name: 'Schema' })
  await expect(grid.getByRole('columnheader', { name: 'Min' })).toBeVisible()
  await grid.getByRole('button', { name: /^Details of / }).first().click()
  const detail = page.getByRole('complementary', { name: /^Column / })
  await expect(detail.getByText('Data statistics')).toBeVisible()
  await expect(detail.getByText(/files report metrics/)).toBeVisible()
  await expect(detail.getByText('History')).toBeVisible()
  await shot(page, '41-column-detail')
  await axe(page, 'schema+detail')
  await detail.getByRole('button', { name: 'Close column details' }).click()
  await expect(detail).toHaveCount(0)

  await page.getByRole('tab', { name: /^Files/ }).click()
  await expect(page.getByText('Partitions').first()).toBeVisible()
  await expect(page.locator('td', { hasText: /^ts_day=\d{4}-\d{2}-\d{2}/ }).first()).toBeVisible()
  await page.getByRole('group', { name: 'Files view' }).getByRole('button', { name: /^Files/ }).click()
  await expect(page.locator('td', { hasText: /\.parquet$/ }).first()).toBeVisible()
  await page.getByRole('group', { name: 'Files view' }).getByRole('button', { name: /^Manifests/ }).click()
  await expect(page.locator('td', { hasText: /\.avro$/ }).first()).toBeVisible()
  await shot(page, '42-files')
  await axe(page, 'files')

  // Time travel: an older snapshot has fewer files.
  const total = Number((await page.getByText(/^Data files$/).locator('..').locator('div').nth(1).innerText()).replace(/\D/g, ''))
  await page.getByRole('tab', { name: /^Snapshots/ }).click()
  const history = page.getByRole('list', { name: 'Snapshot history' }).locator(':scope > li')
  await history.last().locator('button').first().click()
  await page.getByRole('button', { name: 'View table as of here' }).click()
  await page.getByRole('tab', { name: /^Files/ }).click()
  await expect(page.getByText(/^Showing files of snapshot/)).toBeVisible()
  const older = Number((await page.getByText(/^Data files$/).locator('..').locator('div').nth(1).innerText()).replace(/\D/g, ''))
  expect(older).toBeLessThan(total)
  check()
})

test('warehouse catalog configuration', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local/wh/analytics?tab=details')
  await expect(page.getByText('Catalog configuration')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Supported endpoints' }).or(page.getByText('Endpoints (0)'))).toBeVisible()
  check()
})

test('theme switch in the top bar; new screens pass axe in dark mode', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.getByRole('button', { name: /^Theme:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)

  await page.goto(NS)
  const first = (await page.locator('tbody tr td:first-child span.font-mono').first().innerText()).trim()
  await page.getByRole('button', { name: `Show columns of ${first}` }).click()
  await expect(page.getByRole('table', { name: `Columns of ${first}` })).toBeVisible()
  await axe(page, 'dark/tables-inline-columns')
  await page.goto(`${NS}/t/${first}?tab=schema&col=1`)
  await expect(page.getByRole('complementary', { name: /^Column / }).getByText('Data statistics')).toBeVisible()
  await expect(page.getByText(/files report metrics/)).toBeVisible()
  await shot(page, '43-dark-column-detail')
  await axe(page, 'dark/schema+detail')
  await page.getByRole('tab', { name: /^Files/ }).click()
  await expect(page.getByRole('group', { name: 'Files view' })).toBeVisible()
  await axe(page, 'dark/files')
  await page.goto('/c/local/wh/analytics?tab=details')
  await expect(page.getByText('Catalog configuration')).toBeVisible()
  await axe(page, 'dark/warehouse-config')

  // Back to light.
  await page.getByRole('button', { name: /^Theme:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Light' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  check()
})
