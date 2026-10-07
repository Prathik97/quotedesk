// Charts rendered from a validated chart payload. The data came from a stored tool result.
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { axisFormat, tooltipFormat, type ChartPayload } from '@/lib/analyst';

const COLORS = ['#0f766e', '#b45309', '#475569', '#7c3aed', '#be123c', '#0369a1'];

export function ChartView({ chart }: { chart: ChartPayload }) {
  const names = chart.series.map((s) => s.name);
  // Wide shape for bar and line: one row per x with a column per series.
  const xs = [...new Set(chart.series.flatMap((s) => s.points.map((p) => String(p.x))))];
  const rows = xs.map((x) => ({ x, ...Object.fromEntries(chart.series.map((s) => [s.name, s.points.find((p) => String(p.x) === x)?.y ?? null])) }));
  const summary = `${chart.title}. ${chart.type.replace('_', ' ')} chart with ${chart.series.length} ${chart.series.length === 1 ? 'series' : 'series'} and ${xs.length} points. The same data is in the table from result ${chart.sources.join(', ')}.`;
  const common = { margin: { top: 8, right: 16, bottom: 8, left: 8 } };
  const yAxis = <YAxis tickFormatter={(v: number) => axisFormat(chart.unit, v)} width={72} tick={{ fontSize: 11 }} />;
  const tip = <Tooltip formatter={(v) => (typeof v === 'number' ? tooltipFormat(chart.unit, v) : String(v))} />;
  return (
    <figure className="rounded-md border border-border bg-card p-3">
      <figcaption className="mb-1 text-sm font-medium">
        {chart.title}
        {chart.y_label ? <span className="ml-2 text-xs font-normal text-muted-foreground">{chart.y_label}</span> : null}
      </figcaption>
      <div role="img" aria-label={summary} className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chart.type === 'line' ? (
            <LineChart data={rows} {...common}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="x" tick={{ fontSize: 11 }} label={chart.x_label ? { value: chart.x_label, position: 'insideBottom', offset: -2, fontSize: 11 } : undefined} />
              {yAxis}
              {tip}
              {names.length > 1 ? <Legend /> : null}
              {names.map((n, i) => (
                <Line key={n} type="monotone" dataKey={n} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          ) : chart.type === 'scatter' ? (
            <ScatterChart {...common}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="x" type="number" name={chart.x_label ?? 'x'} tick={{ fontSize: 11 }} />
              <YAxis dataKey="y" type="number" name={chart.y_label ?? 'y'} tickFormatter={(v: number) => axisFormat(chart.unit, v)} width={72} tick={{ fontSize: 11 }} />
              {tip}
              {chart.series.map((s, i) => (
                <Scatter key={s.name} name={s.name} data={s.points.map((p) => ({ x: Number(p.x), y: p.y }))} fill={COLORS[i % COLORS.length]} isAnimationActive={false} />
              ))}
            </ScatterChart>
          ) : (
            <BarChart data={rows} {...common}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="x" tick={{ fontSize: 11 }} interval={0} angle={xs.length > 8 ? -35 : 0} textAnchor={xs.length > 8 ? 'end' : 'middle'} height={xs.length > 8 ? 70 : 30} />
              {yAxis}
              {tip}
              {names.length > 1 ? <Legend /> : null}
              {names.map((n, i) => (
                <Bar key={n} dataKey={n} fill={COLORS[i % COLORS.length]} stackId={chart.type === 'stacked_bar' ? 'a' : undefined} isAnimationActive={false} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
