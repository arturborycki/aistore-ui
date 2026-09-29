import { expect, type Page } from '@playwright/test'

/** Fails the test on CSP violations or uncaught errors. */
export function watchConsole(page: Page) {
  const problems: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|403|404|409)/.test(t)) problems.push(t)
  })
  page.on('pageerror', (e) => problems.push(e.message))
  return () => expect(problems, problems.join('\n')).toEqual([])
}

export async function login(page: Page, user: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
}

export async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png` })
}
