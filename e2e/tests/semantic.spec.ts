import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { login, shot, watchConsole } from './helpers'

const NS = '/c/local/wh/analytics/ns/semantic_e2e'
const MODEL = `${NS}/m/retail`
const API = '/api/c/local/wh/analytics'

test.describe.configure({ mode: 'serial' })

async function toast(page: Page, text: string | RegExp) {
  await expect(page.locator('[role=status], [role=alert]').filter({ hasText: text }).first()).toBeVisible()
}

/** Calls the BFF as the signed-in user (CSRF token from /auth/me). */
async function apiCall(page: Page, method: string, path: string, body?: unknown) {
  const me = await (await page.request.get('/auth/me')).json()
  const resp = await page.request.fetch(path, {
    method,
    data: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken, Origin: new URL(page.url()).origin },
  })
  return resp
}

const orders = {
  name: 'orders',
  schema: {
    type: 'struct',
    'identifier-field-ids': [1],
    fields: [
      { id: 1, name: 'order_id', type: 'long', required: true, doc: 'Order key' },
      { id: 2, name: 'customer_id', type: 'long', required: true },
      { id: 3, name: 'amount', type: 'decimal(12, 2)', required: false },
      { id: 4, name: 'ordered_at', type: 'timestamptz', required: false },
    ],
  },
}
const customers = {
  name: 'customers',
  schema: {
    type: 'struct',
    'identifier-field-ids': [1],
    fields: [
      { id: 1, name: 'customer_id', type: 'long', required: true },
      { id: 2, name: 'name', type: 'string', required: false },
      { id: 3, name: 'country', type: 'string', required: false },
    ],
  },
}

test('create a semantic model from tables and document it', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local')
  expect((await apiCall(page, 'POST', `${API}/namespaces`, { namespace: ['semantic_e2e'] })).status()).toBe(200)
  for (const t of [orders, customers]) expect((await apiCall(page, 'POST', `${API}/ns/semantic_e2e/tables`, t)).status()).toBe(200)

  await page.goto(`${NS}?tab=semantic`)
  await expect(page.getByText('No semantic models yet')).toBeVisible()
  await page.getByRole('button', { name: 'New model' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'New semantic model' })
  await dlg.getByLabel('Model name').fill('retail')
  await dlg.getByLabel('Description').fill('Orders and customers')
  await dlg.getByRole('checkbox', { name: 'Include orders' }).click()
  await dlg.getByRole('checkbox', { name: 'Include customers' }).click()
  await dlg.getByRole('button', { name: 'Create model' }).click()
  await expect(page).toHaveURL(/\/m\/retail/)
  await expect(page.getByRole('heading', { level: 1, name: 'retail' })).toBeVisible()

  // Generated from the tables: datasets, fields with types, the row key.
  await page.getByRole('tab', { name: /^Datasets/ }).click()
  await expect(page.getByRole('list', { name: 'Datasets' }).getByRole('button')).toHaveCount(2)
  await expect(page.getByLabel('Field name order_id')).toHaveValue('order_id')
  await expect(page.getByLabel('Datatype of ordered_at')).toHaveValue('DateTimeTz')
  await expect(page.getByRole('group', { name: 'Primary key of orders' }).getByRole('button', { pressed: true })).toHaveText('order_id')
  await shot(page, '30-semantic-datasets')

  // Document a field and give the dataset synonyms.
  await page.getByLabel('Description of amount').fill('Order total in account currency')
  await page.getByLabel('Synonyms for orders').fill('purchases')
  await page.getByLabel('Synonyms for orders').press('Enter')
  await page.getByRole('button', { name: 'Save model' }).click()
  await toast(page, /Saved retail/)
  await expect(page.getByRole('button', { name: 'Save model' })).toHaveCount(0)
  check()
})

test('relationships from suggestions, metrics with autocomplete, YAML and history', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(`${MODEL}?tab=relationships`)
  await expect(page.getByText('Suggested joins')).toBeVisible()
  const suggestion = page.locator('li').filter({ hasText: 'orders.customer_id → customers.customer_id' })
  await suggestion.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('img', { name: 'Relationship diagram' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'orders_customers', exact: true })).toBeVisible()
  await shot(page, '31-semantic-relationships')

  await page.getByRole('tab', { name: /^Metrics/ }).click()
  await page.getByRole('button', { name: 'Add metric' }).click()
  const expr = page.getByRole('combobox', { name: /^Expression of new_metric/ })
  await expr.fill('SUM(ord')
  await expect(page.getByRole('option', { name: /orders/ })).toBeVisible()
  await expr.press('Enter')
  await expr.pressSequentially('.am')
  await page.getByRole('option', { name: /amount/ }).click()
  await expr.pressSequentially(')')
  await expect(expr).toHaveValue('SUM(orders.amount)')
  // A wrong reference is flagged live.
  await expr.fill('SUM(orders.amt)')
  await expect(page.getByText('orders has no field amt').first()).toBeVisible()
  await expr.fill('SUM(orders.amount)')
  await page.getByLabel('Name', { exact: true }).fill('revenue')
  await page.getByLabel('Name', { exact: true }).blur()
  await page.getByLabel('Datatype').selectOption('Decimal')
  await shot(page, '32-semantic-metric')

  await page.getByRole('tab', { name: /^YAML/ }).click()
  await expect(page.getByLabel('Changes since the saved version')).toContainText('SUM(orders.amount)')
  await page.getByRole('button', { name: 'Save model' }).click()
  await toast(page, /Saved retail/)
  await page.getByRole('button', { name: 'YAML', exact: true }).click()
  const yaml = page.getByLabel('Model YAML')
  await expect(yaml).toContainText('version: 0.2.0.dev0')
  await expect(yaml).toContainText('name: revenue')
  await expect(yaml).toContainText('vendor_name: AISTOR_CATALOG')

  await page.getByRole('tab', { name: /^History/ }).click()
  const versions = page.getByRole('list', { name: 'Model versions' }).getByRole('button')
  await expect(versions).toHaveCount(3)
  await expect(versions.first()).toContainText('alice')
  await expect(page.getByLabel('Version changes')).toContainText('revenue')
  await shot(page, '33-semantic-history')
  check()
})

