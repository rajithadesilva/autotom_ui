import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Box, Check, ChevronRight, CircleStop, Clock3, Code2, Layers3, Leaf, Lightbulb, LoaderCircle, Move3D, Undo2, Redo2, Scan, Pause, Play, Rotate3D, Save, Settings2, Sprout, Terminal, X } from 'lucide-react';
import Scene from './Scene';
import Inspector, { type Pane } from './Inspector';
import useHistory from './useHistory';
import SceneList from './SceneList';
import { itemsOf, isPlant, applyPoses, sceneError, type Pose } from './editor';
import Charts from './Charts';
import { api, artifactUrl, type Config, type ConfigResponse, type DailyResult, type Health, type Run, type Vec3 } from './types';

export default function App() {
  const [project, setProject] = useState<ConfigResponse | null>(null);
  const history = useHistory();
  const config = history.value;
  const setConfig = history.set;
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [pane, setPane] = useState<Pane | null>('lights');
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<'preview' | 'result'>('preview');
  const [pivot,setPivot] = useState<Vec3 | undefined>();
  const updatePivot=useCallback((next:Vec3)=>setPivot(current=>current&&current.every((n,i)=>Math.abs(n-next[i])<1e-10)?current:next),[]);
  const [tool,setTool] = useState<'orbit'|'box'>('orbit');
  const [mode, setMode] = useState<'translate' | 'rotate'>('translate');
  const [day, setDay] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [showRoom, setShowRoom] = useState(true);
  const [data, setData] = useState<DailyResult[]>([]);
  const [plant, setPlant] = useState('mean');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState('');
  const [runName, setRunName] = useState('Tomato growth experiment');
  const restored = useRef(false);
  const dirty = Boolean(config && project && JSON.stringify(config) !== JSON.stringify(project.config));
  const days = run?.available_days || [];
  const terminal = !run || ['completed', 'failed', 'cancelled'].includes(run.status);
  const hasResult = view === 'result' && Boolean(run && days.includes(day));

  const loadProject = useCallback(async () => {
    const p = await api<ConfigResponse>('/config');
    setProject(p); history.reset(p.config); setSelected([]); setError('');
    return p;
  }, []);

  useEffect(() => {
    loadProject().catch(e => setError(e.message));
    async function refresh() {
      try {
        const [h, r] = await Promise.all([api<Health>('/health'), api<Run[]>('/runs')]);
        setHealth(h); setRuns(r);
        if (!restored.current) {
          restored.current = true;
          const id = localStorage.getItem('autotom-selected-run');
          if (id && r.some(item => item.id === id)) {
            const previous = await api<Run>(`/runs/${id}`);
            setRun(previous); setDay(previous.available_days?.at(-1) || 1); setView('result');
          }
        }
      } catch (e) { setError((e as Error).message); }
    }
    refresh(); const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [loadProject]);

  useEffect(() => {
    if (!run?.id) return;
    const source = new EventSource(`/api/runs/${run.id}/events`);
    source.onmessage = event => {
      const next: Run = JSON.parse(event.data);
      setRun(next);
      if (['completed', 'failed', 'cancelled'].includes(next.status)) source.close();
      setDay(value => next.available_days?.includes(value) ? value : next.available_days?.[0] || 1);
    };
    source.onerror = () => { /* EventSource reconnects automatically; HTTP polling updates worker health. */ };
    return () => source.close();
  }, [run?.id]);

  useEffect(() => {
    if (!run) { setData([]); return; }
    let active = true;
    api<DailyResult[]>(`/runs/${run.id}/metrics`).then(d => { if (active) setData(d); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [run?.id, run?.current_day]);

  useEffect(() => {
    if (!logOpen || !run) return;
    let active = true;
    const refresh = () => api<{ text: string }>(`/runs/${run.id}/logs`).then(r => { if (active) setLogs(r.text); }).catch(e => { if (active) setLogs(e.message); });
    refresh(); const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [logOpen, run?.id]);

  useEffect(() => {
    if (!playing || days.length < 2) return;
    const timer = setInterval(() => setDay(value => days[(days.indexOf(value) + 1) % days.length]), 900);
    return () => clearInterval(timer);
  }, [playing, days.join(',')]);

  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); } };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [dirty]);

  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save(): Promise<ConfigResponse> {
    const p = await api<ConfigResponse>('/config', { method: 'PUT', body: JSON.stringify({ revision: project!.revision, config }) });
    setProject(p); history.sync(p.config); return p;
  }
  function selectRun(id: string) {
    action(async () => {
      const next = await api<Run>(`/runs/${id}`);
      localStorage.setItem('autotom-selected-run', id);
      setRun(next); setData([]); setDay(next.available_days?.at(-1) || 1); setPlant('mean'); setPlaying(false); setView('result');
    });
  }
  function changeConfig(next: Config) {
    const message=sceneError(next);
    if(message) {setError(message);return;}
    setError('');setConfig(next);
  }
  const selectObjects = useCallback((ids: string[], additive=false) => {
    setSelected(previous=>additive ? ids.reduce((next,id)=>next.includes(id)?next.filter(i=>i!==id):[...next,id],previous) : ids);
    if(ids.length===1) {
      const item=config&&itemsOf(config).find(i=>i.id===ids[0]);
      if(item) setPane(isPlant(item)?'plants':item.kind==='led'?'lights':'surroundings');
    } else if(ids.length>1) setPane(current=>current==='parameters'||current==='simulation'||!current?'surroundings':current);
  }, [config]);
  function selectScene(ids:string[],additive=false,expandGroups=true) {
    const expanded=expandGroups?[...new Set(ids.flatMap(id=>config?.groups.find(g=>g.members.includes(id))?.members||[id]))]:ids;
    selectObjects(expanded,additive);
  }
  function transformObjects(poses: Pose[]) {
    if(config) {const next=applyPoses(config,poses);const message=sceneError(next);if(message) {setError(message);history.sync({...config});} else changeConfig(next);}
  }
  useEffect(()=>{
    if(!config)return;
    const ids=new Set(itemsOf(config).map(i=>i.id));
    setSelected(previous=>previous.every(id=>ids.has(id))?previous:previous.filter(id=>ids.has(id)));
  },[config]);
  useEffect(()=>{
    function key(event:KeyboardEvent) {
      if((event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]'))return;
      if(event.key==='Escape') {setSelected([]);setTool('orbit');}
      if(view!=='preview')return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z') {event.preventDefault();event.shiftKey?history.redo():history.undo();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y') {event.preventDefault();history.redo();}
    }
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[view]);

  if (!config || !project) return <div className="loading-screen"><Sprout size={40} /><h1>AutoTom</h1>
    {error ? <><p role="alert">{error}</p><button className="button" onClick={() => loadProject().catch(e => setError(e.message))}>Retry connection</button></> : <p>Opening your simulation workspace…</p>}</div>;

  const displayConfig = view === 'result' && run ? run.config : config;
  return <div className="app-shell" onFocusCapture={e=>{if((e.target as HTMLElement).matches('input,select,textarea'))history.begin();}}
    onBlurCapture={e=>{if((e.target as HTMLElement).matches('input,select,textarea'))history.end();}}
    onPointerDownCapture={e=>{if((e.target as HTMLElement).closest('.spectrum,input[type="range"]'))history.begin();}}
    onPointerUpCapture={e=>{if((e.target as HTMLElement).closest('.spectrum,input[type="range"]'))history.end();}} onPointerCancelCapture={()=>history.end()}>
    <header className="topbar"><a className="brand" href="/" aria-label="AutoTom home"><div className="brand-mark"><Sprout size={24} /></div><span>AutoTom<span className="brand-tag">GROWTH LAB</span></span></a>
      <div className="breadcrumb">Workspace <ChevronRight size={12} /><span>Dwarf tomato</span></div>
      <div className="topbar-right"><span className={`connection ${health?.worker.ready ? '' : 'offline'}`} title={health?.worker.gpu || health?.worker.error || undefined}><span className="status-dot" />{health?.worker.ready ? 'NVIDIA connected' : 'GPU unavailable'}</span>
        <button className="button save-button" disabled={busy || (!project.installed || project.adapter?.compatible===false) || !dirty} onClick={() => action(async () => { await save(); setNotice('Configuration saved to host model files.'); })}><Save size={15} />{dirty ? 'Save changes' : 'Saved'}</button></div>
    </header>

    {(error || notice) && <div className={`notification ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span>
      <div>{error.includes('Reload') || error.includes('changed') ? <button onClick={() => action(async () => { await loadProject(); setNotice('Reloaded configuration from host files.'); })}>Reload host files</button> : null}
        <button className="icon-button" aria-label="Dismiss notification" onClick={() => { setError(''); setNotice(''); }}><X size={16} /></button></div></div>}
    {(!project.installed || project.adapter?.upgrade_available) && <div className="setup-banner"><Code2 size={18} /><div><strong>{project.installed?'Upgrade your model adapter':'Connect your GroIMP model'}</strong><span>Install the adapter to enable scene editing and daily exports. Original files are backed up in your host model folder.</span></div>
      <button className="button primary" disabled={busy} onClick={() => action(async () => { const p = await api<ConfigResponse>('/setup', { method: 'POST' }); setProject(p); if(dirty) history.sync(config); else history.reset(p.config); setNotice('Model adapter installed. Original files are backed up.'); })}>{project.installed?'Upgrade model adapter':'Install model adapter'}</button></div>}

    <div className="workspace-heading"><div><span className="eyebrow">FUNCTIONAL–STRUCTURAL PLANT MODEL</span><h1>Simulation workspace</h1><p>Shape the environment. Explore how your plants grow.</p>
      <select className="compact-run-select" aria-label="Saved runs" value={run?.id || ''} onChange={e => { if (e.target.value) selectRun(e.target.value); }}>
        <option value="">Select a saved run</option>{runs.map(r => <option key={r.id} value={r.id}>{r.name} · {r.status}</option>)}</select></div>
      <div className="run-controls"><input aria-label="Run name" className="run-name" value={runName} maxLength={100} onChange={e => setRunName(e.target.value)} />
        <button className="button primary run-button" disabled={busy || (!project.installed || project.adapter?.compatible===false) || !health?.worker.ready} onClick={() => action(async () => {
          const p = dirty ? await save() : project;
          const next = await api<Run>('/runs', { method: 'POST', body: JSON.stringify({ revision: p.revision, name: runName || 'Tomato simulation' }) });
          localStorage.setItem('autotom-selected-run', next.id);
          setRun({ ...next, available_days: [] }); setData([]); setDay(1); setPlaying(false); setView('result');
          setRuns(current => [next, ...current]); setNotice('Simulation queued. Each completed day will become available automatically.');
        })}>{busy ? <LoaderCircle size={16} className="spin" /> : <Play size={15} fill="currentColor" />}Run simulation</button></div></div>

    <div className={`workspace ${pane ? 'with-inspector' : ''}`}>
      <aside className="left-sidebar"><div className="sidebar-section"><div className="sidebar-title"><Layers3 size={14} /><h2>Scene objects</h2><span>{itemsOf(config).length}</span></div>
        <SceneList config={config} selected={selected} onSelect={(ids,additive)=>{setView('preview');selectObjects(ids,additive);}} /></div>
        <div className="sidebar-section runs-sidebar"><div className="sidebar-title"><Clock3 size={14} /><h2>Saved runs</h2><span>{runs.length}</span></div>
          {!runs.length ? <div className="no-runs"><Sprout size={24} /><p>No simulations yet</p><span>Your runs stay here after restarting Docker.</span></div> : <div className="run-list">{runs.map(r => <button key={r.id} className={`run-row ${run?.id === r.id ? 'selected' : ''}`} onClick={() => selectRun(r.id)}>
            <span className={`run-status-dot ${r.status}`} /><div><strong>{r.name}</strong><span>{new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {r.current_day}/{r.days} days</span></div>
            {r.status === 'completed' && <Check size={12} />}</button>)}</div>}
        </div>
        <div className="model-credit"><Leaf size={16} /><div><strong>Micro-Tom</strong><span>GroIMP 2.2 · spectral Flux</span></div><a href="https://github.com/Micbut/FSP-model-dwarf-tomato" target="_blank" rel="noreferrer" aria-label="Open original model repository">↗</a></div>
      </aside>

      <main className="main-panel"><div className="viewport-topbar"><div className="view-tabs"><button className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}>Scene editor</button>
        <button className={view === 'result' ? 'active' : ''} disabled={!run} onClick={() => setView('result')}>Simulation result</button></div>
        <div className="config-buttons">{([['lights', Lightbulb, 'Lights'], ['surroundings', Box, 'Surroundings'], ['plants', Sprout, 'Plants'], ['parameters', Leaf, 'Model parameters'], ['simulation', Settings2, 'Simulation']] as const).map(([key, Icon, label]) =>
          <button key={key} aria-label={label} title={label} className={`config-button ${pane === key ? 'active' : ''}`} onClick={() => { setPane(pane === key ? null : key); if (pane !== key) setView('preview'); }}><Icon size={14} /><span>{label}</span></button>)}</div></div>
        <div className="viewport"><Scene config={displayConfig} selected={selected} mode={mode} tool={tool} readOnly={view==='result'} result={hasResult && run ? { run: run.id, day } : null} showRoom={showRoom} onSelect={selectScene} onTransform={transformObjects} onPivot={updatePivot} />
          <div className="viewport-label"><span className="status-dot" />{hasResult ? `SIMULATION · DAY ${day}` : view === 'result' && run ? 'AWAITING DAILY OUTPUT' : 'ENVIRONMENT PREVIEW'}
            <small>{hasResult ? run?.name : `${config.planting.plants.filter(p=>p.enabled&&p.role==='central').length} central plants · Z-up`}</small></div>
          {view === 'preview' && <div className="viewport-tools"><button className={mode === 'translate' ? 'active' : ''} aria-label="Translate selection" title="Move object" onClick={() => {setTool('orbit');setMode('translate');}}><Move3D size={17} /></button>
            <button className={mode === 'rotate' ? 'active' : ''} aria-label="Rotate selection" title="Rotate object" onClick={() => {setTool('orbit');setMode('rotate');}}><Rotate3D size={17} /></button>
            <button className={tool==='box'?'active':''} aria-label="Box selection" title="Box selection" onClick={()=>setTool(tool==='box'?'orbit':'box')}><Scan size={17}/></button>
            <button aria-label="Undo" title="Undo (Ctrl/Cmd Z)" disabled={!history.canUndo} onClick={history.undo}><Undo2 size={17}/></button>
            <button aria-label="Redo" title="Redo (Ctrl/Cmd Shift Z)" disabled={!history.canRedo} onClick={history.redo}><Redo2 size={17}/></button></div>}
          <div className="viewport-legend"><span className="legend-dot plants" />{hasResult ? 'Simulated plants' : 'Plant positions'}<span className="legend-dot lamps" />LED emitters</div>
          <label className="room-toggle"><input type="checkbox" checked={showRoom} onChange={e => setShowRoom(e.target.checked)} />Room outline</label>
        </div>
        <div className="timeline"><button className="play-button" aria-label={playing ? 'Pause daily playback' : 'Play daily playback'} disabled={days.length < 2} onClick={() => { setView('result'); setPlaying(!playing); }}>{playing ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}</button>
          <div className="timeline-day"><strong>Day {days.length ? day : '—'}</strong><span>{days.length ? `of ${run?.days}` : 'No outputs yet'}</span></div>
          <div className="timeline-range"><input aria-label="Simulation day" type="range" min={0} max={Math.max(days.length - 1, 1)} step={1} value={Math.max(0, days.indexOf(day))} disabled={!days.length}
            onChange={e => { setDay(days[Number(e.target.value)]); setView('result'); setPlaying(false); }} />
            <div><span>{days.length ? `Day ${days[0]}` : 'Start'}</span><span>{days.length ? `${days.length} days available` : 'Daily snapshots appear as the model runs'}</span><span>{run ? `Day ${run.days}` : 'Harvest'}</span></div></div>
          <span className="daily-badge">1 DAY / FRAME</span></div>
        {run && <div className="run-progress"><span className={`run-status-dot ${run.status}`} /><strong>{run.status === 'running' ? 'Simulating' : run.status[0].toUpperCase() + run.status.slice(1)}</strong>
          <span>{run.current_day} / {run.days} days</span><progress max={run.days} value={run.current_day} aria-label="Simulation progress" />
          <button className="text-button" onClick={() => setLogOpen(true)}><Terminal size={13} />Log</button>
          {!terminal && <button className="text-button danger" disabled={run.cancel_requested || busy} onClick={() => action(async () => { setRun(await api<Run>(`/runs/${run.id}/cancel`, { method: 'POST' })); })}><CircleStop size={13} />{run.cancel_requested ? 'Cancelling…' : 'Cancel'}</button>}
          {days.includes(day) && <a className="text-button" href={artifactUrl(run.id, `days/${String(day).padStart(4, '0')}/scene.zip`)} download><ArrowDownToLine size={13} />OBJ + MTL</a>}
          {run.raw_available && <a className="text-button" href={artifactUrl(run.id, 'raw.zip')} download><ArrowDownToLine size={13} />CSV</a>}</div>}
        {run?.error && <div className="run-error" role="alert">{run.error}<button className="text-button" onClick={() => setLogOpen(true)}>Open log</button></div>}
      </main>
      {pane && <div className={`inspector-wrapper ${view==='result'?'read-only':''}`}><fieldset disabled={view==='result'}><Inspector key={pane} pane={pane} config={config} pivot={pivot} revision={project.revision} selected={selected} inputs={project.inputs} onChange={changeConfig} onSelect={ids=>selectObjects(ids)} onClose={() => setPane(null)} /></fieldset></div>}
    </div>
    <Charts names={Object.fromEntries((run?.config.planting?.plants||[]).filter(p=>p.role==='central').map(p=>[p.reporting_id,p.name]))} data={data} day={day} plant={plant} onPlant={setPlant} onDay={n => { if (days.includes(n)) { setDay(n); setView('result'); setPlaying(false); } }} />
    <footer className="page-footer"><span><span className="status-dot" /> Host files persist outside Docker</span><span>Results use saved run snapshots · {hasResult ? 'Real GroIMP output' : 'Editor preview'}</span></footer>
    {logOpen && <div className="modal-backdrop" onClick={() => setLogOpen(false)}><section role="dialog" aria-modal="true" aria-label="Simulation log" className="log-modal" onClick={e => e.stopPropagation()}>
      <header><div><Terminal size={18} /><h2>Simulation log</h2></div><button className="icon-button" aria-label="Close simulation log" onClick={() => setLogOpen(false)}><X size={20} /></button></header>
      <pre>{logs || 'Loading log…'}</pre><footer>Last 64 KB · updates every 2 seconds</footer></section></div>}
  </div>;
}
