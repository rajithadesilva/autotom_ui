import { useEffect, useRef, useState } from 'react';
import { Copy, Lightbulb, Plus, Trash2, X } from 'lucide-react';
import type { Config, SceneObject, Vec3 } from './types';

export type Pane = 'lights' | 'surroundings' | 'simulation';
function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function NumberField({ label, value, unit, onChange, min, max, step = 0.01, disabled = false }:
  { label: string; value: number; unit?: string; onChange: (n: number) => void; min?: number; max?: number; step?: number; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const focus = useRef(false);
  useEffect(() => { if (!focus.current) setDraft(String(Number(value.toFixed(6)))); }, [value]);
  function commit() {
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) {
      if (n !== value) onChange(n);
    }
    setDraft(String(Number(value.toFixed(6))));
  }
  return <label className="number-field"><span>{label}</span><div className="input-unit"><input type="number" aria-label={label}
    value={draft} min={min} max={max} step={step} disabled={disabled}
    onFocus={() => { focus.current = true; }} onChange={e => {
      setDraft(e.target.value);
      const n = e.currentTarget.valueAsNumber;
      if (Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
    }}
    onBlur={() => { focus.current = false; commit(); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    {unit && <small>{unit}</small>}</div></label>;
}

type Props = { pane: Pane; config: Config; selected: string | null; inputs: Record<string, string[]>;
  onChange: (config: Config) => void; onSelect: (id: string | null) => void; onClose: () => void; };

export default function Inspector({ pane, config, selected, inputs, onChange, onSelect, onClose }: Props) {
  const object = config.objects.find(o => o.id === selected);
  function updateObject(patch: Partial<SceneObject>) {
    onChange({ ...config, objects: config.objects.map(o => o.id === selected ? { ...o, ...patch } : o) });
  }
  function add(kind: SceneObject['kind']) {
    const id = newId();
    const obj: SceneObject = { id, name: `${kind === 'led' ? 'LED' : kind === 'panel' ? 'Reflector' : 'Obstacle'} ${config.objects.filter(o => o.kind === kind).length + 1}`,
      kind, position: [config.room.width / 2, config.room.length / 2, kind === 'led' ? config.room.height - 0.01 : 0.3],
      rotation: kind === 'led' ? [180, 0, 0] : [0, 0, 0],
      size: kind === 'panel' ? [0.5, 0.3, 0.01] : [0.2, 0.2, 0.3], power_w: 43.8, reflectance: 0.5, enabled: true };
    onChange({ ...config, objects: [...config.objects, obj] }); onSelect(id);
  }
  const updateSim = (patch: Partial<Config['simulation']>) => onChange({ ...config, simulation: { ...config.simulation, ...patch } });
  const updateRoom = (patch: Partial<Config['room']>) => onChange({ ...config, room: { ...config.room, ...patch } });
  const titles = { lights: 'Lighting', surroundings: 'Surroundings', simulation: 'Simulation' };
  return <aside className="inspector" aria-label={`${titles[pane]} configuration`}>
    <div className="inspector-title"><div><span className="eyebrow">CONFIGURATION</span><h2>{titles[pane]}</h2></div>
      <button className="icon-button" aria-label="Close configuration" onClick={onClose}><X size={18} /></button></div>
    <div className="inspector-body">
      {pane === 'lights' && <>
        <p className="muted">Place spectral emitters in the scene. Arrows show the emission direction.</p>
        <button className="button wide" onClick={() => add('led')}><Plus size={15} /> Add LED</button>
        <NumberField label="Photoperiod" value={config.simulation.photoperiod} unit="h/day" min={0.01} max={24} step={0.5} onChange={n => updateSim({ photoperiod: n })} />
        <section className="inspector-section"><h3>Shared emission spectrum</h3><Spectrum config={config} onChange={onChange} />
          <p className="hint">Drag the curve or edit a sample. Relative amplitudes; each LED’s power sets its total output.</p></section>
      </>}
      {pane === 'surroundings' && <>
        <p className="muted">Objects participate in GroIMP’s spectral ray tracing.</p>
        <div className="button-row"><button className="button" onClick={() => add('box')}><Plus size={15} /> Box</button>
          <button className="button" onClick={() => add('panel')}><Plus size={15} /> Reflector</button></div>
        <section className="inspector-section"><h3>Growing room</h3>
          <label className="toggle-row">Enclose the room<input type="checkbox" checked={config.room.enabled} onChange={e => updateRoom({ enabled: e.target.checked })} /></label>
          {(['width', 'length', 'height'] as const).map(key => <NumberField key={key} label={`Room ${key}`} value={config.room[key]} unit="m" min={0.01} max={100} onChange={n => updateRoom({ [key]: n })} />)}
          {(['wall', 'floor', 'ceiling'] as const).map(surface => {
            const key = `${surface}_reflectance` as const;
            return <div className="reflectance" key={key}><label className="toggle-row">{surface[0].toUpperCase() + surface.slice(1)} reflectance
              <input aria-label={`Override ${surface} reflectance`} type="checkbox" checked={config.room[key] !== null}
                onChange={e => updateRoom({ [key]: e.target.checked ? 0.5 : null })} /></label>
              {config.room[key] === null ? <span className="hint">Original spectral properties</span> : <div className="range-row"><input type="range" aria-label={`${surface} reflectance`} min="0" max="1" step="0.01"
                value={config.room[key]!} onChange={e => updateRoom({ [key]: Number(e.target.value) })} /><span>{Math.round(config.room[key]! * 100)}%</span></div>}</div>;
          })}
        </section>
      </>}
      {pane !== 'simulation' && <section className="inspector-section"><h3>Selected object</h3>
        {!object ? <div className="empty-selection"><Lightbulb size={22} /><p>Select an object in the scene or object list to edit its properties.</p></div> : <>
          <label className="text-field">Name<input aria-label="Object name" value={object.name} maxLength={80} onChange={e => updateObject({ name: e.target.value })} /></label>
          <label className="toggle-row">Enabled<input type="checkbox" checked={object.enabled} onChange={e => updateObject({ enabled: e.target.checked })} /></label>
          {(['position', 'rotation'] as const).map(key => <div key={key}><h4>{key === 'position' ? 'Position · metres' : 'Rotation · degrees'}</h4><div className="vector-fields">
            {['X', 'Y', 'Z'].map((axis, i) => <NumberField key={axis} label={`${key} ${axis}`} value={object[key][i]} step={key === 'rotation' ? 1 : 0.01}
              min={key === 'rotation' ? -360 : -100} max={key === 'rotation' ? 360 : 100} onChange={n => { const v = [...object[key]] as Vec3; v[i] = n; updateObject({ [key]: v }); }} />)}</div></div>)}
          {object.kind === 'led' ? <NumberField label="Emitted power" value={object.power_w} unit="W" min={0} max={10000} step={0.1} onChange={n => updateObject({ power_w: n })} /> : <>
            <h4>Size · metres</h4><div className="vector-fields">{['X', 'Y', 'Z'].map((axis, i) => <NumberField key={axis} label={`Size ${axis}`} value={object.size[i]} min={0.001} max={100} step={0.01}
              onChange={n => { const v = [...object.size] as Vec3; v[i] = n; updateObject({ size: v }); }} />)}</div>
            <NumberField label="Reflectance" value={object.reflectance} min={0} max={1} step={0.01} onChange={n => updateObject({ reflectance: n })} />
          </>}
          <div className="button-row"><button className="button" onClick={() => {
            const id = newId(); onChange({ ...config, objects: [...config.objects, { ...object, id, name: `${object.name} copy`, position: [object.position[0] + 0.1, object.position[1], object.position[2]] }] }); onSelect(id);
          }}><Copy size={14} /> Duplicate</button>
            <button className="button danger" onClick={() => { onChange({ ...config, objects: config.objects.filter(o => o.id !== selected) }); onSelect(null); }}><Trash2 size={14} /> Delete</button></div>
        </>}
      </section>}
      {pane === 'simulation' && <>
        <p className="muted">Each run uses a saved snapshot. Lighting and surroundings stay fixed throughout the run.</p>
        <NumberField label="Duration" value={config.simulation.days} unit="days" min={1} max={365} step={1} onChange={n => updateSim({ days: Math.round(n) })} />
        <section className="inspector-section"><h3>Planting layout</h3>
          <NumberField label="Rows" value={config.simulation.rows} min={1} max={20} step={1} onChange={n => updateSim({ rows: Math.round(n) })} />
          <NumberField label="Plants per row" value={config.simulation.plants_per_row} min={1} max={20} step={1} onChange={n => updateSim({ plants_per_row: Math.round(n) })} />
          <NumberField label="Plant density" value={config.simulation.density} unit="plants/m²" min={0.1} max={500} step={0.5} onChange={n => updateSim({ density: n })} />
          <NumberField label="Border rows" value={config.simulation.border_rows} min={0} max={10} step={1} onChange={n => updateSim({ border_rows: Math.round(n) })} />
          <NumberField label="Border plants per row" value={config.simulation.border_plants} min={0} max={10} step={1} onChange={n => updateSim({ border_plants: Math.round(n) })} />
          <p className="hint">Border plants affect light interception. Charts report the simulated central plants.</p>
        </section>
        <section className="inspector-section"><h3>Computation</h3>
          <NumberField label="Random seed" value={config.simulation.seed} min={0} max={2147483647} step={1} onChange={n => updateSim({ seed: Math.round(n) })} />
          <NumberField label="Rays per day" value={config.simulation.rays} min={1000} max={2147482999} step={100000} onChange={n => updateSim({ rays: Math.round(n) })} />
          <p className="hint">Reference setting: 21,474,000 rays. Lower values run faster with more sampling noise.</p>
        </section>
        <section className="inspector-section"><h3>Model input files</h3>
          {([['plant_input', 'dynamic_input', 'Plant architecture'], ['temperature_input', 'temperature', 'Daily temperature'],
            ['emission_input', 'light_emission_pattern', 'Emission distribution'], ['spectrum_input', 'light_spectrum', 'Optical properties']] as const).map(([key, folder, label]) =>
            <label className="text-field" key={key}>{label}<select value={config.simulation[key]} onChange={e => updateSim({ [key]: e.target.value })}>
              {(inputs[folder] || []).map(file => <option key={file}>{file}</option>)}</select></label>)}
          <p className="hint">Files live in your host model’s input folder. The shared emission curve overrides the emission amplitudes in the optical input file.</p>
        </section>
      </>}
    </div>
    <div className="inspector-footer"><span className="status-dot" /> Changes apply to the next run</div>
  </aside>;
}

function Spectrum({ config, onChange }: { config: Config; onChange: (c: Config) => void }) {
  const [sample, setSample] = useState(0);
  const dragging = useRef(false), scale = useRef(1);
  const max = Math.max(...config.spectrum.map(p => p.amplitude), 0.01) * 1.15;
  const points = config.spectrum.map(p => `${(p.wavelength - 400) / 300 * 260 + 10},${90 - p.amplitude / max * 78}`).join(' ');
  function edit(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const wavelength = 400 + Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * 300;
    const index = config.spectrum.reduce((best, point, i) => Math.abs(point.wavelength - wavelength) < Math.abs(config.spectrum[best].wavelength - wavelength) ? i : best, 0);
    const amplitude = Math.max(0, Math.min(scale.current, (1 - (event.clientY - rect.top) / rect.height) * scale.current));
    setSample(index);
    onChange({ ...config, spectrum: config.spectrum.map((p, i) => i === index ? { ...p, amplitude } : p) });
  }
  return <><svg className="spectrum" viewBox="0 0 280 102" role="img" aria-label="Editable emission spectrum from 400 to 700 nanometres"
    onPointerDown={e => { dragging.current = true; scale.current = max; e.currentTarget.setPointerCapture(e.pointerId); edit(e); }}
    onPointerMove={e => { if (dragging.current) edit(e); }} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}>
    <defs><linearGradient id="spectrum-gradient"><stop offset="0%" stopColor="#8d8be5" /><stop offset="40%" stopColor="#9cbf98" /><stop offset="100%" stopColor="#e69386" /></linearGradient></defs>
    {[25, 50, 75].map(y => <line key={y} x1="10" x2="270" y1={y} y2={y} stroke="#344037" />)}
    <polygon points={`10,90 ${points} 270,90`} fill="url(#spectrum-gradient)" opacity="0.12" />
    <polyline points={points} fill="none" stroke="url(#spectrum-gradient)" strokeWidth="2" />
  </svg><div className="spectrum-labels"><span>400 nm</span><span>550 nm</span><span>700 nm</span></div>
    <div className="spectrum-sample"><label>Sample<select aria-label="Spectrum wavelength" value={sample} onChange={e => setSample(Number(e.target.value))}>
      {config.spectrum.map((p, i) => <option key={p.wavelength} value={i}>{p.wavelength} nm</option>)}</select></label>
      <NumberField label="Amplitude" value={config.spectrum[sample]?.amplitude || 0} min={0} max={1e6} step={0.001}
        onChange={amplitude => onChange({ ...config, spectrum: config.spectrum.map((p, i) => i === sample ? { ...p, amplitude } : p) })} /></div>
  </>;
}
