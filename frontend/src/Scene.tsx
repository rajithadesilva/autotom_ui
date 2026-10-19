import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import type { Config, SceneObject, Vec3 } from './types';
import { artifactUrl } from './types';

type Props = {
  config: Config; selected: string | null; mode: 'translate' | 'rotate';
  result: { run: string; day: number } | null; showRoom: boolean;
  onSelect: (id: string | null) => void;
  onTransform: (id: string, position: Vec3, rotation: Vec3) => void;
};
type Context = {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer;
  orbit: OrbitControls; transform: TransformControls; world: THREE.Group;
  objects: Map<string, THREE.Group>; result: THREE.Group; helper: THREE.BoxHelper;
};

function dispose(group: THREE.Object3D) {
  group.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if ('map' in mat && mat.map instanceof THREE.Texture) mat.map.dispose();
        mat.dispose();
      }
    }
  });
  group.clear();
}

function material(color: string, opacity = 1) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, transparent: opacity < 1, opacity,
    side: THREE.DoubleSide, depthWrite: opacity === 1 });
}

function makeObject(obj: SceneObject): THREE.Group {
  const group = new THREE.Group();
  group.userData.id = obj.id;
  group.position.fromArray(obj.position);
  group.rotation.set(...obj.rotation.map(THREE.MathUtils.degToRad) as Vec3, 'XYZ');
  group.visible = obj.enabled;
  if (obj.kind === 'led') {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 10), material('#e6cc82'));
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.13, 20, 1, true), material('#edd5a2', 0.18));
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = 0.08;
    group.add(body, cone);
    const direction = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.16, 0xe6cc82, 0.025, 0.014);
    group.add(direction);
  } else {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...obj.size), material(obj.kind === 'panel' ? '#c8cbb9' : '#8d9a8b'));
    group.add(mesh);
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: '#c2d0bb', transparent: true, opacity: 0.4 })));
  }
  return group;
}

function roomPreview(config: Config, showRoom: boolean, includePlants: boolean) {
  const group = new THREE.Group();
  const { width: w, length: l, height: h } = config.room;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, l), material('#394a40', 0.7));
  floor.position.set(w / 2, l / 2, -0.002);
  group.add(floor);
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, l, h)),
    new THREE.LineBasicMaterial({ color: '#6d8271', transparent: true, opacity: 0.5 }));
  frame.position.set(w / 2, l / 2, h / 2);
  if (showRoom && config.room.enabled) group.add(frame);
  if (includePlants) {
    const s = config.simulation;
    const spacing = 1 / Math.sqrt(s.density);
    for (let row = 0; row < s.rows; row++) {
      for (let col = 0; col < s.plants_per_row; col++) {
        const block = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.065), material('#7a8464'));
        block.position.set(w / 2 + (col - (s.plants_per_row - 1) / 2) * spacing,
          l / 2 + (row - (s.rows - 1) / 2) * spacing, 0.0325);
        group.add(block);
      }
    }
  }
  return group;
}

