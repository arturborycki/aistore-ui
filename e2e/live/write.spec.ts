/**
 * Write tests against a real AIStor, driven through the UI. They only touch
 * objects they create: tables/views named `uitest_<run>_*` in LIVE_NS
 * (default edw1.scratch) and a semantic model with the same prefix. Data is
 * appended with PyIceberg (live/append.py, guarded to uitest_* tables) so
 * snapshot features have history to work on. Everything is dropped (with
 * purge) at the end.
 *
 *   LIVE_ACCESS_KEY=… LIVE_SECRET_KEY=… LIVE_PYTHON=/path/to/venv/bin/python \
 *   npx playwright test -c live/playwright.config.ts write.spec.ts
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const C = process.env.LIVE_CLUSTER ?? 'lab'
const WH = process.env.LIVE_WAREHOUSE ?? 'edw1'
const NS = process.env.LIVE_NS ?? 'scratch'
const RUN = process.env.LIVE_RUN ?? String(Math.floor(Date.now() / 1000))
const P = `uitest_${RUN}`
const T1 = `${P}_orders`
const T1R = `${P}_orders_v2`
const T2 = `${P}_customers`
const REG = `${P}_restored`
const T3 = `${P}_dropped`
const VIEW = `${P}_view`
const MODEL = `${P}_model`
const NSURL = `/c/${C}/wh/${WH}/ns/${NS}`
const SHOTS = process.env.E2E_SCREENSHOTS
const KEY = process.env.LIVE_ACCESS_KEY!
const SECRET = process.env.LIVE_SECRET_KEY!

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

async function login(page: Page) {
  await page.goto('/login')
  const tab = page.getByRole('tab', { name: 'Access key' })
  if (await tab.count()) await tab.click()
  await page.getByLabel('Access key').fill(KEY)
  await page.getByLabel('Secret key').fill(SECRET)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible({ timeout: 30_000 })
}

async function toast(page: Page, text: string | RegExp) {
  await expect(page.locator('[role=status], [role=alert]').filter({ hasText: text }).first()).toBeVisible({ timeout: 30_000 })
}

/**
 * Waits for the success message, answering the step-up prompt if it comes
 * first (it is skipped while a recent confirmation is still valid).
 */
