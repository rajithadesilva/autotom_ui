import type { Config } from './types';
import { itemsOf, isPlant, type Item } from './editor';

export default function SceneList({config,selected,onSelect}: {config:Config;selected:string[];onSelect:(ids:string[],additive?:boolean)=>void}) {
  const items=itemsOf(config);
  const grouped=new Set(config.groups.flatMap(g=>g.members));
  function row(item: Item) {
    const checked=selected.includes(item.id);
    return <div key={item.id} className={`object-row ${checked?'selected':''} ${!item.enabled?'disabled-object':''}`} onClick={e=>onSelect([item.id],e.shiftKey||e.ctrlKey||e.metaKey)}>
      <input aria-label={`Select ${item.name}`} type="checkbox" checked={checked} onClick={e=>e.stopPropagation()} onChange={()=>onSelect([item.id],true)} />
      <button className="item-name" onClick={e=>{e.stopPropagation();onSelect([item.id],e.shiftKey||e.ctrlKey||e.metaKey);}}>{item.name}</button>
      <span className="object-type">{isPlant(item)?item.role:item.kind}</span>
    </div>;
  }
  return <div className="object-list" aria-label="Scene item selection">{config.groups.map(group=><details className="scene-group" key={group.id} open>
    <summary><button className={group.members.every(id=>selected.includes(id))?'selected':''} onClick={e=>{e.preventDefault();onSelect(group.members,e.shiftKey||e.ctrlKey||e.metaKey);}}>{group.name} · {group.members.length}</button></summary>
    {items.filter(i=>group.members.includes(i.id)).map(row)}
  </details>)}{items.filter(i=>!grouped.has(i.id)).map(row)}</div>;
}
