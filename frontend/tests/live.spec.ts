import { test, expect } from '@playwright/test';

test('real saved 80-day GroIMP run loads geometry, materials, charts and survives reload', async ({ page }) => {
  test.skip(process.env.LIVE !== '1', 'Enable LIVE=1 to inspect real saved output without modifying the model');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const request = page.waitForResponse(response => response.url().includes('/days/0080/plants.obj') && response.status() === 200);
  await page.locator('.run-row').filter({ hasText: '80 days' }).click();
  await request;
  await expect(page.locator('.scene-message')).toHaveCount(0);
  await expect(page.locator('.viewport-label')).toContainText('DAY 80');
  await expect(page.locator('.chart-card')).toHaveCount(5);
  await expect(page.locator('.chart-value').nth(1)).not.toHaveText(/^0\s*g$/);
  await page.getByRole('button', { name: 'Close configuration' }).click();
  await page.getByRole('button', { name: 'Fit plants' }).click();
  await page.screenshot({ path: 'test-results/real-groimp-day-80.png', fullPage: true });
  await page.getByLabel('Simulation day', { exact: true }).focus();
  await page.getByLabel('Simulation day', { exact: true }).press('Home');
  await expect(page.locator('.timeline-day strong')).toHaveText('Day 1');
  await page.reload();
  await expect(page.locator('.timeline-day strong')).toHaveText('Day 80');
  await expect(page.locator('.scene-message')).toHaveCount(0);
  expect(errors).toEqual([]);
});
