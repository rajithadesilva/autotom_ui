import { test, expect } from '@playwright/test';
import type { Run } from '../src/types';

test('scene objects match real saved run snapshots after switching and reload', async ({ page, request }) => {
  test.skip(process.env.LIVE !== '1', 'Enable LIVE=1 for read-only checks against the running application');
  const response = await request.get('/api/runs');
  expect(response.ok()).toBeTruthy();
  const runs = (await response.json() as Run[]).filter(run => run.status === 'completed').slice(0, 4);
  test.skip(runs.length < 2, 'Two completed runs are needed to check snapshot switching');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Mature plant exports can exceed 500 MB; this check only needs real snapshot data.
  await page.route('**/artifacts/**', route => route.abort());
  await page.goto('/');
  const objects = page.getByLabel('Scene item selection', {exact:true});
  const count = page.locator('.sidebar-title').filter({has:page.getByRole('heading', {name:'Scene objects',exact:true})}).locator('span');
  async function checkSnapshot(run: Run, editing = false) {
    const names = [...run.config.objects, ...run.config.planting.plants].map(item => item.name).sort();
    const tab = page.getByRole('button', {name:editing ? 'Scene editor' : 'Simulation',exact:true});
    await expect(tab).toHaveClass('active');
    await expect(count).toHaveText(String(names.length));
    await expect.poll(async () => (await objects.locator('.item-name').allTextContents()).sort()).toEqual(names);
    const led = run.config.objects.find(item => item.kind === 'led');
    if (led) {
      await objects.getByRole('button', {name:led.name,exact:true}).click();
      await expect(page.getByLabel('Object name', {exact:true})).toHaveValue(led.name);
      await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue(String(led.power_w));
      await expect(page.getByLabel('Emitted power', {exact:true})).toBeEnabled({enabled:editing});
      await expect(tab).toHaveClass('active');
    }
  }
  for (const run of runs) {
    const eventResponse = page.waitForResponse(r => r.url().endsWith(`/api/runs/${run.id}/events`));
    await page.locator('.run-row').filter({hasText:run.name}).click();
    await eventResponse;
    await checkSnapshot(run, true);
    await page.getByRole('button', {name:'Simulation',exact:true}).click();
    await checkSnapshot(run);
    await page.getByRole('button', {name:'Scene editor',exact:true}).click();
    await checkSnapshot(run, true);
  }
  await page.reload();
  await checkSnapshot(runs.at(-1)!);
  await page.getByRole('button', {name:'Scene editor',exact:true}).click();
  await checkSnapshot(runs.at(-1)!, true);
  await page.getByRole('button', {name:'Simulation',exact:true}).click();
  await page.locator('.run-row').filter({hasText:runs[0].name}).click();
  await checkSnapshot(runs[0]);
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await page.locator('.run-row').filter({hasText:runs[1].name}).click();
  await expect(page.getByRole('button', {name:'Compare',exact:true})).toHaveClass('active');
  expect(errors).toEqual([]);
});

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
  await page.getByRole('button', {name:'Simulation',exact:true}).click();
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
    await expect(page.getByRole('button', { name: 'Simulation', exact: true })).toHaveClass('active');
    await expect(page.locator('.run-progress')).toBeVisible();
    expect(errors).toEqual([]);
  }
});
