import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { login, shot, watchConsole } from './helpers'

const CONTROL = process.env.E2E_TESTSERVER_CONTROL ?? 'http://127.0.0.1:9001'
const TABLE = '/c/local/wh/analytics/ns/sales%1Forders'

test.describe.configure({ mode: 'serial' })

/** Scans the page; violations are collected so one run reports every page. */
async function axe(page: Page, name: string, into?: string[]) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const report = r.violations.map(
    (v) => `${name}: [${v.impact}] ${v.id} — ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')}  ${n.failureSummary?.split('\n').slice(1, 2).join('') ?? ''}`).join('\n    ')}`,
  )
  if (into) into.push(...report)
  else expect(report, report.join('\n')).toEqual([])
}

test('accessibility: key pages pass axe (WCAG 2.1 AA) in light and dark themes', async ({ page }) => {
  const found: string[] = []
  // Scan settled pages, not fade-in animations.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await axe(page, 'login', found)
  await login(page, 'alice', 'alice-password')
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto('/c/local')
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await axe(page, `overview/${theme}`, found)
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const pages: [string, string, RegExp | string][] = [
    ['warehouses', '/c/local/warehouses', 'Warehouses'],
    ['namespace', TABLE, 'orders'],
    ['activity', '/c/local/activity', 'Activity'],
    ['sessions', '/c/local/sessions', 'Sessions'],
  ]
  for (const [name, url, heading] of pages) {
    await page.goto(url)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await axe(page, name, found)
  }
  await page.goto(TABLE)
  await page.locator('tbody tr').first().click()
  for (const tab of ['Overview', 'Schema', 'Snapshots', 'Partitioning']) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
    await page.waitForLoadState('networkidle')
    await axe(page, `table/${tab}`, found)
  }
  expect(found, found.join('\n')).toEqual([])
})

test('command palette searches the whole catalog on the server', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('ledger')
  const group = palette.locator('[cmdk-group]').filter({ hasText: 'Across the catalog' })
  await expect(group.getByRole('option').first()).toBeVisible()
  await shot(page, '21-palette-search')
  await group.getByRole('option', { name: /finance\.ledger/ }).first().click()
  await expect(page).toHaveURL(/\/wh\/analytics\/ns\//)
  check()
})

test('sessions: list devices and revoke another session', async ({ page, browser }) => {
  const check = watchConsole(page)
  const other = await browser.newContext()
  const otherPage = await other.newPage()
  await login(otherPage, 'alice', 'alice-password')
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local/sessions')
  const mine = page.getByRole('table').first()
  await expect(mine.getByText('This device')).toBeVisible()
  const revoke = mine.getByRole('button', { name: /^Sign out alice on .*[^)]$/ })
  expect(await revoke.count()).toBeGreaterThan(0)
  await shot(page, '22-sessions')
  await revoke.first().click()
  await page.getByRole('dialog', { name: 'Revoke session?' }).getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Signed out alice/ }).first()).toBeVisible()
  // Revoking every other session signs the second browser out.
  await page.getByRole('button', { name: 'Sign out other sessions' }).click()
  await otherPage.goto('/c/local/warehouses')
  await expect(otherPage).toHaveURL(/\/login/)
  await other.close()
  // Administrators also see everyone's sessions.
  await expect(page.getByRole('heading', { name: 'All users' })).toBeVisible()
  check()
})

test('activity: server-side filters, paging and CSV export', async ({ page }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local/activity')
  await expect(page.getByText(/^Showing \d+ of \d+/)).toBeVisible()
  await page.getByRole('group', { name: 'Source' }).getByRole('button', { name: 'Sign-in' }).click()
  await expect(page.getByText(/^Showing \d+ of \d+ matching records/)).toBeVisible()
  const rows = page.locator('tbody tr')
  await expect(rows.first()).toContainText('Sign-in')
  await page.getByLabel('Filter activity').fill('no-such-operation-xyz')
  await expect(page.getByText('Nothing matches the current filters.')).toBeVisible()
  await page.getByLabel('Filter activity').fill('')
  await page.getByLabel('Time range').selectOption('24h')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const file = await download
  const csv = await readFile((await file.path())!, 'utf8')
  expect(csv.split('\r\n')[0]).toBe('time,user,kind,operation,action,cluster,resource,arn,params,outcome,status,error,clientIp,durationMs,requestId')
  expect(csv).toContain(',alice,auth,')
  check()
})

test('expired AIStor credentials are renewed in place without losing the page', async ({ page, request }) => {
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  await page.goto('/c/local/warehouses')
  await expect(page.getByRole('heading', { level: 1, name: 'Warehouses' })).toBeVisible()
  expect((await request.post(`${CONTROL}/expire-credentials`)).status()).toBe(204)
  await page.getByLabel('Search warehouses').fill('analy')
  const dlg = page.getByRole('dialog', { name: 'Sign in again' })
  await expect(dlg).toBeVisible()
  await shot(page, '23-reauth')
  await dlg.getByLabel(/Password for alice/).fill('alice-password')
  await dlg.getByRole('button', { name: 'Continue' }).click()
  await expect(dlg).toHaveCount(0)
  await expect(page).toHaveURL(/\/warehouses/)
  await expect(page.locator('tbody').getByText('analytics', { exact: true })).toBeVisible()
  check()
})

test('mobile: the sidebar is an overlay that closes on navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const check = watchConsole(page)
  await login(page, 'alice', 'alice-password')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await expect(sidebar).toHaveCount(0)
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await expect(sidebar).toBeVisible()
  await shot(page, '24-mobile-sidebar')
  await sidebar.getByRole('link', { name: 'Warehouses' }).click()
  await expect(page).toHaveURL(/\/warehouses$/)
  await expect(sidebar).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Warehouses' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  // No horizontal scrolling on a phone-sized screen.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await axe(page, 'mobile/warehouses')
  check()
})
