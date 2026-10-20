import { test, expect, type Page } from '@playwright/test';
import * as THREE from 'three';
import type { Config, DailyResult, Run, SavedConfiguration } from '../src/types';

const config: Config = {
  version: 2,
  planting: {mode:'preset',pattern:'grid',plant_spacing:null,row_spacing:null,center:[.6,.6,0],rotation:0,next_reporting_id:2,
    plants:[{id:'plant-1',name:'Plant 1',role:'central',reporting_id:1,position:[.6,.6,0],rotation:[0,0,0],enabled:true,row:1,col:1}]},
  groups:[],parameter_overrides:{},temperature_overrides:{},
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
  let configurations: SavedConfiguration[] = [];
  let nextConfiguration = 1;
  const project = () => ({ config: saved, revision, installed, inputs: { dynamic_input: ['plant.csv'], temperature: ['temperature.csv'], light_emission_pattern: ['distribution.csv'], light_spectrum: ['spectrum.csv'] } });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/configurations' && method === 'GET') return json(configurations);
    if (path === '/api/configurations' && method === 'POST') {
      const record = { ...route.request().postDataJSON(), id: `configuration-${nextConfiguration++}`, created_at: new Date().toISOString() };
      configurations = [record, ...configurations]; return json(record, 201);
    }
    if (path.startsWith('/api/configurations/')) {
      const id = path.split('/').at(-1);
      if (method === 'DELETE') { configurations = configurations.filter(item => item.id !== id); return route.fulfill({status:204}); }
      return json(configurations.find(item => item.id === id));
    }
    if (path === '/api/inputs/preview') return json({revision,parameters:[
      {key:'base_temperature',label:'Base temperature',type:'number',group:'growth',unit:'°C',min:-100,max:100,value:5.7},
      {key:'proportion_petiolules_first_leaves',label:'First leaf proportions',type:'array',length:2,group:'architecture',unit:'',min:0,max:1,value:[.66,.34]},
      {key:'ray_depth',label:'Ray depth',type:'integer',group:'light',unit:'',min:1,max:100,value:10},
      {key:'phytomer_appearance_rate_main_stem_factor_1',label:'Phytomer coefficient',type:'number',group:'growth',unit:'',min:0,max:1e9,value:.0000241}],temperatures:[20,21,22]});
    if (path === '/api/layout/preview') {
      const body=route.request().postDataJSON();
      return json({...saved.planting,pattern:body.pattern,center:body.center,rotation:body.rotation,
        plants:Array.from({length:body.simulation.rows*body.simulation.plants_per_row},(_,i)=>({...saved.planting.plants[0],id:`generated-${i}`,reporting_id:i+1,name:`Plant ${i+1}`,position:[.4+i*.15,.6,0]})),next_reporting_id:body.simulation.rows*body.simulation.plants_per_row+1});
    }
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
    if (path.startsWith('/api/runs/') && method === 'DELETE') { runs = runs.filter(item => item.id !== path.split('/').at(-1)); return route.fulfill({status:204}); }
    if (path.startsWith('/api/runs/') && method === 'PATCH') {
      run = {...run, name: route.request().postDataJSON().name};
      runs = runs.map(item => item.id === run.id ? run : item); return json(run);
    }
    if (path.endsWith('inspection.json')) return json({detail:'Legacy run'},404);
    if (path.endsWith('plants.obj')) return route.fulfill({ contentType: 'text/plain', body: 'v 0.5 0.5 0.065 0.2 0.6 0.1\nv 0.6 0.5 0.4 0.2 0.6 0.1\nv 0.7 0.5 0.065 0.2 0.6 0.1\nf 1 2 3\n' });
    if (path.startsWith('/api/runs/')) return json(run);
    return json({ detail: 'Unknown test route' }, 404);
  });
  return { getSaved: () => saved };
}

