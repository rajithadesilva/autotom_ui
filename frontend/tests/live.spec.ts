import { test, expect } from '@playwright/test';

test('compare graphs real saved runs without modifying experiments', async ({ page, request }) => {
  test.skip(process.env.LIVE !== '1', 'Enable LIVE=1 for read-only checks against the running application');
  const response = await request.get('/api/runs');
  expect(response.ok()).toBeTruthy();
  const runs = await response.json() as { id: string; current_day: number }[];
  const pair = runs.filter(run => run.current_day > 0).slice(0, 2);
  test.skip(pair.length < 2, 'Two runs with daily results are needed');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await page.getByLabel('Compare run B', {exact:true}).selectOption(pair[1].id);
  await page.getByLabel('Compare run A', {exact:true}).selectOption(pair[0].id);
  await expect(page.locator('.comparison-chart')).toHaveCount(5);
  await expect(page.getByRole('article', {name:'Plant dry biomass comparison',exact:true}).locator('.recharts-line-curve')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({path:'test-results/compare-real-runs.png',fullPage:true});
  expect(errors).toEqual([]);
});

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

test('restoring an older saved run stays visible after live updates and reload', async ({ page, request }) => {
  test.skip(process.env.LIVE !== '1', 'Enable LIVE=1 for read-only checks against the running application');
  const response = await request.get('/api/runs');
  expect(response.ok()).toBeTruthy();
  const runs = await response.json() as { id: string; status: string }[];
  const run = runs.find(r => ['completed', 'failed', 'cancelled'].includes(r.status));
  expect(run).toBeTruthy();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => localStorage.setItem('autotom-selected-run', id), run!.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    const eventResponse = page.waitForResponse(r => r.url().endsWith(`/api/runs/${run!.id}/events`));
    if (attempt === 0) await page.goto('/');
    else await page.reload();
    const event = await eventResponse;
    expect(event.ok()).toBeTruthy();
    await event.finished();
    await expect(page.getByRole('heading', { name: 'Simulation workspace', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Simulation result', exact: true })).toHaveClass('active');
    await expect(page.locator('.run-progress')).toBeVisible();
    expect(errors).toEqual([]);
  }
});