export default function Scene(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const ctx = useRef<Context | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(0);

  useEffect(() => {
    const element = container.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setError('WebGL is unavailable. Enable browser hardware acceleration to use the 3D viewer.'); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.005, 500);
    camera.up.set(0, 0, 1);
    camera.position.set(2.5, -2.8, 2.2);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.target.set(0.6, 0.6, 0.3);
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setSize(0.7);
    transform.setSpace('world');
    scene.add(transform.getHelper());
    const world = new THREE.Group(), result = new THREE.Group();
    const helper = new THREE.BoxHelper(new THREE.Object3D(), 0xb7e68b);
    helper.visible = false;
    scene.add(world, result, helper);
    scene.add(new THREE.HemisphereLight(0xf0f4df, 0x364f3c, 2.5));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(-2, -3, 6);
    scene.add(key);
    const grid = new THREE.GridHelper(6, 60, 0x3b4c41, 0x24342b);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(0.6, 0.6, -0.006);
    scene.add(grid);
    const objects = new Map<string, THREE.Group>();
    ctx.current = { scene, camera, renderer, orbit, transform, world, objects, result, helper };
    const resize = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    });
    resize.observe(element);
    let dragging = false;
    transform.addEventListener('dragging-changed', event => {
      orbit.enabled = !event.value;
      dragging = Boolean(event.value);
      if (!event.value && transform.object) {
        const obj = transform.object;
        const rot = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
        propsRef.current.onTransform(obj.userData.id, obj.position.toArray() as Vec3,
          [rot.x, rot.y, rot.z].map(THREE.MathUtils.radToDeg) as Vec3);
      }
    });
    const pointer = new THREE.Vector2(), ray = new THREE.Raycaster();
    let down = [0, 0];
    const pointerDown = (event: PointerEvent) => { down = [event.clientX, event.clientY]; };
    const click = (event: PointerEvent) => {
      if (dragging || transform.axis || propsRef.current.result || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
      const rect = element.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      ray.setFromCamera(pointer, camera);
      const hits = ray.intersectObjects([...objects.values()], true);
      let object: THREE.Object3D | null = hits[0]?.object ?? null;
      while (object && !object.userData.id) object = object.parent;
      propsRef.current.onSelect(object?.userData.id ?? null);
    };
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', click);
    let animation = 0;
    const render = () => {
      animation = requestAnimationFrame(render);
      orbit.update();
      if (helper.visible && transform.object) helper.setFromObject(transform.object);
      renderer.render(scene, camera);
    };
    render();
    setReady(r => r + 1);
    return () => {
      cancelAnimationFrame(animation); resize.disconnect();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', click);
      transform.dispose(); orbit.dispose(); dispose(scene); renderer.dispose();
      renderer.domElement.remove(); ctx.current = null;
    };
  }, []);

  useEffect(() => {
    const context = ctx.current;
    if (!context) return;
    context.transform.detach(); context.helper.visible = false;
    dispose(context.world); context.objects.clear();
    context.world.add(roomPreview(props.config, props.showRoom, !props.result));
    for (const object of props.config.objects) {
      const group = makeObject(object);
      context.objects.set(object.id, group);
      context.world.add(group);
    }
  }, [props.config, props.showRoom, Boolean(props.result), ready]);

  useEffect(() => {
    const context = ctx.current;
    if (!context) return;
    context.transform.setMode(props.mode);
    const selected = props.selected && context.objects.get(props.selected);
    if (selected && !props.result && selected.visible) {
      context.transform.attach(selected); context.helper.setFromObject(selected); context.helper.visible = true;
    } else { context.transform.detach(); context.helper.visible = false; }
  }, [props.selected, props.mode, props.config, props.result, ready]);

  useEffect(() => {
    const context = ctx.current;
    if (!context) return;
    dispose(context.result); setError('');
    if (!props.result) { setLoading(false); return; }
    let cancelled = false;
    const controller = new AbortController();
    const base = artifactUrl(props.result.run, `days/${String(props.result.day).padStart(4, '0')}/`);
    setLoading(true);
    (async () => {
      const response = await fetch(base + 'plants.obj', { signal: controller.signal });
      if (!response.ok) throw new Error('Daily plant geometry is not available');
      const text = await response.text();
      const loader = new OBJLoader();
      const mtlFile = /^mtllib\s+(.+)$/m.exec(text)?.[1].trim();
      if (mtlFile) {
        if (mtlFile.includes('/') || mtlFile.includes('\\') || mtlFile.includes('..')) throw new Error('Invalid material filename in plant export');
        const mtlResponse = await fetch(base + encodeURIComponent(mtlFile), { signal: controller.signal });
        if (mtlResponse.ok) {
          const materials = new MTLLoader().parse(await mtlResponse.text(), base);
          materials.preload(); loader.setMaterials(materials);
        }
      }
      const model = loader.parse(text);
      if (cancelled) { dispose(model); return; }
      model.traverse(child => {
        if (child instanceof THREE.Mesh) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => { mat.side = THREE.DoubleSide; });
        }
      });
      context.result.add(model);
      setLoading(false);
    })().catch(e => { if (!cancelled) { setLoading(false); setError(e.message); } });
    return () => { cancelled = true; controller.abort(); };
  }, [props.result?.run, props.result?.day, ready]);

  function fit() {
    const context = ctx.current;
    if (!context) return;
    if (props.result && context.result.children.length) {
      const bounds = new THREE.Box3().setFromObject(context.result);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const distance = Math.max(size.x, size.y, size.z, 0.05) * 2.2 * Math.max(1, 1 / context.camera.aspect);
      const direction = context.camera.position.clone().sub(context.orbit.target).normalize();
      context.orbit.target.copy(center);
      context.camera.position.copy(center).addScaledVector(direction, distance);
      context.orbit.update();
      return;
    }
    const { width, length, height } = props.config.room;
    const extent = Math.max(width, length, height, 0.5);
    context.orbit.target.set(width / 2, length / 2, height / 3);
    context.camera.position.set(width / 2 + extent * 1.4, length / 2 - extent * 1.8, extent * 1.5);
    context.orbit.update();
  }

  return <div className="scene" aria-label="3D scene viewer" ref={container}>
    {(error || loading) && <div className={`scene-message ${error ? 'error' : ''}`} role="status">{error || 'Loading daily plant geometry…'}</div>}
    <div className="axis-label"><span className="x">X</span><span className="y">Y</span><span className="z">Z ↑</span><span>metres</span></div>
    <button className="fit-button" onClick={fit} disabled={loading}>{props.result ? 'Fit plants' : 'Fit scene'}</button>
  </div>;
}
