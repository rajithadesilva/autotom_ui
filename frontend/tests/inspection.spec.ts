import { test, expect, type Page } from '@playwright/test';
import * as THREE from 'three';
import type { Config, Run, InspectionDay, InspectionMetadata } from '../src/types';

const config: Config = {
  version:2,room:{width:1.2,length:1.2,height:.735,enabled:true,wall_reflectance:null,floor_reflectance:null,ceiling_reflectance:null},
  simulation:{days:5,rows:1,plants_per_row:2,density:50,border_rows:0,border_plants:0,seed:0,rays:200000,photoperiod:16,plant_input:'p.csv',temperature_input:'t.csv',emission_input:'e.csv',spectrum_input:'s.csv'},
  spectrum:[{wavelength:400,amplitude:1},{wavelength:700,amplitude:1}],parameter_overrides:{},temperature_overrides:{},
  objects:[{id:'lamp',name:'Lamp',kind:'led',position:[.6,.6,.725],rotation:[180,0,0],size:[.1,.1,.1],power_w:10,reflectance:.5,enabled:true}],
  planting:{mode:'custom',pattern:'grid',plant_spacing:null,row_spacing:null,center:[.6,.6,0],rotation:0,next_reporting_id:12,
    plants:[{id:'a',name:'Plant A',role:'central',reporting_id:7,position:[.6,.6,0],rotation:[0,0,0],row:1,col:1,enabled:true},
      {id:'b',name:'Plant B',role:'central',reporting_id:11,position:[.2,.9,0],rotation:[0,0,30],row:1,col:2,enabled:true},
      {id:'border',name:'Border A',role:'border',reporting_id:null,position:[.95,.65,0],rotation:[0,0,0],row:0,col:0,enabled:true}]},
  groups:[{id:'mixed',name:'Mixed group',members:['lamp','a']}],
};
const pose = (x: number, y: number) => [1,0,0,x,0,1,0,y,0,0,1,.065,0,0,0,1];
const dayManifest = (day: number): InspectionDay => ({version:1,day,instances:[
  {id:'a',geometry:'plant_7',source_id:'a',matrix:pose(.6,.6),state:{plant_number:7,dry_biomass_plant_with_roots_mg:day*100,root_shoot:null}},
  {id:'b',geometry:'plant_11',source_id:'b',matrix:pose(.2,.9),state:{plant_number:11,dry_biomass_plant_with_roots_mg:day*200,root_shoot:.3}},
  {id:'border',geometry:'plant_7',source_id:'a',matrix:pose(.95,.65),state:null},
]});
async function mock(page: Page, options: { legacy?: boolean; failDay?: number; delayDay?: number; running?: boolean } = {}) {
  const writes: string[] = [], downloads: number[] = [];
  const run: Run={id:'inspect-run',name:'Inspection run',status:options.running?'running':'completed',created_at:'2026-10-20T10:00:00Z',started_at:null,finished_at:null,days:5,current_day:options.running?1:5,cancel_requested:false,error:null,revision:'r1',config,available_days:options.running?[1]:[1,3,5]};
  const metadata = (): InspectionMetadata => ({version:1,available_days:options.legacy?[]:run.available_days!,inputs_available:true,
    fields:[{key:'dry_biomass_plant_with_roots_mg',group:'biomass',type:'number',unit:'mg'},{key:'root_shoot',group:'growth',type:'number',unit:''}],
    parameters:[{key:'base_temperature',label:'Base temperature',type:'number',group:'growth',unit:'°C',value:7.1}],temperatures:[20,21,22,23,24]});
  await page.addInitScript(() => {
    const sources: {onmessage?: (event: {data: string}) => void}[] = [];
    (window as unknown as {emitInspectionRun: (run: unknown) => void}).emitInspectionRun = run => sources.forEach(s => s.onmessage?.({data:JSON.stringify(run)}));
    window.EventSource = class {
      onmessage?: (event: {data:string}) => void;
      onerror = null;
      constructor() {sources.push(this);}
      close() { const index=sources.indexOf(this); if(index>=0)sources.splice(index,1); }
    } as unknown as typeof EventSource;
  });
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname, method=route.request().method();
    if(method!=='GET'&&path!=='/api/inputs/preview') writes.push(path);
    const json=(value:unknown,status=200)=>route.fulfill({status,json:value});
    if(path==='/api/config')return json({config,revision:'r1',installed:true,inputs:{dynamic_input:['p.csv'],temperature:['t.csv'],light_emission_pattern:['e.csv'],light_spectrum:['s.csv']}});
    if(path==='/api/configurations')return json([]);
    if(path==='/api/health')return json({status:'ok',worker:{ready:true}});
    if(path==='/api/inputs/preview')return json({revision:'r1',parameters:[{key:'base_temperature',label:'Base temperature',type:'number',group:'growth',unit:'°C',value:5.7}],temperatures:[20,21,22,23,24]});
    if(path==='/api/runs')return json([run]);
    if(path.endsWith('/inspection'))return json(metadata());
    if(path.endsWith('/metrics'))return json((run.available_days||[]).map(day=>({day,plants:[7,11].map(plant=>({plant,model_age_days:day,biomass_g:day*.1,fruit_g:0,leaf_area_m2:day*.002,par_umol_s:1,par_mmol_day:57.6,carbon_mmol_day:2}))})));
    if(path.includes('/artifacts/')){
      const day=Number(path.match(/days\/(\d+)/)?.[1]);
      if(path.endsWith('inspection.json'))return options.legacy?json({detail:'Missing'},404):json(dayManifest(day));
      if(path.endsWith('plants.obj')){
        downloads.push(day);
        if(options.delayDay===day)await new Promise(resolve=>setTimeout(resolve,300));
        if(options.failDay===day)return json({detail:'Missing'},404);
        return route.fulfill({contentType:'text/plain',body:'o plant_7\nv .4 .6 .1\nv .6 .6 .5\nv .8 .6 .1\nf 1 2 3\no plant_11\nv .1 .9 .1\nv .2 .9 .5\nv .3 .9 .1\nf 4 5 6\n'});
      }
      return json({detail:'Missing'},404);
    }
    if(path==='/api/runs/inspect-run')return json(run);
    return json({detail:'Unknown test route'},404);
  });
  return {writes,downloads,run};
}
async function simulation(page: Page) {
  await page.goto('/');
  if ((page.viewportSize()?.width || 1440) < 980) await page.getByLabel('Saved runs',{exact:true}).selectOption('inspect-run');
  else await page.locator('.run-row').filter({hasText:'Inspection run'}).click();
  await page.getByRole('button',{name:'Simulation',exact:true}).click();
  await page.getByRole('button',{name:'Inspect objects'}).click();
}
async function select(page: Page, name: string) {
  await page.getByLabel('Scene item selection',{exact:true}).getByRole('button',{name,exact:true}).click();
}
const panel = (page: Page) => page.getByRole('complementary',{name:'Object inspection'});

