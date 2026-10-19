import { useEffect, useState } from 'react';
import { api, type Config, type InputPreview, type Parameter } from './types';
import { NumberField } from './Inspector';

function ArrayField({spec,value,onChange}: {spec:Parameter;value:number[];onChange:(v:number[])=>void}) {
  const [text,setText]=useState(value.join('; ')),[error,setError]=useState('');
  useEffect(()=>setText(value.join('; ')),[JSON.stringify(value)]);
  function commit() {
    const parts=text.split(/[;,]/).map(s=>s.trim());const values=parts.map(Number);
    if(parts.some(s=>!s)||values.length!==spec.length||values.some(n=>!Number.isFinite(n)||n<0||n>1)||Math.abs(values.reduce((a,b)=>a+b,0)-1)>1e-5) {
      setError(`Enter ${spec.length} proportions totalling 1.`);return;
    }
    setError('');onChange(values);
  }
  return <label className="text-field">{spec.label}<input aria-label={spec.label} aria-invalid={Boolean(error)} value={text} onChange={e=>setText(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}} />{error&&<span className="field-error" role="alert">{error}</span>}</label>;
}
export default function ParameterEditor({config,revision,onChange}: {config:Config;revision:string;onChange:(c:Config)=>void}) {
  const [data,setData]=useState<InputPreview|null>(null),[error,setError]=useState(''),[query,setQuery]=useState('');
  const [selected,setSelected]=useState<number[]>([]),[fill,setFill]=useState(20);
  useEffect(()=>{
    const controller=new AbortController();setData(null);setError('');
    api<InputPreview>('/inputs/preview',{method:'POST',signal:controller.signal,body:JSON.stringify({plant_input:config.simulation.plant_input,temperature_input:config.simulation.temperature_input})})
      .then(next=>{if(!controller.signal.aborted)setData(next);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[config.simulation.plant_input,config.simulation.temperature_input,revision]);
  function change(key:string,value: number|boolean|number[]) {onChange({...config,parameter_overrides:{...config.parameter_overrides,[key]:value}});}
  function reset(keys:string[]) {onChange({...config,parameter_overrides:Object.fromEntries(Object.entries(config.parameter_overrides).filter(([key])=>!keys.includes(key)))});}
  if(error) return <p role="alert" className="field-error">{error}</p>;
  if(!data) return <p className="hint">Loading source input values…</p>;
  if(data.revision!==revision) return <p role="alert" className="field-error">Model files changed. Reload host files before editing inputs.</p>;
  const parameters=data.parameters.filter(p=>`${p.label} ${p.key} ${p.description||''}`.toLowerCase().includes(query.toLowerCase()));
  const days=Math.min(365,Math.max(config.simulation.days,data.temperatures.length,...Object.keys(config.temperature_overrides).map(key=>Number(key)+1)));
  const temperature=(day:number)=>config.temperature_overrides[day]??data.temperatures[day];
  function updateTemperatures(patch:Record<string,number>) {onChange({...config,temperature_overrides:{...config.temperature_overrides,...patch}});}
  return <><p className="muted">Shared by all simulated plants. Values come from the selected input files; overrides are saved with this experiment.</p>
    <label className="text-field">Search parameters<input aria-label="Search model parameters" type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>
    <button className="button wide" disabled={!Object.keys(config.parameter_overrides).length} onClick={()=>reset(Object.keys(config.parameter_overrides))}>Reset all parameters</button>
    {[...new Set(parameters.map(p=>p.group))].map(group=><details key={group} className="parameter-section" open={query?true:undefined}><summary>{group}</summary>
      <button className="text-button" onClick={()=>reset(data.parameters.filter(p=>p.group===group).map(p=>p.key))}>Reset {group}</button>
      {parameters.filter(p=>p.group===group).map(spec=>{
        const value=config.parameter_overrides[spec.key]??spec.value;
        const overridden=spec.key in config.parameter_overrides;
        return <div key={spec.key} className={`parameter-entry ${overridden?'overridden':''}`} title={spec.description||spec.key}>
          {spec.type==='boolean'?<label className="toggle-row">{spec.label}<input aria-label={spec.label} type="checkbox" checked={Boolean(value)} onChange={e=>change(spec.key,e.target.checked)} /></label>
          : spec.type==='array'?<ArrayField spec={spec} value={value as number[]} onChange={v=>change(spec.key,v)} />
          : <NumberField precise label={spec.label} value={value as number} unit={spec.unit||undefined} min={spec.min} max={spec.max} step={spec.type==='integer'?1:.001} onChange={n=>change(spec.key,spec.type==='integer'?Math.round(n):n)} />}
          <div className="parameter-source"><span>Source: {Array.isArray(spec.value)?spec.value.join('; '):String(spec.value)} {spec.unit}</span><button disabled={!overridden} className="text-button" aria-label={`Reset ${spec.label}`} onClick={()=>reset([spec.key])}>Reset</button></div>
        </div>;
      })}
    </details>)}
    <section className="inspector-section"><h3>Daily temperature · °C</h3><p className="hint">Day 1 corresponds to model day 0. Edits beyond the run duration are retained.</p>
      <label className="toggle-row">Select all days<input aria-label="Select all temperature days" type="checkbox" checked={selected.length===days} onChange={e=>setSelected(e.target.checked?Array.from({length:days},(_,i)=>i):[])} /></label>
      <NumberField label="Fill temperature" value={fill} unit="°C" onChange={setFill} />
      <div className="button-row"><button className="button" disabled={!selected.length} onClick={()=>updateTemperatures(Object.fromEntries(selected.map(day=>[day,fill])))}>Fill selected days</button>
        <button className="button" disabled={!Object.keys(config.temperature_overrides).length} onClick={()=>onChange({...config,temperature_overrides:{}})}>Reset temperatures</button></div>
      <div className="temperature-table">{Array.from({length:days},(_,day)=><div className="temperature-row" key={day}>
        <input aria-label={`Select temperature day ${day+1}`} type="checkbox" checked={selected.includes(day)} onChange={e=>setSelected(e.target.checked?[...selected,day]:selected.filter(i=>i!==day))} />
        {temperature(day)===undefined?<label className="number-field">Day {day+1}<input type="number" aria-label={`Temperature day ${day+1}`} placeholder="Required" onBlur={e=>{if(Number.isFinite(e.currentTarget.valueAsNumber))updateTemperatures({[day]:e.currentTarget.valueAsNumber});}} /></label>
          :<NumberField precise label={`Temperature day ${day+1}`} value={temperature(day)} onChange={n=>updateTemperatures({[day]:n})} />}
        <button className="text-button" disabled={!(day in config.temperature_overrides)} aria-label={`Reset temperature day ${day+1}`} onClick={()=>onChange({...config,temperature_overrides:Object.fromEntries(Object.entries(config.temperature_overrides).filter(([key])=>key!==String(day)))})}>↶</button>
      </div>)}</div>
    </section></>;
}
