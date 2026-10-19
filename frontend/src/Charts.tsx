import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity } from 'lucide-react';
import type { DailyResult, Metric } from './types';

const measures = [
  { key: 'biomass_g', title: 'Plant dry biomass', unit: 'g', color: '#b8e68b' },
  { key: 'fruit_g', title: 'Fruit dry biomass', unit: 'g', color: '#eaa28f' },
  { key: 'leaf_area_m2', title: 'Leaf area', unit: 'm²', color: '#80cbb0' },
  { key: 'par_mmol_day', title: 'Absorbed PAR', unit: 'mmol/day', color: '#e3c17f' },
  { key: 'carbon_mmol_day', title: 'Carbon assimilation', unit: 'mmol CO₂/day', color: '#b4b3e2' },
] as const;

export default function Charts({ names, data, day, plant, onPlant, onDay }: {
  names: Record<string,string>; data: DailyResult[]; day: number; plant: string; onPlant: (p: string) => void; onDay: (n: number) => void;
}) {
  const rows = useMemo(() => data.map(result => {
    const plants = plant === 'mean' ? result.plants : result.plants.filter(p => p.plant === Number(plant));
    const row: Record<string, number> = { day: result.day };
    for (const measure of measures) row[measure.key] = plants.length ? plants.reduce((sum, p) => sum + p[measure.key as keyof Metric], 0) / plants.length : NaN;
    return row;
  }), [data, plant]);
  const selected = rows.find(r => r.day === day);
  const ids = [...new Set(data.flatMap(d => d.plants.map(p => p.plant)))].sort((a, b) => a - b);
  return <section className="results-section" aria-label="Daily simulation charts">
    <div className="section-heading"><div><span className="eyebrow">DAILY OBSERVATIONS</span><h2>Growth & performance</h2></div>
      <label className="plant-select">Reporting<select aria-label="Plant reporting" value={plant} onChange={e => onPlant(e.target.value)}>
        <option value="mean">Mean per simulated plant</option>{ids.map(id => <option key={id} value={id}>{names[id]||`Plant ${id}`}</option>)}</select></label></div>
    {!data.length ? <div className="empty-charts"><Activity size={25} /><div><h3>Your simulation data will appear here</h3>
      <p>Run the model to see daily growth, light interception, and carbon assimilation.</p></div></div> : <div className="chart-grid">
      {measures.map(measure => <article className="chart-card" key={measure.key}>
        <div className="chart-title"><span>{measure.title}</span><span className="mini-dot" style={{ background: measure.color }} /></div>
        <div className="chart-value">{selected && Number.isFinite(selected[measure.key]) ? new Intl.NumberFormat('en', { maximumSignificantDigits: 4 }).format(selected[measure.key]) : '—'}<small>{measure.unit}</small></div>
        <div className="chart-container"><ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 10, right: 8, bottom: 0, left: -25 }} onClick={state => {
            if (state?.activeLabel !== undefined) onDay(Number(state.activeLabel));
          }}>
            <defs><linearGradient id={`fill-${measure.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={measure.color} stopOpacity={0.22} /><stop offset="100%" stopColor={measure.color} stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid vertical={false} stroke="#2c3930" strokeDasharray="3 4" />
            <XAxis dataKey="day" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} tick={{ fill: '#889a8b', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={18} />
            <YAxis tick={{ fill: '#889a8b', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={n => Number(n).toPrecision(2)} />
            <Tooltip contentStyle={{ background: '#1b2820', border: '1px solid #41513e', borderRadius: 8, color: '#e5ebdf', fontSize: 11 }} labelFormatter={n => `Day ${n}`} formatter={n => [`${Number(n).toPrecision(4)} ${measure.unit}`, measure.title]} />
            <Area type="linear" dataKey={measure.key} stroke={measure.color} strokeWidth={2} fill={`url(#fill-${measure.key})`} isAnimationActive={false} dot={rows.length < 3 ? { r: 3, fill: measure.color } : false} />
            <ReferenceLine x={day} stroke="#d3dfc9" strokeDasharray="3 3" />
          </AreaChart>
        </ResponsiveContainer></div>
        <span className="chart-footnote">Day {day} · {plant === 'mean' ? 'mean per plant' : `plant ${plant}`}</span>
      </article>)}
    </div>}
  </section>;
}
