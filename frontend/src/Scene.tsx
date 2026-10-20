import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Config, SceneObject, Vec3 } from './types';
import { acquireDaily } from './geometry';
import { itemsOf, isPlant, transformPoses, type Pose, type Item } from './editor';

type Props = {
  config: Config; selected: string[]; mode: 'translate' | 'rotate'; tool: 'orbit' | 'box'; readOnly: boolean;
  result: { run: string; day: number } | null; showRoom: boolean;
  inspecting?: boolean; inspectedId?: string | null;
  onInspectionCandidates?: (ids: string[]) => void;
  onSelect: (ids: string[], additive?: boolean, expandGroups?: boolean) => void;
  onTransform: (poses: Pose[]) => void;
  onPivot: (pivot: Vec3) => void;
};
type Context = {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer;
  orbit: OrbitControls; transform: TransformControls; world: THREE.Group;
  objects: Map<string, THREE.Group>; result: THREE.Group; helper: THREE.BoxHelper; pivot: THREE.Group; outlines: THREE.Group;
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

export function makeObject(obj: SceneObject): THREE.Group {
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

function roomPreview(config: Config, showRoom: boolean) {
  const group = new THREE.Group();
  const { width: w, length: l, height: h } = config.room;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, l), material('#394a40', 0.7));
  floor.position.set(w / 2, l / 2, -0.002);
  group.add(floor);
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, l, h)),
    new THREE.LineBasicMaterial({ color: '#6d8271', transparent: true, opacity: 0.5 }));
  frame.position.set(w / 2, l / 2, h / 2);
  if (showRoom && config.room.enabled) group.add(frame);
  return group;
}