test('inspection is single-object, read-only, restores the editor pane and handles Escape in search',async({page})=>{
  const state=await mock(page);
  await page.goto('/');
  await page.getByRole('button',{name:'Mixed group · 2'}).click();
  await page.getByRole('button',{name:'Inspect objects'}).click();
  await expect(panel(page)).toContainText('Select an individual object');
  await select(page,'Plant A');
  await expect(panel(page).getByRole('heading',{name:'Plant A'})).toBeVisible();
  await expect(page.getByLabel('Select Lamp',{exact:true})).not.toBeChecked();
  await expect(page.getByLabel('Select Plant A',{exact:true})).toBeChecked();
  await expect(panel(page)).toContainText('Placement preview');
  await expect(panel(page).locator('input[type=number]')).toHaveCount(0);
  await expect(panel(page).locator('canvas')).toBeVisible();
  await panel(page).getByRole('searchbox').fill('reporting_id');
  await expect(panel(page).locator('code')).toHaveText(['reporting_id']);
  await panel(page).getByRole('searchbox').press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Inspect objects'})).toHaveAttribute('aria-pressed','false');
  await expect(page.getByRole('button',{name:'Close configuration'})).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('simulation picks a surface, shares cached geometry and has independent and synchronized sparse timelines',async({page})=>{
  const state=await mock(page);
  await simulation(page);
  const scene=page.getByLabel('3D scene viewer',{exact:true});
  await expect(scene.locator('.scene-message')).toHaveCount(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const rect=(await scene.boundingBox())!;
  const camera=new THREE.PerspectiveCamera(42,rect.width/rect.height,.005,500);
  camera.up.set(0,0,1);camera.position.set(2.5,-2.8,2.2);camera.lookAt(.6,.6,.3);camera.updateMatrixWorld();
  const projected=new THREE.Vector3(.6,.6,.27).project(camera);
  await page.mouse.click(rect.x+(projected.x+1)/2*rect.width,rect.y+(1-projected.y)/2*rect.height);
  await expect(panel(page).getByRole('heading',{name:'Plant A'})).toBeVisible();
  await expect(panel(page).locator('.scene-message')).toHaveCount(0);
  expect(state.downloads.filter(d=>d===5)).toHaveLength(1);
  const plantDay=page.getByLabel('Inspected plant day',{exact:true}), mainDay=page.getByLabel('Simulation day',{exact:true});
  await plantDay.focus();await plantDay.press('Home');
  await expect(panel(page).locator('.inspection-timeline strong')).toHaveText('Day 1');
  await expect(page.locator('.timeline-day strong')).toHaveText('Day 5');
  await panel(page).getByLabel('Sync with simulation',{exact:true}).check();
  await expect(plantDay).toHaveValue('2');
  await plantDay.focus();await plantDay.press('Home');
  await expect(mainDay).toHaveValue('0');
  await mainDay.focus();await mainDay.press('End');
  await expect(plantDay).toHaveValue('2');
  await panel(page).getByLabel('Sync with simulation',{exact:true}).uncheck();
  await panel(page).getByRole('button',{name:'Play plant playback'}).click();
  await expect(panel(page).locator('.inspection-timeline strong')).toHaveText('Day 1');
  await panel(page).getByRole('button',{name:'Pause plant playback'}).click();
  await expect(page.locator('.timeline-day strong')).toHaveText('Day 5');
  expect(state.writes).toEqual([]);
});

test('legacy plant surface clicks open an explicit chooser instead of silently clearing inspection',async({page})=>{
  await mock(page,{legacy:true});
  await simulation(page);
  const scene=page.getByLabel('3D scene viewer',{exact:true});
  await expect(scene.locator('.scene-message')).toHaveCount(0);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  const rect=(await scene.boundingBox())!;
  const camera=new THREE.PerspectiveCamera(42,rect.width/rect.height,.005,500);
  camera.up.set(0,0,1);camera.position.set(2.5,-2.8,2.2);camera.lookAt(.6,.6,.3);camera.updateMatrixWorld();
  const point=new THREE.Vector3(.6,.6,.27).project(camera);
  await page.mouse.click(rect.x+(point.x+1)/2*rect.width,rect.y+(1-point.y)/2*rect.height);
  const choices=panel(page).getByLabel('Choose a plant to inspect',{exact:true});
  await expect(choices.getByRole('button')).toHaveCount(3);
  await expect(choices.getByRole('button').first()).toContainText('Plant A');
  await expect(panel(page)).toContainText('mesh cannot identify which plant owns the clicked surface');
  await expect(panel(page).getByRole('heading',{name:'Object inspector',exact:true})).toBeVisible();
  await panel(page).getByLabel('Find a plant to inspect').fill('11');
  await expect(choices.getByRole('button')).toHaveCount(1);
  await choices.getByRole('button').click();
  await expect(panel(page).getByRole('heading',{name:'Plant B',exact:true})).toBeVisible();
  await expect(panel(page)).toContainText('Daily metrics');
  await expect(page.getByLabel('Select Plant B',{exact:true})).toBeChecked();
});

test('clone inspection identifies shared state and snapshot inputs; legacy runs keep partial information',async({page})=>{
  await mock(page);
  await simulation(page);await select(page,'Border A');
  await expect(panel(page)).toContainText('Visual clone of Plant A');
  await expect(panel(page)).toContainText('Source daily metrics');
  await panel(page).getByRole('searchbox').fill('root_shoot');
  await expect(panel(page)).toContainText('Unavailable');
  await panel(page).getByRole('searchbox').fill('base_temperature');
  await expect(panel(page)).toContainText('7.1');
  await page.getByRole('button',{name:'Close inspection'}).click();
  await expect(panel(page)).toHaveCount(0);
});

test('legacy runs expose metrics without pretending placement blocks are growth models',async({page})=>{
  await mock(page,{legacy:true});
  await simulation(page);await select(page,'Plant A');
  await expect(panel(page)).toContainText('Older runs require a new simulation');
  await expect(panel(page)).toContainText('Daily metrics');
  await expect(panel(page).locator('canvas')).toBeVisible();
});

test('rapid independent scrubbing ignores obsolete responses and reports geometry failures',async({page})=>{
  await mock(page,{delayDay:1,failDay:3});
  await simulation(page);await select(page,'Plant A');
  const slider=page.getByLabel('Inspected plant day',{exact:true});
  await slider.focus();await slider.press('Home');await slider.press('End');
  await expect(panel(page).locator('.inspection-timeline strong')).toHaveText('Day 5');
  await expect(panel(page).locator('.scene-message')).toHaveCount(0);
  await slider.press('ArrowLeft');
  await expect(panel(page).getByRole('status')).toContainText('Daily plant geometry is not available');
  await slider.press('End');
  await expect(panel(page).locator('.scene-message')).toHaveCount(0);
});

test('newly published days extend inspection without changing independent day and run changes close inspection',async({page})=>{
  const state=await mock(page,{running:true});
  await simulation(page);await select(page,'Plant A');
  await expect(panel(page).getByLabel('Inspected plant day')).toBeEnabled();
  state.run.available_days=[1,3];state.run.current_day=3;
  await page.evaluate(run=>(window as unknown as {emitInspectionRun:(run:unknown)=>void}).emitInspectionRun(run),state.run);
  await expect(panel(page)).toContainText('2 days available');
  await expect(panel(page).locator('.inspection-timeline strong')).toHaveText('Day 1');
  await page.locator('.run-row').filter({hasText:'Inspection run'}).click();
  await expect(panel(page)).toHaveCount(0);
});

test('isolated camera changes leave the main camera unchanged and persist across days',async({page})=>{
  await mock(page);
  await simulation(page);await select(page,'Plant A');
  await expect(panel(page).locator('.scene-message')).toHaveCount(0);
  const main=page.getByLabel('3D scene viewer',{exact:true}).locator('canvas');
  const isolated=panel(page).locator('canvas');
  await isolated.scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise<void>(resolve=>{let frames=0;function next(){if(++frames>100)resolve();else requestAnimationFrame(next);}next();}));
  const beforeMain=await main.screenshot(), beforeIsolated=await isolated.screenshot();
  const rect=(await isolated.boundingBox())!;
  await page.mouse.move(rect.x+rect.width*.5,rect.y+rect.height*.5);
  await page.mouse.down();await page.mouse.move(rect.x+rect.width*.7,rect.y+rect.height*.6,{steps:10});await page.mouse.up();
  await page.evaluate(()=>new Promise<void>(resolve=>{let frames=0;function next(){if(++frames>100)resolve();else requestAnimationFrame(next);}next();}));
  const afterIsolated=await isolated.screenshot();
  expect(afterIsolated.equals(beforeIsolated)).toBe(false);
  expect((await main.screenshot()).equals(beforeMain)).toBe(true);
  const slider=panel(page).getByLabel('Inspected plant day');
  await slider.focus();await slider.press('Home');
  await expect(panel(page).locator('.scene-message')).toHaveCount(0);
  // Identical daily geometry makes any camera reset visible in this fixture.
  expect((await isolated.screenshot()).equals(beforeIsolated)).toBe(false);
});

test('inspection stacks on mobile without horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await mock(page);await simulation(page);await select(page,'Plant A');
  await expect(panel(page).locator('canvas')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await panel(page).getByRole('button',{name:'Fit object'}).click();
  await panel(page).getByRole('button',{name:'Close inspection'}).click();
  await expect(panel(page)).toHaveCount(0);
});

test('real GroIMP geometry, clone identity and all daily state load in the inspector',async({page})=>{
  test.skip(!process.env.INSPECTION_RUN_DIR,'Set INSPECTION_RUN_DIR to an isolated v3 GroIMP acceptance run');
  const {readFile}=await import('node:fs/promises');
  const root=process.env.INSPECTION_RUN_DIR!;
  const readJson=async(name:string)=>JSON.parse(await readFile(root+'/'+name,'utf8'));
  const state=await mock(page);
  const realConfig:Config=await readJson('config.json'), metadata:InspectionMetadata=await readJson('inspection-metadata.json');
  const realRun:Run={...state.run,config:realConfig,days:2,current_day:2,available_days:[1,2]};
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(value:unknown)=>route.fulfill({json:value});
    if(path==='/api/config')return json({config:realConfig,revision:'r1',installed:true,inputs:{}});
    if(path==='/api/runs')return json([realRun]);
    if(path==='/api/runs/inspect-run')return json(realRun);
    if(path.endsWith('/inspection'))return json(metadata);
    if(path.endsWith('/metrics'))return json(await Promise.all([1,2].map(day=>readJson(`days/000${day}/metrics.json`))));
    if(path.includes('/artifacts/')){
      const artifact=path.split('/artifacts/')[1];
      if(!/^days\/000[12]\/(plants\.obj|plants\.mtl|inspection\.json)$/.test(artifact))return route.fulfill({status:404});
      return route.fulfill({contentType:artifact.endsWith('.json')?'application/json':'text/plain',body:await readFile(root+'/'+artifact)});
    }
    return route.fallback();
  });
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await simulation(page);await select(page,'Central A');
  await expect(panel(page).locator('.scene-message')).toHaveCount(0);
  await panel(page).getByRole('searchbox').fill('dry_biomass_plant_with_roots_mg');
  const actual:InspectionDay=await readJson('days/0002/inspection.json');
  const value=actual.instances.find(i=>i.id==='central-a')!.state!.dry_biomass_plant_with_roots_mg as number;
  await expect(panel(page)).toContainText(Number(value.toPrecision(9)).toString());
  await panel(page).getByRole('searchbox').fill('');
  await page.getByLabel('Inspected plant day',{exact:true}).focus();await page.keyboard.press('Home');
  await expect(panel(page).locator('.inspection-timeline strong')).toHaveText('Day 1');
  await expect(panel(page).locator('.scene-message')).toHaveCount(0);
  await select(page,'Border A');
  await expect(panel(page)).toContainText('Visual clone of Central A');
  await expect(panel(page).locator('.scene-message')).toHaveCount(0);
  await page.screenshot({path:'/tmp/autotom-inspection-real.png',fullPage:true});
  expect(errors).toEqual([]);
});
