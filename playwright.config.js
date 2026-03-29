import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry'
  },
  webServer: [
    {
      command: 'node static-server.mjs',
      port: 3000,
      reuseExistingServer: true,
      timeout: 30_000
    },
    {
      command: 'npm start',
      port: 8080,
      reuseExistingServer: true,
      timeout: 30_000
    }
  ]
});
