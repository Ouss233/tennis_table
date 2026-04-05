import { defineConfig } from '@playwright/test';

const LOCAL_BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const STAGING_BASE_URL = process.env.STAGING_BASE_URL || 'https://tennis-table-ten.vercel.app/jeux_ping_pong.html';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'local',
      grepInvert: /@staging/,
      use: {
        baseURL: LOCAL_BASE_URL
      }
    },
    {
      name: 'staging',
      grep: /@staging/,
      use: {
        baseURL: STAGING_BASE_URL
      }
    }
  ],
  webServer: [
    {
      command: 'node static-server.mjs',
      port: 3000,
      reuseExistingServer: true,
      timeout: 30_000
    },
    {
      command: 'ALLOW_TEST_COMMANDS=1 npm start',
      port: 8080,
      reuseExistingServer: true,
      timeout: 30_000
    }
  ]
});
