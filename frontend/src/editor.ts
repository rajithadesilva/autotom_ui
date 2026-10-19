import * as THREE from 'three';
import type { Config, Plant, SceneObject, Vec3 } from './types';
export type Item = SceneObject | Plant;
export type Pose = { id: string; position: Vec3; rotation: Vec3 };
export const newId = () => crypto.randomUUID().replaceAll('-', '');
export const itemsOf = (config: Config): Item[] => [...config.objects, ...(config.planting?.plants || [])];
export const isPlant = (item: Item): item is Plant => 'role' in item;
export function tidy(config: Config): Config {
  const ids = new Set(itemsOf(config).map(i => i.id));
  return { ...config, groups: config.groups.map(g => ({ ...g, members: g.members.filter(id => ids.has(id)) })).filter(g => g.members.length >= 2) };
}
export function sceneError(config: Config): string | null {
  const plants = config.planting.plants.filter(p => p.enabled);
  if (!plants.some(p => p.role === 'central')) return 'Keep at least one enabled central plant.';
  if (plants.filter(p => p.role === 'central').length > 100 || plants.filter(p => p.role === 'border').length > 1000) return 'Limit: 100 enabled central plants and 1,000 border clones.';
  if (config.objects.length > 200 || config.planting.plants.length > 2000) return 'The scene item limit has been reached.';
  for (const item of itemsOf(config)) {
    if (item.position.some(n => !Number.isFinite(n) || Math.abs(n) > 100) || item.rotation.some(n => !Number.isFinite(n) || Math.abs(n) > 360)) return 'All coordinates must be within ±100 m and rotations within ±360°.';
    if (isPlant(item) && (Math.abs(item.rotation[0]) > 1e-6 || Math.abs(item.rotation[1]) > 1e-6)) return 'Plants must stay upright.';
  }
  return null;
}
export function applyPoses(config: Config, poses: Pose[]): Config {
  const updates = new Map(poses.map(p => [p.id, p]));
  return { ...config, objects: config.objects.map(o => ({ ...o, ...updates.get(o.id) })),
    planting: { ...config.planting, mode: poses.some(p => config.planting.plants.some(i => i.id === p.id)) ? 'custom' : config.planting.mode,
      plants: config.planting.plants.map(p => ({ ...p, ...updates.get(p.id) })) } };
}
export function transformPoses(items: Item[], pivot: THREE.Vector3, delta: THREE.Matrix4): Pose[] {
  return items.map(item => {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...item.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...item.rotation.map(THREE.MathUtils.degToRad) as Vec3, 'XYZ')), new THREE.Vector3(1,1,1));
    matrix.premultiply(new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
    matrix.premultiply(delta);
    matrix.premultiply(new THREE.Matrix4().makeTranslation(pivot.x,pivot.y,pivot.z));
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    matrix.decompose(position,rotation,scale);
    const euler = new THREE.Euler().setFromQuaternion(rotation,'XYZ');
    const angles = [euler.x,euler.y,euler.z].map(THREE.MathUtils.radToDeg) as Vec3;
    if (isPlant(item)) { angles[0]=0; angles[1]=0; }
    return { id: item.id, position: position.toArray() as Vec3, rotation: angles };
  });
}
export function duplicate(config: Config, selected: string[]): { config: Config; selected: string[] } {
  const remap = new Map(selected.map(id => [id,newId()]));
  let next = config.planting.next_reporting_id;
  const clones = itemsOf(config).filter(i => remap.has(i.id)).map(i => ({ ...i, id: remap.get(i.id)!, name: `${i.name.slice(0,75)} copy`,
    position: [i.position[0]+.1,i.position[1],i.position[2]] as Vec3,
    ...(isPlant(i) && i.role === 'central' ? { reporting_id: next++ } : {}) }));
  return { config: { ...config, objects: [...config.objects,...clones.filter(i => !isPlant(i)) as SceneObject[]],
    planting: { ...config.planting, mode: 'custom', next_reporting_id: next, plants: [...config.planting.plants,...clones.filter(isPlant)] },
    groups: [...config.groups,...config.groups.filter(g => g.members.every(id => remap.has(id))).map(g => ({ id:newId(), name:`${g.name.slice(0,75)} copy`, members:g.members.map(id => remap.get(id)!) }))] },
    selected: [...remap.values()] };
}
