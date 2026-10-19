import { useState } from 'react';
import * as THREE from 'three';
import type { Config, SceneObject, Vec3 } from './types';
import { applyPoses, duplicate, isPlant, itemsOf, newId, tidy, transformPoses, type Item } from './editor';
import { NumberField } from './Inspector';

type Props = { config: Config; selected: string[]; pivot?: Vec3; onChange: (c: Config) => void; onSelect: (ids: string[]) => void };
export default function SelectionEditor({ config, selected, pivot, onChange, onSelect }: Props) {
  const [target,setTarget]=useState('');
  const items=itemsOf(config).filter(i=>selected.includes(i.id));
  const object=items.length===1 ? items[0] : null;
  const wholeGroup=config.groups.find(g=>g.members.length===selected.length && g.members.every(id=>selected.includes(id)));
  function update(patch: Partial<Item>) {
    onChange({ ...config, objects:config.objects.map(o=>selected.includes(o.id) ? { ...o,...patch } as SceneObject : o),
      planting: { ...config.planting, mode:items.some(isPlant)?'custom':config.planting.mode,
        plants:config.planting.plants.map(p=>selected.includes(p.id) ? { ...p,...patch } as typeof p : p) } });
  }
  function remove() {
    const next=tidy({ ...config, objects:config.objects.filter(i=>!selected.includes(i.id)),
      planting: { ...config.planting,mode:'custom',plants:config.planting.plants.filter(i=>!selected.includes(i.id)) } });
    onChange(next); // Selection is pruned by the workspace only after the change is accepted.
  }
  function move(axis: number,n: number) {
    const center=pivot ? new THREE.Vector3(...pivot) : new THREE.Box3().setFromPoints(items.map(i=>new THREE.Vector3(...i.position))).getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(); offset.setComponent(axis,n-center.getComponent(axis));
    onChange(applyPoses(config,transformPoses(items,center,new THREE.Matrix4().makeTranslation(...offset.toArray() as Vec3))));
  }
  function rotate(axis: number,n: number) {
    const center=pivot ? new THREE.Vector3(...pivot) : new THREE.Box3().setFromPoints(items.map(i=>new THREE.Vector3(...i.position))).getCenter(new THREE.Vector3());
    const vector=new THREE.Vector3(); vector.setComponent(axis,1);
    onChange(applyPoses(config,transformPoses(items,center,new THREE.Matrix4().makeRotationAxis(vector,THREE.MathUtils.degToRad(n)))));
  }
  if (!items.length) return <section className="inspector-section"><h3>Selection</h3><p className="hint">Select scene items or use list checkboxes. Shift/Ctrl/Cmd-click toggles selection. Use the box tool to select an area.</p></section>;
  const center=pivot ? new THREE.Vector3(...pivot) : new THREE.Box3().setFromPoints(items.map(i=>new THREE.Vector3(...i.position))).getCenter(new THREE.Vector3());
  return <section className="inspector-section" aria-label="Selection properties"><h3>{object ? 'Selected object' : `${items.length} selected items`}</h3>
    {wholeGroup && <label className="text-field">Group name<input aria-label="Group name" value={wholeGroup.name} maxLength={80}
      onChange={e=>onChange({ ...config,groups:config.groups.map(g=>g.id===wholeGroup.id?{ ...g,name:e.target.value }:g) })} /></label>}
    {object && <label className="text-field">Name<input aria-label="Object name" value={object.name} maxLength={80} onChange={e=>update({name:e.target.value})} /></label>}
    <label className="toggle-row">Enabled<input aria-label="Selection enabled" type="checkbox" checked={items.every(i=>i.enabled)} onChange={e=>update({enabled:e.target.checked})} /></label>
    <h4>Position · metres</h4><div className="vector-fields">{['X','Y','Z'].map((axis,i)=><NumberField key={axis} label={`position ${axis}`} min={-100} max={100} value={object?object.position[i]:center.getComponent(i)} onChange={n=>{
      if (object) { const position=[...object.position] as Vec3; position[i]=n; update({position}); } else move(i,n);
    }} />)}</div>
    {object ? <><h4>Rotation · degrees</h4><div className="vector-fields">{['X','Y','Z'].map((axis,i)=><NumberField key={axis} label={`rotation ${axis}`} min={-360} max={360} step={1} value={object.rotation[i]} disabled={isPlant(object)&&i<2} onChange={n=>{const rotation=[...object.rotation] as Vec3;rotation[i]=n;update({rotation});}} />)}</div>
      {isPlant(object) ? <><p className="hint">{object.role==='central'?`Reporting ID ${object.reporting_id}`:'Border clone · excluded from reporting'}. Rotation offsets the seeded plant orientation.</p>
        <label className="text-field">Plant role<select aria-label="Plant role" value={object.role} onChange={e=>{
          const role=e.target.value as 'central'|'border'; const next=config.planting.next_reporting_id;
          onChange({ ...config,planting:{ ...config.planting,mode:'custom',next_reporting_id:role==='central'?next+1:next,
            plants:config.planting.plants.map(p=>p.id===object.id?{...p,role,reporting_id:role==='central'?next:null}:p) } });
        }}><option value="central">Simulated central plant</option><option value="border">Border clone</option></select></label></>
      : object.kind==='led' ? <NumberField label="Emitted power" value={object.power_w} min={0} max={10000} unit="W" onChange={power_w=>update({power_w})} />
      : <><h4>Size · metres</h4><div className="vector-fields">{['X','Y','Z'].map((axis,i)=><NumberField key={axis} label={`Size ${axis}`} value={object.size[i]} min={.001} max={100} onChange={n=>{const size=[...object.size] as Vec3;size[i]=n;update({size});}} />)}</div>
        <NumberField label="Reflectance" value={object.reflectance} min={0} max={1} onChange={reflectance=>update({reflectance})} /></>}
    </> : <><h4>Rotate selection · degrees around centre</h4><div className="vector-fields">{['X','Y','Z'].map((axis,i)=><label key={axis} className="text-field">{axis}<input aria-label={`Rotate selection ${axis}`} type="number" defaultValue="0" min={-360} max={360} disabled={i<2&&items.some(isPlant)} onBlur={e=>{const n=e.currentTarget.valueAsNumber;if(Number.isFinite(n)&&Math.abs(n)<=360&&n!==0) rotate(i,n);e.currentTarget.value='0';}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}} /></label>)}</div></>}
    <div className="button-row"><button className="button" onClick={()=>{const result=duplicate(config,selected);onChange(result.config);onSelect(result.selected);}}>Duplicate</button>
      <button className="button danger" onClick={remove}>Delete</button></div>
    <h4>Groups</h4>
    <div className="button-row"><button className="button" disabled={items.length<2 || Boolean(wholeGroup)} onClick={()=>{
      const group={id:newId(),name:`Group ${config.groups.length+1}`,members:selected};
      onChange(tidy({...config,groups:[...config.groups.map(g=>({...g,members:g.members.filter(id=>!selected.includes(id))})),group]}));
    }}>Create group</button>
      <button className="button" disabled={!wholeGroup} onClick={()=>onChange({...config,groups:config.groups.filter(g=>g.id!==wholeGroup?.id)})}>Ungroup</button></div>
    {config.groups.length>0&&<><label className="text-field">Target group<select aria-label="Target group" value={target} onChange={e=>setTarget(e.target.value)}><option value="">Choose group</option>{config.groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
      <div className="button-row"><button className="button" disabled={!config.groups.some(g=>g.id===target)} onClick={()=>onChange(tidy({...config,groups:config.groups.map(g=>({...g,members:g.id===target?[...new Set([...g.members,...selected])]:g.members.filter(id=>!selected.includes(id))}))}))}>Add to group</button>
        <button className="button" onClick={()=>onChange(tidy({...config,groups:config.groups.map(g=>({...g,members:g.members.filter(id=>!selected.includes(id))}))}))}>Remove from group</button></div></>}
  </section>;
}
