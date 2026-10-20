import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { artifactUrl, type InspectionDay } from './types';

export function disposeOwned(group: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  group.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      geometries.add(child.geometry);
      for (const mat of Array.isArray(child.material) ? child.material : [child.material]) {
        materials.add(mat);
        if ('map' in mat && mat.map instanceof THREE.Texture) textures.add(mat.map);
      }
    }
  });
  textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose()); geometries.forEach(g => g.dispose()); group.clear();
}

type Asset = { model: THREE.Group; manifest: InspectionDay | null; bytes: number };
type Entry = { promise: Promise<Asset>; controller: AbortController; refs: number; asset?: Asset };
const cache = new Map<string, Entry>();
function trim() {
  let bytes = [...cache.values()].reduce((n, e) => n + (e.asset?.bytes || 0), 0);
  for (const [key, entry] of cache) {
    if (entry.refs || (cache.size <= 2 && bytes <= 256 * 1024 * 1024)) continue;
    cache.delete(key); entry.controller.abort();
    if (entry.asset) { bytes -= entry.asset.bytes; disposeOwned(entry.asset.model); }
  }
}
async function load(run: string, day: number, signal: AbortSignal): Promise<Asset> {
  const base = artifactUrl(run, `days/${String(day).padStart(4, '0')}/`);
  const [response, manifestResponse] = await Promise.all([fetch(base + 'plants.obj', { signal }), fetch(base + 'inspection.json', { signal })]);
  if (!response.ok) throw new Error('Daily plant geometry is not available');
  if (!manifestResponse.ok && manifestResponse.status !== 404) throw new Error('Could not load plant identities');
  const manifest: InspectionDay | null = manifestResponse.ok ? await manifestResponse.json() : null;
  if (manifest && (manifest.version !== 1 || manifest.day !== day || !Array.isArray(manifest.instances))) throw new Error('Unsupported daily inspection data');
  const text = await response.text(), loader = new OBJLoader();
  const mtlFile = /^mtllib\s+(.+)$/m.exec(text)?.[1].trim();
  if (mtlFile) {
    if (mtlFile.includes('/') || mtlFile.includes('\\') || mtlFile.includes('..')) throw new Error('Invalid material filename in plant export');
    const materialResponse = await fetch(base + encodeURIComponent(mtlFile), { signal });
    if (!materialResponse.ok) throw new Error('Daily plant materials are not available');
    loader.setMaterials(new MTLLoader().parse(await materialResponse.text(), base));
  }
  signal.throwIfAborted();
  const raw = loader.parse(text), model = new THREE.Group();
  let bytes = 0;
  raw.traverse(child => {
    if (child instanceof THREE.Mesh) {
      for (const value of Object.values(child.geometry.attributes) as THREE.BufferAttribute[]) bytes += value.array.byteLength;
      for (const mat of Array.isArray(child.material) ? child.material : [child.material]) mat.side = THREE.DoubleSide;
    }
  });
  try {
    if (!manifest) model.add(raw);
    else {
      const sources = new Map<string, THREE.Object3D>();
      for (const item of manifest.instances.filter(i => i.id === i.source_id)) {
        const mesh = raw.getObjectByName(item.geometry);
        if (!mesh) throw new Error('Plant identity is missing from daily geometry');
        const inverse = new THREE.Matrix4().fromArray(item.matrix).transpose().invert();
        mesh.traverse(child => { if (child instanceof THREE.Mesh) child.geometry.applyMatrix4(inverse); });
        sources.set(item.id, mesh);
      }
      for (const item of manifest.instances) {
        const source = sources.get(item.source_id);
        if (!source) throw new Error('Clone source is missing from daily geometry');
        const instance = new THREE.Group();
        instance.userData.id = item.id; instance.name = item.id;
        instance.add(source.clone(true));
        instance.applyMatrix4(new THREE.Matrix4().fromArray(item.matrix).transpose());
        model.add(instance);
      }
    }
    return { model, manifest, bytes };
  } catch (error) { disposeOwned(raw); throw error; }
}

// Consumers clone only the object graph; cache entries own the shared GPU resources.
export async function acquireDaily(run: string, day: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const key = `${run}/${day}`;
  let entry = cache.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, refs: 0, promise: Promise.resolve(null as unknown as Asset) };
    const current = entry;
    current.promise = load(run, day, controller.signal).then(asset => {
      if (controller.signal.aborted) { disposeOwned(asset.model); throw new DOMException('Aborted', 'AbortError'); }
      current.asset = asset; trim(); return asset;
    }).catch(error => { if (cache.get(key) === current) cache.delete(key); throw error; });
    cache.set(key, current);
  }
  cache.delete(key); cache.set(key, entry); entry.refs++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true; entry.refs--;
    signal.removeEventListener('abort', release);
    if (!entry.refs && !entry.asset) { if (cache.get(key) === entry) cache.delete(key); entry.controller.abort(); }
    trim();
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    const asset = await entry.promise;
    signal.throwIfAborted();
    return { ...asset, release };
  } catch (error) { release(); throw error; }
}
