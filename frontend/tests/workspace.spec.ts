import { test, expect, type Page } from '@playwright/test';
import type { Config, Run } from '../src/types';

const config: Config = {
  version: 1,
  room: { width: 1.2, length: 1.2, height: 0.735, enabled: true, wall_reflectance: null, floor_reflectance: null, ceiling_reflectance: null },
  simulation: { days: 3, rows: 1, plants_per_row: 1, density: 50, border_rows: 0, border_plants: 0, seed: 0, rays: 200000, photoperiod: 16,
    plant_input: 'plant.csv', temperature_input: 'temperature.csv', emission_input: 'distribution.csv', spectrum_input: 'spectrum.csv' },
  objects: [{ id: 'led-1', name: 'LED 1', kind: 'led', position: [0.6, 0.6, 0.725], rotation: [180, 0, 0], size: [0.1, 0.1, 0.1], power_w: 43.8, reflectance: 0.5, enabled: true }],
  spectrum: [{ wavelength: 400, amplitude: 0.01 }, { wavelength: 550, amplitude: 0.4 }, { wavelength: 700, amplitude: 0.1 }],
};

async function mockApi(page: Page, options: { installed?: boolean; status?: Run['status']; conflict?: boolean } = {}) {
  let saved = structuredClone(config), installed = options.installed ?? true, revision = 'r1';
  let run: Run = { id: 'test-run', name: 'Three day experiment', status: options.status || 'completed', created_at: '2026-10-19T10:00:00Z', started_at: null,
    finished_at: null, days: 3, current_day: 3, cancel_requested: false, error: null, revision, config: saved, available_days: [1, 2, 3] };
  let runs: Run[] = installed ? [run] : [];
  const project = () => ({ config: saved, revision, installed, inputs: { dynamic_input: ['plant.csv'], temperature: ['temperature.csv'], light_emission_pattern: ['distribution.csv'], light_spectrum: ['spectrum.csv'] } });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/health') return json({ status: 'ok', worker: { ready: true, gpu: 'Test NVIDIA' } });
    if (path === '/api/config' && method === 'GET') return json(project());
    if (path === '/api/setup') { installed = true; return json(project()); }
    if (path === '/api/config' && method === 'PUT') {
      if (options.conflict) return json({ detail: 'Model files changed outside this editor. Reload the configuration before saving or running.' }, 409);
      saved = route.request().postDataJSON().config; revision = 'r2'; return json(project());
    }
    if (path === '/api/runs' && method === 'GET') return json(runs);
    if (path === '/api/runs' && method === 'POST') {
      run = { ...run, id: 'new-run', name: route.request().postDataJSON().name, config: saved, status: 'running', current_day: 1, available_days: [1] };
      runs = [run, ...runs]; return json(run, 201);
    }
    if (path.endsWith('/cancel')) { run = { ...run, status: 'cancelled', cancel_requested: true }; return json(run); }
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(run)}\n\n` });
    if (path.endsWith('/metrics')) return json([1, 2, 3].map(day => ({ day, plants: [{ plant: 1, model_age_days: day, biomass_g: day * 0.1, fruit_g: 0, leaf_area_m2: day * 0.002, par_umol_s: 1, par_mmol_day: 57.6, carbon_mmol_day: 2 }] })));
    if (path.endsWith('/logs')) return json({ text: 'AUTOTOM_DAY 1\nAUTOTOM_COMPLETE' });
    if (path.endsWith('plants.obj')) return route.fulfill({ contentType: 'text/plain', body: 'v 0.5 0.5 0.065 0.2 0.6 0.1\nv 0.6 0.5 0.4 0.2 0.6 0.1\nv 0.7 0.5 0.065 0.2 0.6 0.1\nf 1 2 3\n' });
    if (path.startsWith('/api/runs/')) return json(run);
    return json({ detail: 'Unknown test route' }, 404);
  });
  return { getSaved: () => saved };
}

test('setup, pane navigation, object editing, and saving host configuration', async ({ page }) => {
  const state = await mockApi(page, { installed: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Install model adapter' }).click();
  await expect(page.getByText('Model adapter installed. Original files are backed up.')).toBeVisible();
  await page.locator('.object-row').first().click();
  await page.getByLabel('Emitted power', { exact: true }).fill('30');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Configuration saved to host model files.')).toBeVisible();
  expect(state.getSaved().objects[0].power_w).toBe(30);
  await page.getByRole('button', { name: 'Add LED' }).click();
  await expect(page.getByLabel('Object name')).toHaveValue('LED 2');
  await page.getByLabel('position X', { exact: true }).fill('0.8');
  await page.getByLabel('position X', { exact: true }).press('Tab');
  await page.getByLabel('Emitted power', { exact: true }).fill('25');
  await page.getByLabel('Emitted power', { exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Configuration saved to host model files.')).toBeVisible();
  expect(state.getSaved().objects[1].position[0]).toBe(0.8);
  expect(state.getSaved().objects[1].power_w).toBe(25);
  await page.getByRole('button', { name: 'Surroundings', exact: true }).click();
  await page.getByRole('button', { name: 'Reflector', exact: true }).click();
  await expect(page.getByLabel('Object name')).toHaveValue('Reflector 1');
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByLabel('Object name')).toHaveValue('Reflector 1 copy');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByLabel('Object name')).toHaveCount(0);
});

test('day slider, chart reporting, playback, downloads and logs', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.locator('.run-row').click();
  await expect(page.locator('.timeline-day strong')).toHaveText('Day 3');
  await expect(page.locator('.chart-card')).toHaveCount(5);
  await page.getByLabel('Simulation day', { exact: true }).focus();
  await page.getByLabel('Simulation day', { exact: true }).press('Home');
  await page.getByLabel('Simulation day', { exact: true }).press('ArrowRight');
  await expect(page.locator('.timeline-day strong')).toHaveText('Day 2');
  await expect(page.locator('.viewport-label')).toContainText('DAY 2');
  await page.getByLabel('Plant reporting').selectOption('1');
  await expect(page.locator('.chart-footnote').first()).toContainText('plant 1');
  await page.getByRole('button', { name: 'Play daily playback' }).click();
  await expect(page.getByRole('button', { name: 'Pause daily playback' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause daily playback' }).click();
  await expect(page.getByRole('link', { name: 'OBJ + MTL' })).toHaveAttribute('href', /scene.zip$/);
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Simulation log' })).toContainText('AUTOTOM_COMPLETE');
  await page.getByRole('button', { name: 'Close simulation log' }).click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace-desktop.png', fullPage: true });
});

test('external edit conflicts preserve the draft until explicit reload', async ({ page }) => {
  await mockApi(page, { conflict: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add LED' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('changed outside this editor');
  await expect(page.getByLabel('Object name')).toHaveValue('LED 2');
  await page.getByRole('button', { name: 'Reload host files' }).click();
  await expect(page.locator('.object-row')).toHaveCount(1);
});

test('run submission and cancellation retain published daily outputs', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await expect(page.locator('.run-progress')).toContainText('Simulating');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.run-progress')).toContainText('Cancelled');
  await expect(page.locator('.timeline-day strong')).toHaveText('Day 1');
});

test('mobile editor remains usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Surroundings', exact: true }).click();
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await expect(page.getByLabel('Object name')).toHaveValue('Obstacle 1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
});
