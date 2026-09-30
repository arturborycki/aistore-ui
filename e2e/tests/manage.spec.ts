import { expect, test, type Page } from '@playwright/test'
import { login, shot, watchConsole } from './helpers'

const MARKETING = '/c/local/wh/analytics/ns/marketing'

async function toast(page: Page, text: string | RegExp) {
  await expect(page.locator('[role=status], [role=alert]').filter({ hasText: text }).first()).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test('create a partitioned, sorted v3 table with nested columns', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(MARKETING)
  await page.getByRole('link', { name: 'New table' }).click()
  await expect(page.getByRole('heading', { name: 'Create table' })).toBeVisible()
  await page.getByLabel('Table name').fill('e2e_events')
  await page.getByLabel('Iceberg format version').selectOption('3')

  // Add a struct column with a nested field.
  await page.getByRole('button', { name: 'Add column' }).click()
  await page.getByLabel('Column name').last().fill('device')
  await page.getByLabel('Type of device').selectOption('struct')
  await page.getByLabel('Column name').last().fill('serial')

  // Partition by day(created_at), sort by id desc.
  await page.getByRole('button', { name: 'Add partition field' }).click()
  await page.getByLabel('Source column').selectOption({ label: 'created_at (timestamptz)' })
  await page.getByLabel('Transform').selectOption('day')
  await expect(page.getByLabel('Partition field name')).toHaveValue('created_at_day')
  await page.getByRole('button', { name: 'Add sort field' }).click()
  await page.getByLabel('Direction').selectOption('desc')
  await page.getByRole('button', { name: 'Show request' }).click()
  await shot(page, '11-create-table')

  await page.getByRole('button', { name: 'Create table' }).click()
  await expect(page).toHaveURL(/\/t\/e2e_events$/)
  await expect(page.getByText('Iceberg v3')).toBeVisible()
  await page.getByRole('tab', { name: /^Partitioning/ }).click()
  await expect(page.getByText('day(created_at)')).toBeVisible()
  await page.getByRole('tab', { name: /^Schema/ }).click()
  await expect(page.getByRole('treegrid').getByText('serial')).toBeVisible()
  check()
})

