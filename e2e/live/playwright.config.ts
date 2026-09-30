import { defineConfig } from '@playwright/test'

// Live tests against a real AIStor through a running UI (read-only). Not part of `make e2e`.
export default defineConfig({
  testDir: '.',
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    actionTimeout: 15_000,
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
})
