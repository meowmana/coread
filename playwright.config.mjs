import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:43183',
    channel: process.env.COREAD_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true },
  webServer: { command: 'node scripts/e2e-server.mjs', url: 'http://127.0.0.1:43183', reuseExistingServer: false, timeout: 15000 },
});
