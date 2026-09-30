/**
 * Read-only smoke test against a real AIStor, driven through the UI.
 * Never creates, edits or deletes anything. Run with:
 *   E2E_BASE_URL=http://localhost:8080 LIVE_ACCESS_KEY=… LIVE_SECRET_KEY=… LIVE_CLUSTER=lab \
 *   npx playwright test -c live/playwright.config.ts
 * Findings (error states shown to the user, console errors) are written to test-results/live-findings.json.
 */
import { expect, test, type Page } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'

const C = process.env.LIVE_CLUSTER ?? 'lab'
const SHOTS = process.env.E2E_SCREENSHOTS
const findings: { page: string; kind: string; text: string }[] = []

async function login(page: Page) {
  await page.goto('/login')
  const tab = page.getByRole('tab', { name: 'Access key' })
  if (await tab.count()) await tab.click()
  await page.getByLabel('Access key').fill(process.env.LIVE_ACCESS_KEY!)
  await page.getByLabel('Secret key').fill(process.env.LIVE_SECRET_KEY!)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible({ timeout: 30_000 })
}

async function visit(page: Page, name: string, url: string, ready?: () => Promise<unknown>) {
  await page.goto(url)
  if (ready) await ready()
  // Pages poll in the background, so "network idle" may never come: wait for loading skeletons to go.
  await page.locator('.animate-pulse').first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(800)
  await record(page, name)
}

async function record(page: Page, name: string) {
  // Error states rendered by the UI (ErrorState / InlineError use role=alert).
  for (const t of await page.locator('[role=alert]').allInnerTexts()) findings.push({ page: name, kind: 'ui-error', text: t.trim().slice(0, 300) })
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/live-${name.replace(/[^a-z0-9]+/gi, '_')}.png`, fullPage: true })
}

test.setTimeout(10 * 60_000)

test('walk the live catalog read-only', async ({ page }) => {
  page.on('console', (m) => m.type() === 'error' && findings.push({ page: page.url(), kind: 'console', text: m.text().slice(0, 300) }))
  page.on('pageerror', (e) => findings.push({ page: page.url(), kind: 'crash', text: e.message }))
  await login(page)
  await record(page, 'overview')
  await visit(page, 'warehouses', `/c/${C}/warehouses`, () => expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 }))

  const whs: string[] = (await (await page.request.get(`/api/c/${C}/warehouses`)).json()).warehouses
  for (const wh of whs) {
    await visit(page, `wh-${wh}`, `/c/${C}/wh/${wh}`)
    for (const tab of ['settings', 'access']) await visit(page, `wh-${wh}-${tab}`, `/c/${C}/wh/${wh}?tab=${tab}`)
    const nss: string[][] = (await (await page.request.get(`/api/c/${C}/wh/${wh}/namespaces?pageSize=1000`)).json()).namespaces ?? []
    for (const ns of nss.slice(0, 4)) {
      const nsp = encodeURIComponent(ns.join('\u001f'))
      await visit(page, `ns-${wh}-${ns.join('.')}`, `/c/${C}/wh/${wh}/ns/${nsp}`)
      const tables = ((await (await page.request.get(`/api/c/${C}/wh/${wh}/ns/${nsp}/tables?pageSize=50`)).json()).identifiers ?? []) as { name: string }[]
      for (const t of tables.slice(0, 2)) {
        const base = `/c/${C}/wh/${wh}/ns/${nsp}/t/${encodeURIComponent(t.name)}`
        for (const tab of ['overview', 'preview', 'schema', 'partitions', 'snapshots', 'maintenance', 'settings', 'metadata']) {
          await visit(page, `t-${wh}-${ns.join('.')}-${t.name}-${tab}`, `${base}?tab=${tab}`)
        }
      }
    }
  }
  // A table whose preview AIStor cannot serve (delete files), if present.
  await visit(page, 'preview-unsupported', `/c/${C}/wh/edw1/ns/test_ns/t/ev?tab=preview`)
  await visit(page, 'activity', `/c/${C}/activity`)
  await visit(page, 'sessions', `/c/${C}/sessions`)
  await page.keyboard.press('Control+k')
  await page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').fill('tpch')
  await page.waitForTimeout(4000)
  await record(page, 'palette-search')
})

test.afterAll(() => {
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/live-findings.json', JSON.stringify(findings, null, 2))
})