test('concurrent edits conflict instead of overwriting; read-only users cannot save', async ({ page, browser }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(`${MODEL}?tab=overview`)
  await page.getByLabel('Description', { exact: true }).fill('Edited in browser one')

  const other = await browser.newContext()
  const p2 = await other.newPage()
  await login(p2, 'alice', 'alice-password')
  await p2.goto(`${MODEL}?tab=overview`)
  await p2.getByLabel('Description', { exact: true }).fill('Edited in browser two')
  await p2.getByRole('button', { name: 'Save model' }).click()
  await toast(p2, /Saved retail/)
  await other.close()

  await page.getByRole('button', { name: 'Save model' }).click()
  await expect(page.getByText('Someone else saved this model since you opened it')).toBeVisible()
  await page.getByRole('button', { name: 'Discard mine and reload' }).click()
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Edited in browser two')

  const ro = await browser.newContext()
  const bob = await ro.newPage()
  const bobCheck = watchConsole(bob)
  await login(bob, 'bob', 'bob-password')
  await bob.goto(`${MODEL}?tab=overview`)
  await bob.getByLabel('Description', { exact: true }).fill('bob was here')
  await bob.getByRole('button', { name: 'Save model' }).click()
  await expect(bob.getByText(/AIStor denied s3:PutObject/).first()).toBeVisible()
  bobCheck()
  await ro.close()
  check()
})

test('table Semantics tab, schema evolution warning and catalog sync', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto(`${NS}/t/orders?tab=semantics`)
  await expect(page.getByRole('link', { name: 'retail' })).toBeVisible()
  await expect(page.getByLabel('Description of amount')).toHaveValue('Order total in account currency')

  // Rename amount → total: the dialog says which model uses it.
  await page.getByRole('tab', { name: /^Schema/ }).click()
  await page.getByRole('button', { name: 'Evolve schema' }).click()
  const evolve = page.getByRole('dialog', { name: 'Evolve schema' })
  await evolve.getByRole('textbox', { name: 'Column name' }).nth(2).fill('total')
  await expect(evolve.getByText('Renaming amount affects retail: orders.amount')).toBeVisible()
  await evolve.getByRole('button', { name: 'Apply schema change' }).click()
  await toast(page, /Rename amount/)

  await page.goto(`${MODEL}?tab=sync`)
  await expect(page.getByText('Column amount was renamed to total.')).toBeVisible()
  await shot(page, '34-semantic-sync')
  await page.getByRole('button', { name: /Apply 1 fix/ }).click()
  await expect(page.getByLabel('Changes since the saved version')).toContainText('expression: total')
  await page.getByRole('button', { name: 'Save model' }).click()
  await toast(page, /Saved retail/)
  await page.getByRole('tab', { name: /^Catalog sync/ }).click()
  await expect(page.getByText('In sync')).toBeVisible()
  check()
})

test('semantic search, import, download and accessibility', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local')
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('purchases')
  const hit = palette.locator('[cmdk-group]').filter({ hasText: 'Semantic models' }).getByRole('option').first()
  await expect(hit).toContainText('orders')
  await hit.click()
  await expect(page).toHaveURL(/\/m\/retail\?tab=datasets/)

  // Import the model's own YAML under another name.
  const yaml = await (await page.request.get(`/api/c/local/semantic/wh/analytics/ns/semantic_e2e/models/retail?format=yaml`)).text()
  await page.goto(`${NS}?tab=semantic`)
  await page.getByRole('button', { name: 'Import YAML' }).click()
  const dlg = page.getByRole('dialog', { name: 'Import an Ossie model' })
  await dlg.getByLabel('Model name').fill('copy')
  await dlg.getByLabel('Document').fill(yaml)
  await dlg.getByRole('button', { name: 'Import' }).click()
  await expect(page).toHaveURL(/\/m\/copy/)
  await page.goto(`${NS}?tab=semantic`)
  await expect(page.getByRole('link', { name: 'copy' })).toBeVisible()
  // Invalid documents are rejected with located problems.
  await page.getByRole('button', { name: 'Import YAML' }).click()
  await dlg.getByLabel('Model name').fill('broken')
  await dlg.getByLabel('Document').fill('version: "0.2.0.dev0"\nname: broken\n')
  await dlg.getByRole('button', { name: 'Import' }).click()
  await expect(dlg.getByText(/datasets/).first()).toBeVisible()
  await page.keyboard.press('Escape')

  const download = page.waitForEvent('download')
  await page.goto(`${MODEL}?tab=overview`)
  await page.getByRole('link', { name: 'YAML' }).click()
  expect((await download).suggestedFilename()).toBe('retail.ossie.yaml')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const tab of ['Overview', 'Datasets', 'Relationships', 'Metrics', 'YAML', 'History', 'Catalog sync']) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
    await page.waitForLoadState('networkidle')
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    const report = r.violations.map((v) => `${tab}: ${v.id} — ${v.help}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
    expect(report, report.join('\n')).toEqual([])
  }
  check()
})