export function makePlant(plant: Config['planting']['plants'][number], config: Config, arrowVisible = true) {
  const group = new THREE.Group();
  group.userData.id = plant.id;
  group.position.fromArray(plant.position);
  group.rotation.z = THREE.MathUtils.degToRad(plant.rotation[2]);
  group.visible = plant.enabled;
  const width = Number(config.parameter_overrides.rockwool_width ?? .1);
  const height = Number(config.parameter_overrides.rockwool_height ?? .065);
  const block = new THREE.Mesh(new THREE.BoxGeometry(width,width,height),material(plant.role === 'border' ? '#897c58' : '#7aab64'));
  block.position.z = height/2;
  group.add(block);
  if (arrowVisible) group.add(new THREE.ArrowHelper(new THREE.Vector3(1,0,0),new THREE.Vector3(0,0,height+.01),width*.7,plant.role === 'border' ? 0xc4a66a : 0xb8e68b,.025,.015));
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
  const [resultReady, setResultReady] = useState(0);
  const [identifiedResult, setIdentifiedResult] = useState(false);
  const [box, setBox] = useState<{x: number; y: number; width: number; height: number} | null>(null);

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
    const world = new THREE.Group(), result = new THREE.Group(), pivot = new THREE.Group(), outlines = new THREE.Group();
    const helper = new THREE.BoxHelper(new THREE.Object3D(), 0xb7e68b);
    helper.visible = false;
    scene.add(world, result, helper, pivot, outlines);
    scene.add(new THREE.HemisphereLight(0xf0f4df, 0x364f3c, 2.5));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(-2, -3, 6);
    scene.add(key);
    const grid = new THREE.GridHelper(6, 60, 0x3b4c41, 0x24342b);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(0.6, 0.6, -0.006);
    scene.add(grid);
    const objects = new Map<string, THREE.Group>();
    ctx.current = { scene, camera, renderer, orbit, transform, world, objects, result, helper, pivot, outlines };
    const resize = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    });
    resize.observe(element);
    let dragging = false;
    let before: Item[] = [], center = new THREE.Vector3();
    function delta() { pivot.updateMatrixWorld(true); return new THREE.Matrix4().makeTranslation(-center.x,-center.y,-center.z).multiply(pivot.matrixWorld); }
    function previewTransform() {
      for (const pose of transformPoses(before,center,delta())) {
        const object = objects.get(pose.id);
        if (object) { object.position.fromArray(pose.position); object.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as Vec3,'XYZ'); }
      }
    }
    transform.addEventListener('objectChange', previewTransform);
    transform.addEventListener('dragging-changed', event => {
      dragging = Boolean(event.value);
      orbit.enabled = !event.value && (propsRef.current.tool === 'orbit' || Boolean(propsRef.current.inspecting));
      if (event.value) {
        center.copy(pivot.position);
        before = itemsOf(propsRef.current.config).filter(i => propsRef.current.selected.includes(i.id));
      } else if (before.length) {
        propsRef.current.onTransform(transformPoses(before,center,delta()));
        before=[];
      }
    });
    const pointer = new THREE.Vector2(), ray = new THREE.Raycaster();
    ray.params.Line.threshold = 0.005;
    let down = [0, 0], boxing = false, ignoreUp = false;
    const pointerDown = (event: PointerEvent) => {
      down = [event.clientX, event.clientY]; ignoreUp=false;
      if (event.button !== 0 || propsRef.current.readOnly || propsRef.current.inspecting) return;
      if (propsRef.current.tool === 'box') {
        boxing=true;
        renderer.domElement.setPointerCapture(event.pointerId);
        const rect = element.getBoundingClientRect();
        setBox({ x:event.clientX-rect.left,y:event.clientY-rect.top,width:0,height:0 });
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (!boxing) return;
      const rect = element.getBoundingClientRect();
      setBox({ x:Math.min(down[0],event.clientX)-rect.left, y:Math.min(down[1],event.clientY)-rect.top,
        width:Math.abs(event.clientX-down[0]),height:Math.abs(event.clientY-down[1]) });
    };
    const click = (event: PointerEvent) => {
      if (event.button !== 0 || (propsRef.current.readOnly && !propsRef.current.inspecting) || ignoreUp) return;
      const rect = element.getBoundingClientRect();
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (boxing) {
        boxing=false; setBox(null);
        const left=Math.min(down[0],event.clientX),right=Math.max(down[0],event.clientX),top=Math.min(down[1],event.clientY),bottom=Math.max(down[1],event.clientY);
        const ids: string[]=[];
        for (const [id,object] of objects) {
          const point=object.getWorldPosition(new THREE.Vector3()).project(camera);
          const x=rect.left+(point.x+1)/2*rect.width,y=rect.top+(1-point.y)/2*rect.height;
          if (object.visible && point.z>=-1 && point.z<=1 && x>=left && x<=right && y>=top && y<=bottom) ids.push(id);
        }
        propsRef.current.onSelect(ids,additive,false);
        return;
      }
      if (dragging || (!propsRef.current.inspecting && transform.axis) || Math.hypot(event.clientX-down[0],event.clientY-down[1])>4) return;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      ray.setFromCamera(pointer, camera);
      const targets: THREE.Object3D[] = [...objects.values()];
      if (propsRef.current.inspecting) targets.push(...result.children);
      const hits = ray.intersectObjects(targets.filter(o => o.visible), true);
      const hit = hits[0];
      let object: THREE.Object3D | null = hit?.object ?? null;
      let resultHit = false;
      // Older exports have no per-plant identity. A mesh hit must still open
      // inspection, but proximity must not silently become an asserted identity.
      for (let node: THREE.Object3D | null = object; node; node = node.parent) {
        if (node === result) { resultHit = true; break; }
      }
      while (object && !object.userData.id) object = object.parent;
      if (!object && hit && resultHit && propsRef.current.inspecting && propsRef.current.onInspectionCandidates) {
        const candidates = propsRef.current.config.planting.plants.filter(p => p.enabled)
          .map(p => ({ id: p.id, distance: (p.position[0]-hit.point.x)**2 + (p.position[1]-hit.point.y)**2 }))
          .sort((a,b) => a.distance-b.distance).map(p => p.id);
        propsRef.current.onInspectionCandidates(candidates);
        return;
      }
      propsRef.current.onSelect(object ? [object.userData.id] : [], propsRef.current.inspecting ? false : additive, !propsRef.current.inspecting);
    };
    const cancel = () => { boxing=false; setBox(null); };
    const escapeBox = (event:KeyboardEvent) => {if(event.key==='Escape'&&boxing) {ignoreUp=true;cancel();}};
    window.addEventListener('keydown',escapeBox);
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', click);
    renderer.domElement.addEventListener('pointermove',pointerMove);
    renderer.domElement.addEventListener('pointercancel',cancel);
    let animation = 0;
    const render = () => {
      animation = requestAnimationFrame(render);
      orbit.update();
      for (const outline of outlines.children) {
        if (outline instanceof THREE.BoxHelper) outline.update();
      }
      renderer.render(scene, camera);
    };
    render();
    setReady(r => r + 1);
    return () => {
      cancelAnimationFrame(animation); resize.disconnect();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', click);
      renderer.domElement.removeEventListener('pointermove',pointerMove);
      renderer.domElement.removeEventListener('pointercancel',cancel);
      window.removeEventListener('keydown',escapeBox);
      result.clear(); transform.dispose(); orbit.dispose(); dispose(scene); renderer.dispose();
      renderer.domElement.remove(); ctx.current = null;
    };
  }, []);

  useEffect(() => {
    const context = ctx.current;
    if (!context) return;
    context.transform.detach(); context.helper.visible = false;
    dispose(context.world); context.objects.clear();
    context.world.add(roomPreview(props.config, props.showRoom));
    for (const object of itemsOf(props.config)) {
      if (isPlant(object) && props.readOnly && !identifiedResult) continue;
      const group = isPlant(object) ? makePlant(object,props.config,!props.readOnly) : makeObject(object);
      context.objects.set(object.id, group);
      context.world.add(group);
    }
  }, [props.config, props.showRoom, props.readOnly, identifiedResult, ready]);

  useEffect(() => {
    const context = ctx.current;
    if (!context) return;
    context.transform.setMode(props.mode);
    context.orbit.enabled = props.tool === 'orbit' || props.readOnly || Boolean(props.inspecting);
    dispose(context.outlines);
    const selected = props.selected.map(id => context.objects.get(id)).filter((i): i is THREE.Group => Boolean(i));
    const upright = props.config.planting.plants.some(p => props.selected.includes(p.id));
    context.transform.showX = !(props.mode === 'rotate' && upright);
    context.transform.showY = !(props.mode === 'rotate' && upright);
    context.transform.showZ = true;
    if (selected.length && !props.readOnly && !props.inspecting && props.tool !== 'box') {
      const bounds = new THREE.Box3();
      for (const object of selected) bounds.union(new THREE.Box3().setFromObject(object));
      bounds.getCenter(context.pivot.position); context.pivot.quaternion.identity();
      propsRef.current.onPivot(context.pivot.position.toArray() as Vec3);
      context.pivot.updateMatrixWorld(true);
      context.transform.attach(context.pivot);
    } else context.transform.detach();
    if (props.inspecting && props.inspectedId) {
      const object = context.result.getObjectByName(props.inspectedId) || context.objects.get(props.inspectedId);
      if (object?.visible) context.outlines.add(new THREE.BoxHelper(object,0xb7e68b));
    } else if (!props.readOnly) for (const object of selected.filter(o=>o.visible)) context.outlines.add(new THREE.BoxHelper(object,0xb7e68b));
  }, [props.selected, props.mode, props.config, props.readOnly, props.tool, props.inspecting, props.inspectedId, ready, resultReady]);

  useEffect(() => {
    const context = ctx.current;
    if (!context) return;
    context.result.clear(); setError(''); setIdentifiedResult(false); setResultReady(n => n + 1);
    if (!props.result) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    acquireDaily(props.result.run, props.result.day, controller.signal).then(asset => {
      if (controller.signal.aborted) return;
      context.result.add(asset.model.clone(true));
      setIdentifiedResult(Boolean(asset.manifest));
      setLoading(false); setResultReady(n => n + 1);
    }).catch(e => { if (!controller.signal.aborted) { setLoading(false); setError(e.message); } });
    return () => { context.result.clear(); controller.abort(); };
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
    {box && <div className="selection-box" style={{ left:box.x,top:box.y,width:box.width,height:box.height }} />}
    {(error || loading) && <div className={`scene-message ${error ? 'error' : ''}`} role="status">{error || 'Loading daily plant geometry…'}</div>}
    <div className="axis-label"><span className="x">X</span><span className="y">Y</span><span className="z">Z ↑</span><span>metres</span></div>
    <button className="fit-button" onClick={fit} disabled={loading}>{props.result ? 'Fit plants' : 'Fit scene'}</button>
  </div>;
}