async function mockRunSnapshots(page: Page) {
  const state = await mockApi(page);
  const snapshots = ['a', 'b'].map((id, index): Run => {
    const snapshot = structuredClone(config);
    snapshot.objects = Array.from({length:index + 1}, (_, i) => ({
      ...snapshot.objects[0], id:`${id}-led-${i}`, name:`Run ${id} LED ${i}`, power_w:10 + index,
    }));
    snapshot.planting.plants[0] = {...snapshot.planting.plants[0], id:`${id}-plant`, name:`Run ${id} plant`};
    snapshot.groups = [{id:`${id}-group`, name:`Run ${id} group`, members:[snapshot.objects[0].id, `${id}-plant`]}];
    return {id, name:`Experiment ${id}`, status:index ? 'queued' : 'completed', created_at:'2026-10-19T10:00:00Z',
      started_at:null, finished_at:null, days:3, current_day:index ? 0 : 3, cancel_requested:false, error:null,
      revision:'r1', config:snapshot, available_days:index ? [] : [1, 2, 3]};
  });
  await page.route('**/api/runs', route => route.fulfill({json:snapshots}));
  await page.route(/\/api\/runs\/[ab](\/events)?$/, route => {
    const snapshot = snapshots.find(run => run.id === new URL(route.request().url()).pathname.split('/')[3])!;
    return route.request().url().endsWith('/events')
      ? route.fulfill({contentType:'text/event-stream', body:`data: ${JSON.stringify(snapshot)}\n\n`})
      : route.fulfill({json:snapshot});
  });
  return {state, snapshots};
}

async function mockComparison(page: Page, options: { count?: number; emptyB?: boolean; failB?: boolean } = {}) {
  await mockApi(page);
  const runs: Run[] = ['a', 'b', 'c'].slice(0, options.count ?? 3).map((id, index) => ({
    id, name: `Experiment ${id.toUpperCase()}`, status: 'completed', created_at: '2026-10-19T10:00:00Z',
    started_at: null, finished_at: null, days: index === 1 ? 4 : 3, current_day: index === 1 ? 4 : 3,
    cancel_requested: false, error: null, revision: 'r1', config,
  }));
  let failB = options.failB;
  const metrics: Record<string, DailyResult[]> = {};
  for (const [index, run] of runs.entries()) metrics[run.id] = (run.id === 'a' ? [1, 3] : [1, 2, 3, 4]).map(day => ({
    day, plants: [1, 2].map(plant => ({ plant, model_age_days: day,
      biomass_g: day * (index + 1) * (plant === 1 ? 1 : 3), fruit_g: 0, leaf_area_m2: day * .01,
      par_umol_s: 1, par_mmol_day: 57.6, carbon_mmol_day: day * (index + 1) })),
  }));
  if (options.emptyB) metrics.b = [];
  await page.route('**/api/runs', route => route.fulfill({json:runs}));
  await page.route('**/api/runs/*/metrics', route => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    return id === 'b' && failB ? route.fulfill({status:500,json:{detail:'Metrics unavailable'}}) : route.fulfill({json:metrics[id]});
  });
  return { runs, metrics, recover: () => { failB = false; } };
}

test('compare overlays two runs by day, reports differences and supports independent plants', async ({ page }) => {
  await mockComparison(page);
  await page.goto('/');
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await expect(page.getByLabel('Compare run A', {exact:true})).toHaveValue('a');
  await expect(page.getByLabel('Compare run B', {exact:true})).toHaveValue('b');
  await expect(page.getByLabel('Compare run B', {exact:true}).locator('option[value="a"]')).toHaveAttribute('disabled', '');
  const chart = page.getByRole('article', {name:'Plant dry biomass comparison',exact:true});
  await expect(page.locator('.comparison-chart')).toHaveCount(5);
  await expect(chart.locator('dd')).toHaveText(['6', '12', '+6']);
  await expect(chart).toContainText('Day 3 · latest shared day');
  await expect(chart.locator('.recharts-line-curve')).toHaveCount(2);
  // The missing day 2 in A produces two separate path segments, rather than an interpolated value.
  await expect(chart.locator('.recharts-line-curve').first()).toHaveAttribute('d', /M.*M/);
  await page.getByLabel('Run A reporting', {exact:true}).selectOption('1');
  await expect(chart.locator('dd')).toHaveText(['3', '12', '+9']);
  await page.getByLabel('Run B reporting', {exact:true}).selectOption('1');
  await expect(chart.locator('dd')).toHaveText(['3', '6', '+3']);
  await page.getByLabel('Compare run B', {exact:true}).selectOption('c');
  await expect(chart.locator('dd')).toHaveText(['6', '18', '+12']);
  await page.getByRole('button', {name:'Scene editor',exact:true}).click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await expect(page.getByLabel('Compare run B', {exact:true})).toHaveValue('c');
  await expect(chart.locator('dd')).toHaveText(['6', '18', '+12']);
  await page.screenshot({path:'test-results/compare-desktop.png',fullPage:true});
});

