import { useState } from 'react';
import { api, type Config, type Plant, type Planting, type Vec3 } from './types';
import { newId, tidy } from './editor';
import { NumberField } from './Inspector';

export default function PlantEditor({config,onChange,onSelect}: {config:Config;onChange:(c:Config)=>void;onSelect:(ids:string[])=>void}) {
  const [draft,setDraft]=useState(()=>({...config.planting,center:[...config.planting.center] as Vec3}));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const sim=config.simulation;
  const updateSim=(patch:Partial<Config['simulation']>)=>onChange({...config,simulation:{...sim,...patch}});
  const counts=config.planting.plants.filter(p=>p.enabled);
  function add(role: Plant['role']) {
    const id=newId(),report=config.planting.next_reporting_id;
    const plant:Plant={id,name:role==='central'?`Plant ${report}`:`Border ${config.planting.plants.filter(p=>p.role==='border').length+1}`,role,
      reporting_id:role==='central'?report:null,position:[config.room.width/2,config.room.length/2,0],rotation:[0,0,0],enabled:true,row:1,col:1};
    onChange({...config,planting:{...config.planting,mode:'custom',plants:[...config.planting.plants,plant],next_reporting_id:role==='central'?report+1:report}});onSelect([id]);
  }
  return <><p className="muted">{counts.filter(p=>p.role==='central').length} simulated plants · {counts.filter(p=>p.role==='border').length} border clones · {config.planting.mode} layout</p>
    <div className="button-row"><button className="button" onClick={()=>add('central')}>Add plant</button><button className="button" onClick={()=>add('border')}>Add border</button></div>
    <section className="inspector-section"><h3>Layout generator</h3><p className="hint">Generate replaces plant placements and removes their group memberships. Undo restores the previous layout.</p>
      <label className="text-field">Pattern<select aria-label="Layout pattern" value={draft.pattern} onChange={e=>setDraft({...draft,pattern:e.target.value as 'grid'|'staggered'})}><option value="grid">Grid</option><option value="staggered">Staggered</option></select></label>
      <NumberField label="Rows" value={sim.rows} min={1} max={20} step={1} onChange={n=>updateSim({rows:Math.round(n)})} />
      <NumberField label="Plants per row" value={sim.plants_per_row} min={1} max={20} step={1} onChange={n=>updateSim({plants_per_row:Math.round(n)})} />
      <NumberField label="Plant density" value={sim.density} min={.1} max={500} unit="plants/m²" onChange={density=>updateSim({density})} />
      {(['plant_spacing','row_spacing'] as const).map(key=><div key={key}><label className="toggle-row">{key==='plant_spacing'?'Plant':'Row'} spacing from density<input aria-label={`${key} from density`} type="checkbox" checked={draft[key]===null} onChange={e=>setDraft({...draft,[key]:e.target.checked?null:1/Math.sqrt(sim.density)})} /></label>
        <NumberField label={key==='plant_spacing'?'Plant spacing':'Row spacing'} value={draft[key]??1/Math.sqrt(sim.density)} disabled={draft[key]===null} min={.001} max={100} unit="m" onChange={n=>setDraft({...draft,[key]:n})} /></div>)}
      <h4>Layout centre · ground level</h4><div className="vector-fields">{['X','Y','Z'].map((axis,i)=><NumberField key={axis} label={`Layout centre ${axis}`} value={draft.center[i]} min={-100} max={100} onChange={n=>{const center=[...draft.center] as Vec3;center[i]=n;setDraft({...draft,center});}} />)}</div>
      <NumberField label="Layout rotation" value={draft.rotation} min={-360} max={360} unit="°" onChange={rotation=>setDraft({...draft,rotation})} />
      <NumberField label="Border rows" value={sim.border_rows} min={0} max={10} step={1} onChange={n=>updateSim({border_rows:Math.round(n)})} />
      <NumberField label="Border plants per row" value={sim.border_plants} min={0} max={10} step={1} onChange={n=>updateSim({border_plants:Math.round(n)})} />
      <button className="button wide" disabled={busy} onClick={async()=>{setBusy(true);setError('');try {
        const planting=await api<Planting>('/layout/preview',{method:'POST',body:JSON.stringify({simulation:sim,room:config.room,pattern:draft.pattern,plant_spacing:draft.plant_spacing,row_spacing:draft.row_spacing,center:draft.center,rotation:draft.rotation})});
        let report=config.planting.next_reporting_id;
        planting.plants=planting.plants.map(p=>({...p,id:newId(),reporting_id:p.role==='central'?report++:null})); planting.next_reporting_id=report;
        onChange(tidy({...config,planting}));onSelect([]);
      } catch(e) {setError((e as Error).message);} finally {setBusy(false);}}}>{busy?'Generating…':'Generate layout'}</button>
      {error&&<p className="field-error" role="alert">{error}</p>}
      <p className="hint">Ground area: {(counts.filter(p=>p.role==='central').length/sim.density).toFixed(4)} m². Density sets model ground area; custom spacing changes physical placement.</p>
    </section></>;
}
