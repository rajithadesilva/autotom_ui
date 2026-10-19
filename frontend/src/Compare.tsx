import { useEffect, useMemo, useState } from 'react';
import { Activity, LoaderCircle } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { measures } from './Charts';
import { api, type DailyResult, type Run } from './types';

const colors = ['#b8e68b', '#9bbfee'];
const format = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('en', { maximumSignificantDigits: 4 }).format(value);
type Selection = [string, string];
type ComparisonRow = { day: number; a: number | null; b: number | null };

export default function Compare({ runs, selection, onSelection, preferredRun }: {
  runs: Run[]; selection: Selection; onSelection: (selection: Selection) => void; preferredRun?: string;
}) {
  const [reporting, setReporting] = useState<Selection>(['mean', 'mean']);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: DailyResult[][]; error?: string }>({ key: '' });
  const selectedRuns = selection.map(id => runs.find(run => run.id === id));
  const key = JSON.stringify(selection);
  const progress = JSON.stringify(selectedRuns.map(run => [run?.current_day, run?.status]));

  useEffect(() => {
    const first = runs.find(run => run.id === selection[0])?.id
      || runs.find(run => run.id === preferredRun)?.id || runs[0]?.id || '';
    const second = runs.find(run => run.id === selection[1] && run.id !== first)?.id
      || runs.find(run => run.id !== first)?.id || '';
    if (first !== selection[0] || second !== selection[1]) onSelection([first, second]);
  }, [runs, key, preferredRun, onSelection]);

  useEffect(() => { setReporting(['mean', 'mean']); }, [key]);

  useEffect(() => {
    if (!selection[0] || !selection[1] || selection[0] === selection[1]) return;
    const controller = new AbortController();
    setResult({ key });
    Promise.all(selection.map(id => api<DailyResult[]>(`/runs/${id}/metrics`, { signal: controller.signal })))
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, error: error.message }); });
    return () => controller.abort();
  }, [key, progress, retry]);

  const data = result.key === key ? result.data : undefined;
  const charts = useMemo(() => {
    if (!data) return [];
    const days = [...new Set(data.flatMap(run => run.map(result => result.day)))].sort((a, b) => a - b);
    const indexed = data.map(run => new Map(run.map(result => [result.day, result.plants])));
    return measures.map(measure => {
      const rows: ComparisonRow[] = days.map(day => {
        const values = indexed.map((run, index) => {
          const plants = (run.get(day) || []).filter(plant => reporting[index] === 'mean' || plant.plant === Number(reporting[index]));
          if (!plants.length) return null;
          const value = plants.reduce((sum, plant) => sum + plant[measure.key], 0) / plants.length;
          return Number.isFinite(value) ? value : null;
        });
        return { day, a: values[0], b: values[1] };
      });
      const shared = [...rows].reverse().find(row => row.a !== null && row.b !== null);
      return { ...measure, rows, shared };
    });
  }, [data, reporting]);

  const error = result.key === key ? result.error : undefined;
  const ready = Boolean(selectedRuns[0] && selectedRuns[1] && selection[0] !== selection[1]);
  return <section className="comparison-section" aria-label="Run comparison">
    <div className="section-heading"><div><span className="eyebrow">EXPERIMENT COMPARISON</span><h2>Compare two runs</h2></div></div>
    <p className="comparison-description">Compare daily growth, light interception and carbon assimilation using saved simulation results.</p>
    <div className="comparison-selectors">{selection.map((id, index) => {
      const run = selectedRuns[index];
      const ids = [...new Set((data?.[index] || []).flatMap(day => day.plants.map(plant => plant.plant)))].sort((a, b) => a - b);
      const names = Object.fromEntries((run?.config.planting?.plants || []).filter(plant => plant.role === 'central').map(plant => [plant.reporting_id, plant.name]));
      return <div className="comparison-run" key={index}>
        <label><span className={`comparison-series series-${index}`}>Run {index === 0 ? 'A' : 'B'}</span>
          <select aria-label={`Compare run ${index === 0 ? 'A' : 'B'}`} value={id} onChange={event => {
            const next: Selection = [...selection]; next[index] = event.target.value; onSelection(next);
          }}>
            <option value="">Select a run</option>{runs.map(run => <option key={run.id} value={run.id} disabled={run.id === selection[1 - index]}>
              {run.name} · {run.status} · {new Date(run.created_at).toLocaleString()} · {run.id.slice(0, 8)}
            </option>)}
          </select>
        </label>
        <label>Reporting<select aria-label={`Run ${index === 0 ? 'A' : 'B'} reporting`} value={reporting[index]} onChange={event => {
          const next: Selection = [...reporting]; next[index] = event.target.value; setReporting(next);
        }}><option value="mean">Mean per simulated plant</option>{ids.map(id => <option key={id} value={id}>{names[id] || `Plant ${id}`}</option>)}</select></label>
        <p>{run ? `${run.status} · ${data?.[index].length ?? '—'} daily results · ${run.days} planned days` : 'Choose a different run for each side.'}</p>
      </div>;
    })}</div>
    {!ready ? <div className="empty-charts"><Activity size={25} /><div><h3>Select two different runs</h3><p>{runs.length < 2 ? 'Create at least two simulation runs to compare their results.' : 'Choose run A and run B above to plot their results.'}</p></div></div>
      : error ? <div className="comparison-message" role="alert"><p>Could not load the comparison: {error}</p><button className="button" onClick={() => setRetry(value => value + 1)}>Retry comparison</button></div>
      : !data ? <div className="comparison-message" role="status"><LoaderCircle className="spin" size={20} />Loading run results…</div>
      : !data[0].length || !data[1].length ? <div className="empty-charts"><Activity size={25} /><div><h3>Waiting for daily results</h3><p>{!data[0].length && !data[1].length ? 'Both runs need' : `Run ${!data[0].length ? 'A' : 'B'} needs`} at least one published day to compare. Results update as simulations progress.</p></div></div>
      : <>
        <div className="comparison-legend"><span className="comparison-series series-0">A · {selectedRuns[0]?.name}</span><span className="comparison-series series-1">B · {selectedRuns[1]?.name}</span></div>
        <p className="comparison-description">Aligned by simulation day. Missing days remain gaps. Values and B − A differences use the latest day available in both reports.</p>
        <div className="comparison-grid">{charts.map(measure => {
          const a = measure.shared?.a ?? null, b = measure.shared?.b ?? null;
          const delta = a !== null && b !== null ? b - a : null;
          return <article className="chart-card comparison-chart" aria-label={`${measure.title} comparison`} key={measure.key}>
            <h3 className="chart-title">{measure.title}<span>{measure.unit}</span></h3>
            <dl className="comparison-values"><div><dt>Run A</dt><dd>{format(a)}</dd></div><div><dt>Run B</dt><dd>{format(b)}</dd></div><div><dt>B − A</dt><dd>{delta !== null && delta > 0 ? '+' : ''}{format(delta)}</dd></div></dl>
            <div className="chart-container"><ResponsiveContainer width="100%" height="100%">
              <LineChart data={measure.rows} margin={{ top: 10, right: 12, bottom: 15, left: 0 }}>
                <CartesianGrid vertical={false} stroke="#2c3930" strokeDasharray="3 4" />
                <XAxis dataKey="day" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} tick={{ fill: '#889a8b', fontSize: 10 }} axisLine={false} tickLine={false} label={{ value: 'Simulation day', position: 'bottom', fill: '#889a8b', fontSize: 10 }} />
                <YAxis width={55} tick={{ fill: '#889a8b', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={value => Number(value).toPrecision(2)} />
                <Tooltip contentStyle={{ background: '#1b2820', border: '1px solid #41513e', borderRadius: 8, color: '#e5ebdf', fontSize: 11 }} labelFormatter={day => `Day ${day}`} formatter={(value, name) => [`${format(Number(value))} ${measure.unit}`, name]} />
                {(['a', 'b'] as const).map((series, index) => <Line key={series} type="linear" dataKey={series} name={`${index === 0 ? 'A' : 'B'} · ${selectedRuns[index]?.name}`} stroke={colors[index]} strokeWidth={2} strokeDasharray={index === 1 ? '6 4' : undefined} dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer></div>
            <span className="chart-footnote">{measure.shared ? `Day ${measure.shared.day} · latest shared day` : 'No shared day for these reports'}</span>
          </article>;
        })}</div>
      </>}
  </section>;
}
