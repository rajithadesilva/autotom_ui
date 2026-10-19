import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  webServer: process.env.LOCAL_TEST_SERVER ? { command: 'npm run dev -- --port 4173', url: 'http://127.0.0.1:4173', reuseExistingServer: false } : undefined,
  timeout: 30000,
  fullyParallel: true,
  workers: 4,
  use: {
    baseURL: process.env.BASE_URL || 'http://web',
    viewport: { width: 1440, height: 1050 },
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
