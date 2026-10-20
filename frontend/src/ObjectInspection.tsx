import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Pause, Play, X } from 'lucide-react';
import type { Config, DailyResult, InspectionDay, InspectionMetadata, InputPreview, Run } from './types';
import { api } from './types';
import { isPlant, itemsOf, type Item } from './editor';
import { makeObject, makePlant } from './Scene';
import { acquireDaily, disposeOwned } from './geometry';

type Props = {
  config: Config; id: string | null; run: Run | null; simulation: boolean; data: DailyResult[];
  mainDay: number; mainPlaying: boolean; onDay: (day: number) => void; onPlaying: (playing: boolean) => void; onClose: () => void;
  candidates?: string[]; onSelect?: (id: string) => void;
};
type Value = number | string | boolean | null | number[];
type Row = { key: string; value: Value; label?: string; unit?: string };

function Properties({ title, rows, search, open = false }: { title: string; rows: Row[]; search: string; open?: boolean }) {
  const visible = rows.filter(row => [title, row.key, row.label || ''].some(s => s.toLowerCase().includes(search.toLowerCase())));
  if (!visible.length) return null;
  return <details className="inspection-section" open={open || Boolean(search)}><summary>{title}<small>{visible.length}</small></summary>
    <dl>{visible.map(row => <div key={row.key}><dt title={row.label || row.key}>{row.label && <span>{row.label}</span>}<code>{row.key}</code></dt>
      <dd title={String(row.value)}>{row.value === null ? 'Unavailable' : typeof row.value === 'boolean' ? (row.value ? 'Yes' : 'No') : Array.isArray(row.value) ? row.value.join(', ') : typeof row.value === 'number' ? (Number.isInteger(row.value) ? String(row.value) : Number(row.value.toPrecision(9)).toString()) : row.value}{row.unit && row.value !== null && <small> {row.unit}</small>}</dd></div>)}</dl>
  </details>;
}

type Viewer = { scene: THREE.Scene; camera: THREE.PerspectiveCamera; orbit: OrbitControls; world: THREE.Group; renderer: THREE.WebGLRenderer; fitted: string };
function fitModel(context: Viewer, identity: string, force = false) {
  const bounds = new THREE.Box3().setFromObject(context.world);
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new THREE.Vector3()), extent = bounds.getSize(new THREE.Vector3());
  const direction = context.camera.position.clone().sub(context.orbit.target).normalize();
  const distance = context.camera.position.distanceTo(context.orbit.target);
  const refit = force || context.fitted !== identity;
  context.orbit.target.copy(center);
  context.camera.position.copy(center).addScaledVector(direction, refit ? Math.max(extent.x, extent.y, extent.z, .05) * 2.2 * Math.max(1, 1 / context.camera.aspect) : distance);
  context.orbit.update(); context.fitted = identity;
}

export function InspectionModel({ item, config, runId, day, growth, onManifest }: {
  item: Item; config: Config; runId?: string; day: number; growth: boolean; onManifest: (manifest: InspectionDay | null) => void;
}) {
  const element = useRef<HTMLDivElement>(null), context = useRef<Viewer | null>(null);
  const manifestCallback = useRef(onManifest); manifestCallback.current = onManifest;
  const [ready, setReady] = useState(0), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    const host = element.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setError('WebGL is unavailable for the isolated model viewer.'); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(42, 1, .001, 1000), world = new THREE.Group();
    camera.up.set(0, 0, 1); camera.position.set(1, -1.4, 1);
    const orbit = new OrbitControls(camera, renderer.domElement); orbit.enableDamping = true;
    scene.add(world, new THREE.HemisphereLight(0xf0f4df, 0x364f3c, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(-2, -3, 6); scene.add(light);
    context.current = { scene, camera, orbit, world, renderer, fitted: '' };
    const resize = new ResizeObserver(() => {
      const { width, height } = host.getBoundingClientRect();
      renderer.setSize(width, height); camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix();
    }); resize.observe(host);
    let animation = 0;
    function render() { animation = requestAnimationFrame(render); orbit.update(); renderer.render(scene, camera); }
    render(); setReady(n => n + 1);
    return () => { cancelAnimationFrame(animation); resize.disconnect(); world.clear(); orbit.dispose(); renderer.dispose(); renderer.domElement.remove(); context.current = null; };
  }, []);
  useEffect(() => {
    const ctx = context.current;
    if (!ctx) return;
    const controller = new AbortController();
    let owned: THREE.Group | undefined;
    ctx.world.clear(); setError(''); setLoading(growth); manifestCallback.current(null);
    const identity = (runId || 'preview') + '/' + item.id + '/' + growth;
    if (growth && runId) {
      acquireDaily(runId, day, controller.signal).then(asset => {
        if (controller.signal.aborted) return;
        const object = asset.model.getObjectByName(item.id);
        if (!object) throw new Error('Individual geometry is unavailable for this object.');
        ctx.world.add(object.clone(true));
        fitModel(ctx, identity); manifestCallback.current(asset.manifest); setLoading(false);
      }).catch(e => { if (!controller.signal.aborted) { setLoading(false); setError(e.message); } });
    } else {
      owned = isPlant(item) ? makePlant(item, config) : makeObject(item);
      owned.visible = true;
      ctx.world.add(owned); fitModel(ctx, identity);
    }
    return () => { ctx.world.clear(); controller.abort(); if (owned) disposeOwned(owned); };
  }, [JSON.stringify(item), JSON.stringify(config.parameter_overrides), runId, day, growth, ready]);
  return <div className="inspection-model" ref={element} aria-label="Isolated interactive 3D model">
    {(error || loading) && <div className={'scene-message' + (error ? ' error' : '')} role="status">{error || 'Loading plant…'}</div>}
    <button className="fit-button" disabled={loading} onClick={() => { if (context.current) fitModel(context.current, context.current.fitted, true); }}>Fit object</button>
    <span className="inspection-model-hint">Drag to orbit · scroll to zoom</span>
  </div>;
}