test('compare explains insufficient runs and unpublished results', async ({ page }) => {
  await mockComparison(page, {count:1});
  await page.goto('/');
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await expect(page.getByText('Create at least two simulation runs to compare their results.')).toBeVisible();
  await expect(page.locator('.comparison-chart')).toHaveCount(0);
  await mockComparison(page, {count:2,emptyB:true});
  await page.reload();
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Waiting for daily results'})).toBeVisible();
  await expect(page.getByText('Run B needs at least one published day', {exact:false})).toBeVisible();
});

test('compare recovers from metric errors', async ({ page }) => {
  const state = await mockComparison(page, {failB:true});
  await page.goto('/');
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Metrics unavailable');
  await expect(page.locator('.comparison-chart')).toHaveCount(0);
  state.recover();
  await page.getByRole('button', {name:'Retry comparison'}).click();
  await expect(page.locator('.comparison-chart')).toHaveCount(5);
});

test('compare fits mobile screens', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await mockComparison(page);
  await page.goto('/');
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await expect(page.locator('.comparison-chart')).toHaveCount(5);
  await expect(page.getByLabel('Compare run A', {exact:true})).toBeVisible();
  await expect(page.getByLabel('Compare run B', {exact:true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({path:'test-results/compare-mobile.png',fullPage:true});
});

test('compare plots disjoint day ranges without inventing differences', async ({ page }) => {
  const state = await mockComparison(page);
  state.metrics.b = state.metrics.b.map(row => ({...row,day:row.day + 10}));
  await page.goto('/');
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  const chart = page.getByRole('article', {name:'Plant dry biomass comparison',exact:true});
  await expect(chart.locator('.recharts-line-curve')).toHaveCount(2);
  await expect(chart.locator('dd')).toHaveText(['—', '—', '—']);
  await expect(chart).toContainText('No shared day for these reports');
});

test('compare refreshes results when a running simulation publishes a day', async ({ page }) => {
  const state = await mockComparison(page);
  const published = state.metrics.b;
  state.metrics.b = [];
  state.runs[1].status = 'running'; state.runs[1].current_day = 0;
  await page.goto('/');
  await page.getByRole('button', {name:'Compare',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Waiting for daily results'})).toBeVisible();
  state.metrics.b = published;
  state.runs[1].current_day = 4; state.runs[1].status = 'completed';
  await expect(page.locator('.comparison-chart')).toHaveCount(5, {timeout:10000});
  await expect(page.getByRole('article', {name:'Plant dry biomass comparison',exact:true}).locator('dd')).toHaveText(['6', '12', '+6']);
});

test('named configurations save drafts, survive reload, load, and delete independently of runs', async ({ page }) => {
  const state = await mockApi(page);
  await page.goto('/');
  await page.locator('.object-row').filter({hasText:'LED 1'}).click();
  await page.getByLabel('Emitted power', {exact:true}).fill('27');
  await page.getByLabel('Configuration name', {exact:true}).fill('Low light');
  await page.getByRole('button', {name:'Save configuration', exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Saved “Low light”');
  expect(state.getSaved().objects[0].power_w).toBe(43.8);
  await page.reload();
  await expect(page.getByLabel('Saved configurations', {exact:true}).locator('option')).toHaveCount(2);
  await page.getByLabel('Saved configurations', {exact:true}).selectOption('configuration-1');
  await expect(page.getByRole('status')).toContainText('Loaded “Low light”');
  await page.locator('.object-row').filter({hasText:'LED 1'}).click();
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('27');
  await page.getByRole('button', {name:'Run simulation',exact:true}).click();
  expect(state.getSaved().objects[0].power_w).toBe(27);
  await expect(page.locator('.run-progress')).toContainText('Simulating');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name:'Delete configuration',exact:true}).click();
  await expect(page.getByLabel('Saved configurations', {exact:true}).locator('option')).toHaveCount(1);
  await expect(page.locator('.run-progress')).toContainText('Simulating');
});

test('new run opens an editable draft and finished runs can be deleted', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.locator('.run-row').click();
  await page.getByRole('button', {name:'New run',exact:true}).click();
  await expect(page.getByRole('button', {name:'Scene editor',exact:true})).toHaveClass('active');
  await expect(page.locator('.run-progress')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('autotom-selected-run'))).toBeNull();
  await expect(page.locator('.run-row')).toHaveCount(1);
  await page.locator('.run-row').click();
  await page.getByRole('button', {name:'Actions for Three day experiment',exact:true}).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('menuitem', {name:'Delete',exact:true}).click();
  await expect(page.locator('.run-row')).toHaveCount(1);
  await page.getByRole('button', {name:'Actions for Three day experiment',exact:true}).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', {name:'Delete',exact:true}).click();
  await expect(page.locator('.run-row')).toHaveCount(0);
  await expect(page.locator('.run-progress')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Run and its results deleted');
});

for (const mobile of [false, true]) for (const tab of ['Scene editor', 'Simulation', 'Compare']) {
  test(`switching saved runs preserves ${tab} on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    if (mobile) await page.setViewportSize({width:390,height:844});
    await mockRunSnapshots(page);
    await page.goto('/');
    async function selectRun(id: string) {
      if (mobile) await page.getByLabel('Saved runs', {exact:true}).selectOption(id);
      else await page.locator('.run-row').filter({hasText:`Experiment ${id}`}).click();
      await expect(page.locator('.run-row.selected')).toContainText(`Experiment ${id}`);
    }
    await selectRun('a');
    await page.getByRole('button', {name:tab,exact:true}).click();
    for (const id of ['b', 'a']) {
      await selectRun(id);
      await expect(page.getByRole('button', {name:tab,exact:true})).toHaveClass('active');
      await expect(page.getByLabel('Scene item selection', {exact:true}).locator('.item-name')).toContainText([`Run ${id} LED 0`, `Run ${id} plant`]);
    }
    if (tab === 'Compare') await expect(page.getByLabel('Compare run A', {exact:true})).toHaveValue('a');
  });
}

test('selected runs initialize the scene editor and keep subsequent edits separate from simulation snapshots', async ({ page }) => {
  const {state} = await mockRunSnapshots(page);
  await page.goto('/');
  await page.getByRole('button', {name:'LED 1',exact:true}).click();
  await page.getByLabel('Emitted power', {exact:true}).fill('27');
  await page.getByLabel('Emitted power', {exact:true}).press('Tab');
  const objects = page.getByLabel('Scene item selection', {exact:true});
  const count = page.locator('.sidebar-title').filter({has:page.getByRole('heading', {name:'Scene objects',exact:true})}).locator('span');
  const resultTab = page.getByRole('button', {name:'Simulation',exact:true});

  await page.locator('.run-row').filter({hasText:'Experiment a'}).click();
  await expect(page.getByRole('button', {name:'Scene editor',exact:true})).toHaveClass('active');
  await resultTab.click();
  await expect(count).toHaveText('2');
  await expect(objects.locator('.object-row .item-name')).toHaveText(['Run a LED 0', 'Run a plant']);
  await expect(objects.getByRole('button', {name:'Run a group · 2',exact:true})).toBeVisible();
  await expect(page.getByLabel('Object name', {exact:true})).toHaveCount(0);
  await objects.getByRole('button', {name:'Run a LED 0',exact:true}).click();
  await expect(resultTab).toHaveClass('active');
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('10');
  await expect(page.getByLabel('Emitted power', {exact:true})).toBeDisabled();
  await objects.getByRole('button', {name:'Run a plant',exact:true}).click();
  await expect(page.getByRole('complementary', {name:'Plants configuration'})).toBeVisible();
  await expect(page.getByLabel('Object name', {exact:true})).toHaveValue('Run a plant');
  await expect(resultTab).toHaveClass('active');
  await objects.getByRole('button', {name:'Run a group · 2',exact:true}).click();
  await expect(page.getByLabel('Group name', {exact:true})).toHaveValue('Run a group');
  await expect(page.getByLabel('Group name', {exact:true})).toBeDisabled();
  await page.getByRole('button', {name:'Scene editor',exact:true}).click();
  await expect(objects.locator('.object-row .item-name')).toHaveText(['Run a LED 0', 'Run a plant']);
  await expect(page.getByLabel('Group name', {exact:true})).toHaveValue('Run a group');
  await expect(page.getByLabel('Group name', {exact:true})).toBeEnabled();

  await page.locator('.run-row').filter({hasText:'Experiment b'}).click();
  await expect(page.getByRole('button', {name:'Scene editor',exact:true})).toHaveClass('active');
  await expect(count).toHaveText('3');
  await expect(objects.locator('.object-row .item-name')).toHaveText(['Run b LED 0', 'Run b plant', 'Run b LED 1']);
  await expect(objects.getByRole('checkbox', {checked:true})).toHaveCount(0);
  await expect(page.getByLabel('Group name', {exact:true})).toHaveCount(0);
  await resultTab.click();
  await expect(page.locator('.viewport-label')).toContainText('AWAITING DAILY OUTPUT');
  await objects.getByRole('button', {name:'Run b LED 1',exact:true}).click();
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('11');
  await expect(page.getByLabel('Emitted power', {exact:true})).toBeDisabled();

  await page.getByRole('button', {name:'Scene editor',exact:true}).click();
  await expect(objects.locator('.object-row .item-name')).toHaveText(['Run b LED 0', 'Run b plant', 'Run b LED 1']);
  await expect(count).toHaveText('3');
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('11');
  await expect(page.getByLabel('Emitted power', {exact:true})).toBeEnabled();
  await page.getByLabel('Emitted power', {exact:true}).fill('17');
  await page.getByLabel('Emitted power', {exact:true}).press('Tab');
  await resultTab.click();
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('11');
  await expect(page.getByLabel('Emitted power', {exact:true})).toBeDisabled();
  await page.getByRole('button', {name:'Scene editor',exact:true}).click();
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('17');
  await page.getByRole('button', {name:'Undo',exact:true}).click();
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('11');
  await page.getByRole('button', {name:'Redo',exact:true}).click();
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('17');
  expect(state.getSaved().objects[0].power_w).toBe(43.8);

  await page.reload();
  await expect(resultTab).toHaveClass('active');
  await expect(count).toHaveText('3');
  await expect(objects.locator('.object-row .item-name')).toHaveText(['Run b LED 0', 'Run b plant', 'Run b LED 1']);
  await page.getByRole('button', {name:'Scene editor',exact:true}).click();
  await expect(objects.locator('.object-row .item-name')).toHaveText(['Run b LED 0', 'Run b plant', 'Run b LED 1']);
  await objects.getByRole('button', {name:'Run b LED 1',exact:true}).click();
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('11');
  await expect(page.getByLabel('Emitted power', {exact:true})).toBeEnabled();
  await page.getByRole('button', {name:'New run',exact:true}).click();
  await expect(page.getByRole('button', {name:'Scene editor',exact:true})).toHaveClass('active');
  await objects.getByRole('button', {name:'Run b LED 1',exact:true}).click();
  await expect(page.getByLabel('Emitted power', {exact:true})).toHaveValue('11');
  await expect(page.getByLabel('Emitted power', {exact:true})).toBeEnabled();
});

test('running simulations cannot be deleted', async ({ page }) => {
  await mockApi(page, {status:'running'});
  await page.goto('/');
  await page.locator('.run-row').click();
  await page.getByRole('button', {name:'Actions for Three day experiment',exact:true}).click();
  await expect(page.getByRole('menuitem', {name:'Delete',exact:true})).toBeDisabled();
  await expect(page.getByRole('menuitem', {name:'Rename',exact:true})).toBeEnabled();
});

test('run row menu renames without selecting a run and keeps the name after reload', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const actions = page.getByRole('button', {name:'Actions for Three day experiment',exact:true});
  await expect(page.getByRole('menu')).toHaveCount(0);
  await actions.click();
  await expect(page.locator('.run-progress')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(actions).toBeFocused();
  await actions.click();
  await page.getByRole('heading', {name:'Simulation workspace',exact:true}).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await actions.click();
  await page.getByRole('menuitem', {name:'Rename',exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'Rename run',exact:true});
  await expect(dialog.getByLabel('New run name')).toHaveValue('Three day experiment');
  await dialog.getByLabel('New run name').fill('   ');
  await expect(dialog.getByRole('button', {name:'Save name',exact:true})).toBeDisabled();
  await dialog.getByLabel('New run name').fill('Low light experiment');
  await dialog.getByRole('button', {name:'Save name',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.run-row')).toContainText('Low light experiment');
  await expect(page.locator('.run-progress')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.run-row')).toContainText('Low light experiment');
  await page.getByRole('button', {name:'Actions for Low light experiment',exact:true}).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.screenshot({path:'test-results/run-actions-menu.png'});
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', {name:'Delete',exact:true}).click();
  await expect(page.locator('.run-row')).toHaveCount(0);
});

test('mobile run menu renames the selected run beside its dropdown', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await mockApi(page);
  await page.goto('/');
  await page.getByLabel('Saved runs', {exact:true}).selectOption('test-run');
  await page.getByRole('button', {name:'Simulation',exact:true}).click();
  await page.getByRole('button', {name:'Actions for Three day experiment',exact:true}).click();
  await page.getByRole('menuitem', {name:'Rename',exact:true}).click();
  await page.getByLabel('New run name', {exact:true}).fill('Mobile experiment');
  await page.getByRole('button', {name:'Save name',exact:true}).click();
  await expect(page.getByLabel('Saved runs', {exact:true}).locator('option:checked')).toContainText('Mobile experiment');
  await expect(page.locator('.viewport-label')).toContainText('Mobile experiment');
  await page.getByRole('button', {name:'Actions for Mobile experiment',exact:true}).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.screenshot({path:'test-results/run-actions-mobile.png'});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

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
  await expect(page.locator('.object-row')).toHaveCount(2);
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

test('mixed groups preserve offsets, persist, and support undo and redo', async ({ page }) => {
  const state=await mockApi(page);await page.goto('/');
  await page.getByLabel('Select LED 1',{exact:true}).check();
  await page.getByLabel('Select Plant 1',{exact:true}).check();
  await expect(page.getByText('2 selected items',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Create group',exact:true}).click();
  await page.getByLabel('Group name').fill('Lighting and plants');await page.getByLabel('Group name').press('Tab');
  const originalCenter=Number(await page.getByLabel('position X',{exact:true}).inputValue());
  await page.getByLabel('position X',{exact:true}).fill('0.8');await page.getByLabel('position X',{exact:true}).press('Tab');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  expect(state.getSaved().groups[0].name).toBe('Lighting and plants');
  expect(state.getSaved().objects[0].position[0]).toBeCloseTo(.6+.8-originalCenter);
  expect(state.getSaved().planting.plants[0].position[0]).toBeCloseTo(.6+.8-originalCenter);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByLabel('position X',{exact:true})).toHaveValue(String(originalCenter));
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(page.getByLabel('position X',{exact:true})).toHaveValue('0.8');
  await expect(page.getByLabel('Rotate selection X')).toBeDisabled();
  await page.screenshot({path:'test-results/group-editor.png',fullPage:true});
  await page.getByRole('button',{name:'Duplicate',exact:true}).click();
  await expect(page.getByLabel('Group name')).toHaveValue('Lighting and plants copy');
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.getByLabel('Group name')).toHaveCount(0);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByText('Lighting and plants copy · 2',{exact:true})).toBeVisible();
});

test('parameters, proportion arrays and temperatures save as overrides and reset',async({page})=>{
  const state=await mockApi(page);await page.goto('/');
  await page.getByRole('button',{name:'Model parameters',exact:true}).click();
  await page.getByLabel('Search model parameters').fill('base temperature');
  await page.getByLabel('Base temperature',{exact:true}).fill('7.2');await page.getByLabel('Base temperature',{exact:true}).press('Tab');
  await page.getByLabel('Select temperature day 1',{exact:true}).check();
  await page.getByLabel('Select temperature day 3',{exact:true}).check();
  await page.getByLabel('Fill temperature',{exact:true}).fill('24');
  await page.getByRole('button',{name:'Fill selected days',exact:true}).click();
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  expect(state.getSaved().parameter_overrides.base_temperature).toBe(7.2);
  expect(state.getSaved().temperature_overrides).toEqual({'0':24,'2':24});
  await page.screenshot({path:'test-results/parameter-editor.png',fullPage:true});
  await page.getByLabel('Search model parameters').fill('proportions');
  await page.getByLabel('First leaf proportions',{exact:true}).fill('0.5; 0.5');await page.getByLabel('First leaf proportions',{exact:true}).press('Tab');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  expect(state.getSaved().parameter_overrides.proportion_petiolules_first_leaves).toEqual([.5,.5]);
  await page.getByRole('button',{name:'Reset all parameters',exact:true}).click();
  await page.getByRole('button',{name:'Reset temperatures',exact:true}).click();
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  expect(state.getSaved().parameter_overrides).toEqual({});expect(state.getSaved().temperature_overrides).toEqual({});
});

test('plant layouts, stable reporting IDs, last-plant protection and undo',async({page})=>{
  const state=await mockApi(page);await page.goto('/');
  await page.getByRole('button',{name:'Plants',exact:true}).click();
  await page.getByLabel('Rows',{exact:true}).fill('2');await page.getByLabel('Rows',{exact:true}).press('Tab');
  await page.getByLabel('Layout pattern').selectOption('staggered');
  await page.getByRole('button',{name:'Generate layout',exact:true}).click();
  await expect(page.getByText('2 simulated plants · 0 border clones · preset layout',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Add plant',exact:true}).click();
  await page.getByLabel('position Z',{exact:true}).fill('0.2');await page.getByLabel('position Z',{exact:true}).press('Tab');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  const plants=state.getSaved().planting.plants;
  expect(plants.map(p=>p.reporting_id)).toEqual([2,3,4]);expect(plants[2].position[2]).toBe(.2);
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.getByLabel('position Z',{exact:true})).toHaveValue('0');
  await page.getByRole('button',{name:'Redo',exact:true}).click();await expect(page.getByLabel('position Z',{exact:true})).toHaveValue('0.2');
  await page.getByRole('button',{name:'Add border',exact:true}).click();await expect(page.getByLabel('Plant role')).toHaveValue('border');
  await expect(page.getByLabel('rotation X',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await page.getByLabel('Select Plant 1',{exact:true}).check();await page.getByLabel('Select Plant 2',{exact:true}).check();await page.getByLabel('Select Plant 4',{exact:true}).check();
  await page.getByRole('button',{name:'Delete',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Keep at least one');
});

test('box selection, click modifiers, escape and result edit protection',async({page})=>{
  await mockApi(page);await page.goto('/');
  const canvas=page.locator('canvas');const rect=(await canvas.boundingBox())!;
  await page.getByRole('button',{name:'Box selection',exact:true}).click();
  await page.mouse.move(rect.x+2,rect.y+2);await page.mouse.down();await page.mouse.move(rect.x+rect.width-2,rect.y+rect.height-2,{steps:10});await page.mouse.up();
  await expect(page.getByText('2 selected items',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByText('2 selected items',{exact:true})).toHaveCount(0);
  await page.locator('.object-row').first().click();await page.locator('.object-row').nth(1).click({modifiers:['Shift']});
  await expect(page.getByText('2 selected items',{exact:true})).toBeVisible();
  await page.locator('.run-row').click();
  await page.getByRole('button',{name:'Simulation',exact:true}).click();
  await expect(page.getByRole('button',{name:'Create group',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Box selection',exact:true})).toHaveCount(0);
});

test('saved groups reload and membership actions retain valid references',async({page})=>{
  const state=await mockApi(page);await page.goto('/');
  await page.getByLabel('Select LED 1',{exact:true}).check();await page.getByLabel('Select Plant 1',{exact:true}).check();
  await page.getByRole('button',{name:'Create group',exact:true}).click();
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('Group 1 · 2',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Surroundings',exact:true}).click();await page.getByRole('button',{name:'Box',exact:true}).click();
  await page.getByLabel('Target group').selectOption(state.getSaved().groups[0].id);
  await page.getByRole('button',{name:'Add to group',exact:true}).click();await expect(page.getByText('Group 1 · 3',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Remove from group',exact:true}).click();await expect(page.getByText('Group 1 · 2',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Group 1 · 2',exact:true}).click();
  await page.getByRole('button',{name:'Ungroup',exact:true}).click();await expect(page.getByText('Group 1 · 2',{exact:true})).toHaveCount(0);
  await page.keyboard.press('Control+z');await expect(page.getByText('Group 1 · 2',{exact:true})).toBeVisible();
});

test('shared gizmo drag moves all selected items as one undo step',async({page})=>{
  const state=await mockApi(page);await page.goto('/');
  await page.getByLabel('Select LED 1',{exact:true}).check();await page.getByLabel('Select Plant 1',{exact:true}).check();
  await expect(page.getByLabel('position Z',{exact:true})).toHaveValue('0.3715');
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  const center=new THREE.Vector3(...await Promise.all(['X','Y','Z'].map(async axis=>Number(await page.getByLabel(`position ${axis}`,{exact:true}).inputValue()))) as [number,number,number]);
  const rect=(await page.locator('canvas').boundingBox())!;
  const camera=new THREE.PerspectiveCamera(42,rect.width/rect.height,.005,500);camera.up.set(0,0,1);camera.position.set(2.5,-2.8,2.2);camera.lookAt(.6,.6,.3);camera.updateMatrixWorld(true);
  const scale=center.distanceTo(camera.position)*Math.min(1.9*Math.tan(Math.PI*camera.fov/360),7)*.7/4;
  function screen(point:THREE.Vector3) {const p=point.project(camera);return{x:rect.x+(p.x+1)*rect.width/2,y:rect.y+(1-p.y)*rect.height/2};}
  const start=screen(center.clone().add(new THREE.Vector3(scale*.48,0,0)));
  const end=screen(center.clone().add(new THREE.Vector3(scale*.48+.18,0,0)));
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:12});await page.mouse.up();
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
  const delta=state.getSaved().objects[0].position[0]-.6;
  expect(delta).toBeGreaterThan(.1);expect(state.getSaved().planting.plants[0].position[0]-.6).toBeCloseTo(delta,6);
  expect(state.getSaved().objects[0].position[2]-.725).toBeCloseTo(state.getSaved().planting.plants[0].position[2],6);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByLabel('position X',{exact:true})).toHaveValue(String(Number(center.x.toFixed(6))));
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeDisabled();
});

test('small parameter values retain precision and a typed edit is one undo step',async({page})=>{
  await mockApi(page);await page.goto('/');
  await page.getByRole('button',{name:'Model parameters',exact:true}).click();
  await page.getByLabel('Search model parameters').fill('Phytomer coefficient');
  const input=page.getByLabel('Phytomer coefficient',{exact:true});
  await expect(input).toHaveValue('0.0000241');await input.focus();await input.press('Tab');
  await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeDisabled();
  await input.fill('');await input.pressSequentially('0.00003123456789');await input.press('Tab');
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(input).toHaveValue('0.0000241');await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Redo',exact:true}).click();await expect(input).toHaveValue('0.00003123456789');
});

test('box selection selects member origins independently and escape cancels a rectangle',async({page})=>{
  await mockApi(page);await page.goto('/');
  await page.getByLabel('Select LED 1',{exact:true}).check();await page.getByLabel('Select Plant 1',{exact:true}).check();
  await page.getByRole('button',{name:'Create group',exact:true}).click();
  const rect=(await page.locator('canvas').boundingBox())!;
  const camera=new THREE.PerspectiveCamera(42,rect.width/rect.height,.005,500);camera.up.set(0,0,1);camera.position.set(2.5,-2.8,2.2);camera.lookAt(.6,.6,.3);camera.updateMatrixWorld(true);
  const point=new THREE.Vector3(.6,.6,.725).project(camera);
  const x=rect.x+(point.x+1)*rect.width/2,y=rect.y+(1-point.y)*rect.height/2;
  await page.getByRole('button',{name:'Box selection',exact:true}).click();
  await page.mouse.move(x-10,y-10);await page.mouse.down();await page.mouse.move(x+10,y+10,{steps:3});await page.mouse.up();
  await expect(page.getByLabel('Select LED 1',{exact:true})).toBeChecked();await expect(page.getByLabel('Select Plant 1',{exact:true})).not.toBeChecked();
  await page.mouse.move(rect.x+2,rect.y+2);await page.mouse.down();await page.mouse.move(rect.x+rect.width-2,rect.y+rect.height-2,{steps:3});await page.keyboard.press('Escape');await page.mouse.up();
  await expect(page.getByLabel('Select LED 1',{exact:true})).not.toBeChecked();await expect(page.getByLabel('Select Plant 1',{exact:true})).not.toBeChecked();
});