test('evolve schema: add, rename, protect partition source; conflicts are detected', async ({ page, context }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(`${MARKETING}/t/e2e_events?tab=schema`)
  await page.getByRole('button', { name: 'Evolve schema' }).click()
  const dialog = page.getByRole('dialog', { name: 'Evolve schema' })

  // Dropping the partition source column is blocked.
  await dialog.getByRole('button', { name: 'Remove created_at' }).click()
  await expect(dialog.getByText(/created_at is used by the current partition spec/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Restore created_at' }).click()

  await dialog.getByLabel('Column name').nth(2).fill('body') // payload → body
  await dialog.getByRole('button', { name: 'Add column', exact: true }).click()
  await dialog.getByLabel('Column name').last().fill('note')
  await expect(dialog.getByText('Rename payload → body')).toBeVisible()
  await expect(dialog.getByText('Add note (string)')).toBeVisible()
  await shot(page, '12-evolve-schema')

  // Meanwhile, another tab changes the table.
  const other = await context.newPage()
  await other.goto(`${MARKETING}/t/e2e_events?tab=properties`)
  await other.getByRole('button', { name: 'Add property' }).click()
  await other.getByLabel('Property key').last().fill('touched')
  await other.getByLabel(/Value for touched/).fill('yes')
  await other.getByRole('button', { name: 'Save changes' }).click()
  await expect(other.getByText('Committed').first()).toBeVisible()
  // Properties do not conflict with a schema change: it still applies.
  await dialog.getByRole('button', { name: 'Apply schema change' }).click()
  await toast(page, 'Committed')
  await expect(page.getByText('Changes from schema 0 → 1')).toBeVisible()

  // A second schema edit prepared from stale metadata is rejected with 409.
  await page.getByRole('button', { name: 'Evolve schema' }).click()
  await other.goto(`${MARKETING}/t/e2e_events?tab=schema`)
  await other.getByRole('button', { name: 'Evolve schema' }).click()
  await other.getByRole('dialog').getByRole('button', { name: 'Add column', exact: true }).click()
  await other.getByRole('dialog').getByLabel('Column name').last().fill('from_other_tab')
  await other.getByRole('button', { name: 'Apply schema change' }).click()
  await expect(other.getByText('Changes from schema 1 → 2')).toBeVisible()
  const d2 = page.getByRole('dialog', { name: 'Evolve schema' })
  await d2.getByRole('button', { name: 'Add column', exact: true }).click()
  await d2.getByLabel('Column name').last().fill('stale')
  await d2.getByRole('button', { name: 'Apply schema change' }).click()
  await expect(d2.getByText(/Someone changed this table/)).toBeVisible()
  await shot(page, '13-conflict')
  await other.close()
  check()
})

test('evolve partitioning and sort order', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(`${MARKETING}/t/e2e_events?tab=partitions`)
  await page.getByRole('button', { name: 'Evolve' }).click()
  const d = page.getByRole('dialog', { name: 'Evolve partitioning' })
  await d.getByRole('button', { name: 'Add partition field' }).click()
  await d.getByLabel('Source column').last().selectOption({ label: 'id (long)' })
  await d.getByLabel('Transform').last().selectOption('bucket')
  await d.getByRole('button', { name: 'Apply new spec' }).click()
  await toast(page, 'Committed')
  await expect(page.locator('td', { hasText: 'bucket(16, id)' })).toBeVisible()
  await expect(page.getByText('spec 1')).toBeVisible()

  await page.getByRole('button', { name: 'Change' }).click()
  const s = page.getByRole('dialog', { name: 'Change sort order' })
  await s.getByRole('button', { name: 'Remove sort field' }).click()
  await s.getByRole('button', { name: 'Apply sort order' }).click()
  await toast(page, 'Committed')
  check()
})

test('rollback, tag and remove tag on a seeded table', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local/wh/analytics/ns/sales%1Forders')
  await page.locator('tbody tr').first().click()
  await page.getByRole('tab', { name: /^Snapshots/ }).click()
  const history = page.getByRole('list', { name: 'Snapshot history' }).locator(':scope > li')
  await history.nth(2).locator('button').first().click()
  await page.getByRole('button', { name: 'Roll back main to here' }).click()
  const rb = page.getByRole('dialog', { name: 'Roll back table' })
  await expect(rb.getByText('After rollback')).toBeVisible()
  await shot(page, '14-rollback')
  await rb.getByRole('button', { name: 'Roll back main' }).click()
  await toast(page, /Roll back main/)
  await expect(history.nth(2).getByText('main', { exact: true })).toBeVisible()

  // The row stays expanded after the commit.
  await page.getByRole('button', { name: 'Branch or tag here' }).click()
  const rd = page.getByRole('dialog', { name: 'Create branch or tag' })
  await rd.getByLabel('Name', { exact: true }).fill('e2e-tag')
  await rd.getByLabel('Expire reference after (days)').fill('30')
  await rd.getByRole('button', { name: 'Create tag' }).click()
  await toast(page, /Create tag e2e-tag/)
  await page.getByRole('button', { name: 'Actions for e2e-tag' }).click()
  await page.getByRole('menuitem', { name: /Remove tag/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove tag' }).click()
  await toast(page, /Remove tag e2e-tag/)
  await expect(page.getByRole('button', { name: 'Actions for e2e-tag' })).toHaveCount(0)
  check()
})

test('multi-table change set applies atomically', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(MARKETING)
  const cells = page.locator('tbody tr td:first-child span.font-mono')
  await cells.first().waitFor()
  const names = (await cells.allInnerTexts()).map((s) => s.trim()).slice(0, 2)
  for (const n of names) {
    await page.goto(`${MARKETING}/t/${n}?tab=properties`)
    await page.getByRole('button', { name: 'Add property' }).click()
    await page.getByLabel('Property key').last().fill('release')
    await page.getByLabel(/Value for release/).fill('2026.10')
    await page.getByRole('button', { name: 'Add to change set' }).click()
  }
  const tray = page.getByRole('region', { name: 'Change set' })
  await expect(tray).toContainText('2 tables')
  await shot(page, '15-change-set')
  await tray.getByRole('button', { name: 'Apply atomically' }).click()
  await toast(page, 'Change set applied')
  await expect(tray).toHaveCount(0)
  for (const n of names) {
    await page.goto(`${MARKETING}/t/${n}?tab=properties`)
    await expect(page.getByLabel(/Value for release/)).toHaveValue('2026.10')
  }
  check()
})

test('warehouse settings, table maintenance, format upgrade', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local/wh/analytics?tab=settings')
  await page.getByLabel('Tag key').fill('cost-center')
  await page.getByLabel('Tag value').fill('cc-42')
  await page.getByRole('button', { name: 'Add' }).click()
  await toast(page, 'Tag saved')
  await expect(page.getByText('cc-42', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit encryption' }).click()
  await page.getByRole('radio', { name: /aws:kms/ }).check()
  await page.getByLabel('KMS key').fill('catalog-key')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await toast(page, 'Encryption updated')
  await expect(page.getByText('catalog-key')).toBeVisible()
  await shot(page, '16-warehouse-settings')

  await page.goto(`${MARKETING}/t/e2e_events?tab=maintenance`)
  await page.getByRole('button', { name: 'Edit Compaction' }).click()
  await page.getByLabel('Target file size').fill('256')
  await page.getByRole('button', { name: 'Save' }).click()
  await toast(page, 'Compaction updated')
  await expect(page.getByText('256 MB')).toBeVisible()

  await page.goto('/c/local/wh/analytics/ns/marketing')
  await page.locator('tbody tr td:first-child span.font-mono').first().waitFor()
  const first = (await page.locator('tbody tr td:first-child span.font-mono').first().innerText()).trim()
  await page.goto(`${MARKETING}/t/${first}`)
  const version = await page.getByText(/^Iceberg v\d$/).innerText()
  if (version === 'Iceberg v2') {
    await page.getByRole('button', { name: 'Table actions' }).click()
    await page.getByRole('menuitem', { name: /Upgrade to Iceberg v3/ }).click()
    await page.getByRole('button', { name: 'Upgrade to v3' }).click()
    await expect(page.getByText('Iceberg v3')).toBeVisible()
  }
  check()
})

test('create a view, publish a new version, register a table', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(`${MARKETING}?tab=views`)
  await page.getByRole('button', { name: 'New view' }).click()
  const d = page.getByRole('dialog', { name: 'Create view' })
  await d.getByLabel('Name', { exact: true }).fill('e2e_view')
  await d.getByLabel('SQL (spark)').fill('SELECT id AS col_1 FROM e2e_events')
  await d.getByRole('button', { name: 'Create view' }).click()
  await expect(page).toHaveURL(/\/v\/e2e_view$/)
  await expect(page.locator('pre')).toContainText('SELECT id AS col_1 FROM e2e_events')

  await page.getByRole('button', { name: 'Edit' }).click()
  const e = page.getByRole('dialog', { name: 'Edit view definition' })
  await e.getByLabel('SQL (spark)').fill('SELECT id AS col_1 FROM e2e_events WHERE id > 0')
  await e.getByRole('button', { name: 'Publish version 2' }).click()
  await toast(page, 'View updated')
  await page.getByRole('tab', { name: /^Versions/ }).click()
  await expect(page.getByText('Changes from v1 to v2')).toBeVisible()

  await page.goto(MARKETING)
  await page.getByRole('button', { name: 'Register table' }).click()
  const r = page.getByRole('dialog', { name: 'Register existing table' })
  await r.getByLabel('Name', { exact: true }).fill('restored_orders')
  await r.getByLabel('Metadata location').fill('s3://analytics/.aistor-tables/marketing/old/metadata/v9.metadata.json')
  await r.getByRole('button', { name: 'Register' }).click()
  await expect(page).toHaveURL(/\/t\/restored_orders$/)
  check()
})