async function doneOrStepUp(page: Page, text: string | RegExp) {
  const d = page.getByRole('dialog', { name: "Confirm it's you" })
  const ok = page.locator('[role=status], [role=alert]').filter({ hasText: text }).first()
  await expect(d.or(ok)).toBeVisible({ timeout: 30_000 })
  if (await d.isVisible()) {
    await d.getByLabel(/Secret key for|Password for/).fill(SECRET)
    await d.getByRole('button', { name: 'Confirm' }).click()
  }
  await expect(ok).toBeVisible({ timeout: 30_000 })
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/write-${name}.png`, fullPage: true })
}

function append(table: string, rows: number) {
  const py = process.env.LIVE_PYTHON ?? 'python3'
  return execFileSync(py, [fileURLToPath(new URL("./append.py", import.meta.url)), table, String(rows)], {
    env: { ...process.env, AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', LIVE_WAREHOUSE: WH },
    encoding: 'utf8',
  }).trim()
}

test(`create ${T1} (partitioned, sorted) and ${T2} through the UI`, async ({ page }) => {
  await login(page)
  for (const [name, partitioned] of [
    [T1, true],
    [T2, false],
  ] as const) {
    await page.goto(`${NSURL}/new-table`)
    await expect(page.getByRole('heading', { name: 'Create table' })).toBeVisible()
    await page.getByLabel('Table name').fill(name)
    if (partitioned) {
      await page.getByRole('button', { name: 'Add partition field' }).click()
      await page.getByLabel('Source column').selectOption({ label: 'created_at (timestamptz)' })
      await page.getByLabel('Transform').selectOption('day')
      await page.getByRole('button', { name: 'Add sort field' }).click()
      await page.getByLabel('Direction').selectOption('desc')
    }
    await page.getByRole('button', { name: 'Create table' }).click()
    await expect(page).toHaveURL(new RegExp(`/t/${name}$`), { timeout: 30_000 })
    await expect(page.getByText('Iceberg v2').first()).toBeVisible()
  }
  await page.getByRole('tab', { name: /^Partitioning/ }).click()
  await expect(page.getByText('Unpartitioned').first()).toBeVisible()
  await page.goto(`${NSURL}/t/${T1}?tab=partitions`)
  await expect(page.getByText('day(created_at)').first()).toBeVisible()
  await shot(page, '01-created')
})

test('append data with PyIceberg, then preview and statistics show it', async ({ page }) => {
  for (const n of [5, 7, 11]) console.log(append(T1, n))
  await login(page)
  await page.goto(`${NSURL}/t/${T1}?tab=preview`)
  await expect(page.getByRole('cell', { name: 'payload-0' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: /^Snapshots/ }).click()
  await expect(page.getByRole('list', { name: 'Snapshot history' }).locator(':scope > li')).toHaveCount(3)
  await shot(page, '02-snapshots')
})

test('time travel, tag, rollback and expire on the new table', async ({ page }) => {
  await login(page)
  await page.goto(`${NSURL}/t/${T1}?tab=snapshots`)
  const history = page.getByRole('list', { name: 'Snapshot history' }).locator(':scope > li')
  await expect(history).toHaveCount(3)

  // View the oldest snapshot.
  await history.nth(2).locator('button').first().click()
  await page.getByRole('button', { name: 'View table as of here' }).click()
  const banner = page.getByRole('status').filter({ hasText: /^Viewing snapshot/ })
  await expect(banner).toBeVisible()
  await shot(page, '03-time-travel')
  await banner.getByRole('button', { name: 'Back to current' }).click()

  // Tag the oldest snapshot, then remove the tag.
  await page.getByRole('tab', { name: /^Snapshots/ }).click()
  await history.nth(2).locator('button').first().click()
  await page.getByRole('button', { name: 'Branch or tag here' }).click()
  const rd = page.getByRole('dialog', { name: 'Create branch or tag' })
  await rd.getByLabel('Name', { exact: true }).fill('uitest-tag')
  await rd.getByRole('button', { name: 'Create tag' }).click()
  await toast(page, /Create tag uitest-tag/)
  await page.getByRole('button', { name: 'Actions for uitest-tag' }).click()
  await page.getByRole('menuitem', { name: /Remove tag/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove tag' }).click()
  await toast(page, /Remove tag uitest-tag/)

  // Roll main back to the middle snapshot; the newest becomes unreferenced.
  await history.nth(1).locator('button').first().click()
  await page.getByRole('button', { name: 'Roll back main to here' }).click()
  await page.getByRole('dialog', { name: 'Roll back table' }).getByRole('button', { name: 'Roll back main' }).click()
  await toast(page, /Roll back main/)
  await expect(history.nth(1).getByText('main', { exact: true })).toBeVisible()

  // Expire the newest (now unreferenced) snapshot.
  await page.getByRole('button', { name: 'Expire snapshots…' }).click()
  await history.nth(0).getByRole('checkbox').click()
  await page.getByRole('button', { name: /^Expire 1$/ }).click()
  await page.getByRole('dialog', { name: 'Expire 1 snapshot' }).getByRole('button', { name: 'Expire snapshots' }).click()
  await toast(page, /Expire 1 snapshot/)
  await expect(history).toHaveCount(2)
  await shot(page, '04-after-expire')
})

test('evolve schema (add, rename, row key), partitioning and sort order', async ({ page }) => {
  await login(page)
  await page.goto(`${NSURL}/t/${T1}?tab=schema`)
  await page.getByRole('button', { name: 'Evolve schema' }).click()
  const d = page.getByRole('dialog', { name: 'Evolve schema' })
  await d.getByLabel('Column name').nth(2).fill('body') // payload → body
  await d.getByRole('button', { name: 'Add column', exact: true }).click()
  await d.getByLabel('Column name').last().fill('note')
  const rowKey = d.getByRole('group', { name: /Row key/ })
  if (await rowKey.getByRole('button', { name: 'id', pressed: false }).count()) await rowKey.getByRole('button', { name: 'id' }).click()
  await expect(d.getByText('Rename payload → body')).toBeVisible()
  await d.getByRole('button', { name: 'Apply schema change' }).click()
  await toast(page, 'Committed')
  await expect(page.getByText(/Changes from schema 0 → 1/)).toBeVisible()

  await page.getByRole('tab', { name: /^Partitioning/ }).click()
  await page.getByRole('button', { name: 'Evolve' }).click()
  const pd = page.getByRole('dialog', { name: 'Evolve partitioning' })
  await pd.getByRole('button', { name: 'Add partition field' }).click()
  await pd.getByLabel('Source column').last().selectOption({ label: 'id (long)' })
  await pd.getByLabel('Transform').last().selectOption('bucket')
  await pd.getByRole('button', { name: 'Apply new spec' }).click()
  await toast(page, 'Committed')
  await expect(page.locator('td', { hasText: 'bucket(16, id)' })).toBeVisible()

  await page.getByRole('button', { name: 'Change' }).click()
  const sd = page.getByRole('dialog', { name: 'Change sort order' })
  await sd.getByRole('button', { name: 'Remove sort field' }).click()
  await sd.getByRole('button', { name: 'Apply sort order' }).click()
  await toast(page, 'Committed')

  // Data written before and after the change still reads (column renamed by id).
  console.log(append(T1, 3))
  await page.goto(`${NSURL}/t/${T1}?tab=preview`)
  await expect(page.getByRole('columnheader', { name: /body/ })).toBeVisible({ timeout: 30_000 })
  await shot(page, '05-evolved-preview')
})

test('properties, table tags, maintenance and format upgrade', async ({ page }) => {
  await login(page)
  await page.goto(`${NSURL}/t/${T1}?tab=properties`)
  await page.getByRole('button', { name: 'Add property' }).click()
  await page.getByLabel('Property key').last().fill('uitest.owner')
  await page.getByLabel(/Value for uitest.owner/).fill('catalog-ui')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Committed').first()).toBeVisible()

  await page.getByRole('tab', { name: /Encryption & tags/ }).click()
  await page.getByLabel('Tag key').fill('uitest')
  await page.getByLabel('Tag value').fill('yes')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await toast(page, 'Tag saved')
  await expect(page.getByText('yes', { exact: true })).toBeVisible()

  await page.getByRole('tab', { name: /^Maintenance/ }).click()
  await page.getByRole('button', { name: 'Edit Compaction' }).click()
  // AIStor gives new tables a disabled compaction config; enable it to edit settings.
  const sw = page.getByRole('switch', { name: 'Disabled' })
  if (await sw.count()) await sw.click()
  await page.getByLabel('Target file size').fill('256')
  await page.getByRole('button', { name: 'Save' }).click()
  await toast(page, 'Compaction updated')
  await expect(page.getByText('256 MB')).toBeVisible()
  await shot(page, '06-maintenance')

  await page.getByRole('button', { name: 'Table actions' }).click()
  await page.getByRole('menuitem', { name: /Upgrade to Iceberg v3/ }).click()
  await page.getByRole('button', { name: 'Upgrade to v3' }).click()
  await expect(page.getByText('Iceberg v3').first()).toBeVisible({ timeout: 30_000 })
})

test('multi-table change set, rename, register and a view', async ({ page }) => {
  await login(page)
  for (const t of [T1, T2]) {
    await page.goto(`${NSURL}/t/${t}?tab=properties`)
    await page.getByRole('button', { name: 'Add property' }).click()
    await page.getByLabel('Property key').last().fill('uitest.release')
    await page.getByLabel(/Value for uitest.release/).fill('r1')
    await page.getByRole('button', { name: 'Add to change set' }).click()
  }
  const tray = page.getByRole('region', { name: 'Change set' })
  await expect(tray).toContainText('2 tables')
  await tray.getByRole('button', { name: 'Apply atomically' }).click()
  await toast(page, 'Change set applied')

  await page.goto(`${NSURL}/t/${T1}`)
  await page.getByRole('button', { name: 'Table actions' }).click()
  await page.getByRole('menuitem', { name: /Rename/ }).click()
  await page.getByLabel('Name', { exact: true }).fill(T1R)
  await page.getByRole('button', { name: 'Rename' }).click()
  await expect(page).toHaveURL(new RegExp(`/t/${T1R}$`))

  // Restore a dropped table: create T3 with data, drop it keeping its files,
  // then register its metadata file again under a new name.
  await page.goto(`${NSURL}/new-table`)
  await page.getByLabel('Table name').fill(T3)
  await page.getByRole('button', { name: 'Create table' }).click()
  await expect(page).toHaveURL(new RegExp(`/t/${T3}$`), { timeout: 30_000 })
  console.log(append(T3, 4))
  const md = await (await page.request.get(`/api/c/${C}/wh/${WH}/ns/${NS}/t/${T3}`)).json()
  await page.reload()
  await page.getByRole('button', { name: 'Table actions' }).click()
  await page.getByRole('menuitem', { name: /Drop table/ }).click()
  await expect(page.getByRole('radio', { name: /Keep data files/ })).toBeChecked()
  await page.getByLabel(/Type/).fill(T3)
  await page.getByRole('button', { name: 'Drop table' }).click()
  await toast(page, 'Table dropped')
  await page.goto(NSURL)
  await page.getByRole('button', { name: 'Register table' }).click()
  const r = page.getByRole('dialog', { name: 'Register existing table' })
  await r.getByLabel('Name', { exact: true }).fill(REG)
  await r.getByLabel('Metadata location').fill(md['metadata-location'])
  await r.getByRole('button', { name: 'Register' }).click()
  await expect(page).toHaveURL(new RegExp(`/t/${REG}$`), { timeout: 30_000 })
  await page.getByRole('tab', { name: /^Preview/ }).click()
  await expect(page.getByRole('cell', { name: 'payload-0' })).toBeVisible({ timeout: 30_000 })

  await page.goto(`${NSURL}?tab=views`)
  await page.getByRole('button', { name: 'New view' }).click()
  const vd = page.getByRole('dialog', { name: 'Create view' })
  await vd.getByLabel('Name', { exact: true }).fill(VIEW)
  await vd.getByLabel('SQL (spark)').fill(`SELECT id, body FROM ${NS}.${T1R}`)
  await vd.getByRole('button', { name: 'Create view' }).click()
  await expect(page).toHaveURL(new RegExp(`/v/${VIEW}$`), { timeout: 30_000 })
  await page.getByRole('button', { name: 'Edit' }).click()
  const ev = page.getByRole('dialog', { name: 'Edit view definition' })
  await ev.getByLabel('SQL (spark)').fill(`SELECT id, body FROM ${NS}.${T1R} WHERE id > 1`)
  await ev.getByRole('button', { name: 'Publish version 2' }).click()
  await toast(page, 'View updated')
  await shot(page, '07-view')
})

test('semantic model on the new tables', async ({ page }) => {
  await login(page)
  await page.goto(`${NSURL}?tab=semantic`)
  await page.getByRole('button', { name: 'New model' }).first().click()
  const d = page.getByRole('dialog', { name: 'New semantic model' })
  await d.getByLabel('Model name').fill(MODEL)
  await d.getByRole('checkbox', { name: `Include ${T1R}` }).click()
  await d.getByRole('checkbox', { name: `Include ${T2}` }).click()
  await d.getByRole('button', { name: 'Create model' }).click()
  await expect(page).toHaveURL(new RegExp(`/m/${MODEL}`), { timeout: 30_000 })
  await page.getByRole('tab', { name: /^Metrics/ }).click()
  await page.getByRole('button', { name: 'Add metric' }).click()
  await page.getByRole('combobox', { name: /^Expression of new_metric/ }).fill(`COUNT(${T1R}.id)`)
  await page.getByRole('button', { name: 'Save model' }).click()
  await toast(page, new RegExp(`Saved ${MODEL}`))
  await page.getByRole('tab', { name: /^Catalog sync/ }).click()
  await expect(page.getByText('In sync')).toBeVisible({ timeout: 30_000 })
  await shot(page, '08-semantic')
  await page.getByRole('button', { name: 'Model actions' }).click()
  await page.getByRole('menuitem', { name: /Delete model/ }).click()
  await page.getByLabel(/Type/).fill(MODEL)
  await page.getByRole('button', { name: 'Delete model' }).click()
  await doneOrStepUp(page, new RegExp(`Deleted model ${MODEL}`))
})

test('clean up: drop the view and the tables with purge', async ({ page }) => {
  await login(page)
  await page.goto(`${NSURL}/v/${VIEW}`)
  await page.getByRole('button', { name: /View actions/ }).click()
  await page.getByRole('menuitem', { name: /Drop view/ }).click()
  await page.getByLabel(/Type/).fill(VIEW)
  await page.getByRole('button', { name: 'Drop view' }).click()
  await doneOrStepUp(page, /dropped/i)
  for (const t of [T1R, T2, REG]) {
    await page.goto(`${NSURL}/t/${t}`)
    await page.getByRole('button', { name: 'Table actions' }).click()
    await page.getByRole('menuitem', { name: /Drop table/ }).click()
    await page.getByRole('radio', { name: /Purge data files/ }).check()
    await page.getByLabel(/Type/).fill(t)
    await page.getByRole('button', { name: 'Drop and delete data' }).click()
    await doneOrStepUp(page, 'Table dropped')
  }
  const left = (await (await page.request.get(`/api/c/${C}/wh/${WH}/ns/${NS}/tables?pageSize=1000`)).json()).identifiers.filter((i: { name: string }) => i.name.startsWith(P))
  expect(left).toEqual([])
})