export default function ObjectInspection({ config, id, run, simulation, data, mainDay, mainPlaying, onDay, onPlaying, onClose, candidates = [], onSelect }: Props) {
  const item = itemsOf(config).find(i => i.id === id);
  const plant = item && isPlant(item) ? item : null;
  const [search, setSearch] = useState(''), [day, setDay] = useState(mainDay);
  const [sync, setSync] = useState(false), [playing, setPlaying] = useState(false);
  const [metadata, setMetadata] = useState<InspectionMetadata | null>(null), [manifest, setManifest] = useState<InspectionDay | null>(null);
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const days = run?.available_days || [], selectedDay = sync ? mainDay : day;
  useEffect(() => {
    const controller = new AbortController(); setError('');
    if (simulation && run) {
      api<InspectionMetadata>(`/runs/${run.id}/inspection`, { signal: controller.signal }).then(setMetadata).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    } else {
      api<InputPreview>('/inputs/preview', { method: 'POST', signal: controller.signal, body: JSON.stringify({ plant_input: config.simulation.plant_input, temperature_input: config.simulation.temperature_input }) })
        .then(input => setMetadata({ version: 1, available_days: [], fields: [], inputs_available: true,
          parameters: input.parameters.map(p => ({ ...p, value: config.parameter_overrides[p.key] ?? (p.key === 'density' ? config.simulation.density : p.value) })),
          temperatures: Array.from({ length: config.simulation.days }, (_, i) => config.temperature_overrides[String(i)] ?? input.temperatures[i] ?? null) }))
        .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    }
    return () => controller.abort();
  }, [simulation, run?.id, run?.current_day, JSON.stringify(config), retry]);
  useEffect(() => { if (days.length && !days.includes(day)) setDay(days[0]); }, [days.join(','), day]);
  useEffect(() => {
    if (!playing || sync || days.length < 2) return;
    const timer = setInterval(() => setDay(value => days[(days.indexOf(value) + 1) % days.length]), 900);
    return () => clearInterval(timer);
  }, [playing, sync, days.join(',')]);
  useEffect(() => { setPlaying(false); setManifest(null); setDay(mainDay); }, [id]);
  const current = manifest?.day === selectedDay ? manifest.instances.find(i => i.id === id) : undefined;
  const source = current && manifest?.instances.find(i => i.id === current.source_id);
  const state = current?.state || source?.state;
  const sourcePlant = config.planting.plants.find(p => p.id === current?.source_id);
  const metric = data.find(d => d.day === selectedDay)?.plants.find(p => p.plant === (sourcePlant?.reporting_id ?? plant?.reporting_id));
  const growth = Boolean(simulation && plant?.enabled && metadata?.available_days.includes(selectedDay));
  const rows: Row[] = item ? Object.entries(item).map(([key, value]) => ({ key, value, unit: key === 'position' || key === 'size' ? 'm' : key === 'rotation' ? '°' : key === 'power_w' ? 'W' : '' })) : [];
  function changeDay(next: number) { if (sync) { onDay(next); onPlaying(false); } else { setDay(next); setPlaying(false); } }
  return <aside className="inspector object-inspection" aria-label="Object inspection">
    <div className="inspector-title"><div><span className="eyebrow">INSPECT · READ ONLY</span><h2>{item?.name || 'Object inspector'}</h2></div>
      <button className="icon-button" aria-label="Close inspection" onClick={onClose}><X size={18} /></button></div>
    {!item ? <div className="inspector-body">{candidates.length ? <>
      <p className="muted">This older simulation stores plants as one combined model. Choose a plant to inspect its saved properties and daily metrics. Plants nearer your click are listed first; the mesh cannot identify which plant owns the clicked surface.</p>
      <label className="text-field">Find a plant<input type="search" aria-label="Find a plant to inspect" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Name or reporting ID" /></label>
      <div className="inspection-candidates" aria-label="Choose a plant to inspect">{candidates.map(candidate=>config.planting.plants.find(p=>p.id===candidate)).filter(p=>p && [p.name,p.role,String(p.reporting_id ?? '')].some(value=>value.toLowerCase().includes(search.toLowerCase()))).map(p=>p && <button className="button" key={p.id} onClick={()=>{setSearch('');onSelect?.(p.id);}}><span>{p.name}</span><small>{p.role}{p.reporting_id !== null ? ` · #${p.reporting_id}` : ''}</small></button>)}</div>
      <p className="hint">Full individual 3D inspection requires a simulation created with adapter v3.</p>
    </> : <p className="muted">Select an individual object in the scene or object list to inspect its model and properties.</p>}</div> : <>
      <InspectionModel item={item} config={config} runId={simulation ? run?.id : undefined} day={selectedDay} growth={growth} onManifest={setManifest} />
      {plant && simulation && <div className="inspection-timeline" aria-label="Plant timeline">
        <div><button className="play-button" aria-label={(sync ? mainPlaying : playing) ? 'Pause plant playback' : 'Play plant playback'} disabled={days.length < 2} onClick={() => { if (sync) onPlaying(!mainPlaying); else setPlaying(!playing); }}>{(sync ? mainPlaying : playing) ? <Pause size={14} /> : <Play size={14} />}</button>
          <strong>Day {days.length ? selectedDay : '—'}</strong><span>{days.length} days available</span></div>
        <input aria-label="Inspected plant day" type="range" min={0} max={Math.max(days.length - 1, 1)} step={1} disabled={!days.length} value={Math.max(0, days.indexOf(selectedDay))} onChange={e => changeDay(days[Number(e.target.value)])} />
        <label className="toggle-row">Sync with simulation<input type="checkbox" checked={sync} onChange={e => { setDay(mainDay); setPlaying(false); setSync(e.target.checked); }} /></label>
      </div>}
      <div className="inspector-body">
        {!simulation && plant && <p className="hint">Placement preview. Daily growth inspection is available in Simulation after running this configuration.</p>}
        {simulation && plant && !metadata && !error && <p role="status" className="hint">Loading inspection information…</p>}
        {error && <p className="field-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
        {simulation && plant && metadata && !growth && <p className="hint">{!plant.enabled ? 'This plant was disabled in this run.' : !days.length ? 'Daily snapshots will appear as the simulation runs.' : 'Individual geometry and full daily state are unavailable for this day. Older runs require a new simulation for full inspection.'}</p>}
        {plant?.role === 'border' && <p className="hint">{sourcePlant ? `Visual clone of ${sourcePlant.name}. Plant state and metrics below are shared with that source, not independently simulated.` : 'Border plants are visual clones. Independent growth and light metrics are not recorded.'}</p>}
        <input type="search" aria-label="Search inspection properties" placeholder="Search properties and parameters…" value={search} onChange={e => setSearch(e.target.value)} />
        <Properties title="Object properties" rows={rows} search={search} open />
        {plant && simulation && metric && <Properties title={plant.role === 'border' ? 'Source daily metrics' : 'Daily metrics'} search={search} open rows={Object.entries(metric).map(([key, value]) => ({ key, value, unit: ({biomass_g:'g',fruit_g:'g',leaf_area_m2:'m²',par_umol_s:'µmol/s',par_mmol_day:'mmol/day',carbon_mmol_day:'mmol/day',model_age_days:'days'} as Record<string,string>)[key] }))} />}
        {plant && state && [...new Set(metadata?.fields.map(f => f.group))].map(group => <Properties key={group} title={`Plant state · ${group}`} search={search} rows={(metadata?.fields || []).filter(f => f.group === group).map(f => ({ key: f.key, value: state[f.key] ?? null, unit: f.unit }))} />)}
        {plant && metadata && <><Properties title="Resolved model inputs" search={search} rows={metadata.parameters.map(p => ({ key: p.key, label: p.label, value: p.value, unit: p.unit }))} />
          <Properties title={simulation ? 'Saved simulation settings' : 'Draft simulation settings'} search={search} rows={Object.entries(config.simulation).map(([key,value])=>({key,value}))} />
          <Properties title="Daily temperatures" search={search} rows={metadata.temperatures.map((value, i) => ({ key: `Day ${i+1}`, value, unit: '°C' }))} />
          {!metadata.inputs_available && <p className="hint">Input source files are unavailable in this run snapshot.</p>}</>}
        {item && !isPlant(item) && item.kind === 'led' && <Properties title="Shared lighting" search={search} rows={[{key:'photoperiod',value:config.simulation.photoperiod,unit:'h/day'},...config.spectrum.map(p => ({key:`${p.wavelength} nm`,value:p.amplitude}))]} />}
      </div>
    </>}
    <div className="inspector-footer">Inspection does not change the scene or saved simulation.</div>
  </aside>;
}
