import { useEffect, useMemo, useRef, useState } from 'react';
import type { Series } from '../../../src/shared/types';

const PALETTE = ['#f38020', '#5aa9f2', '#3ecf8e', '#b18cf2', '#f2789f', '#2fc4c4', '#f5c04a', '#8b93a3'];

interface Props {
  series: Series[];
  format?: (v: number) => string;
  height?: number;
  min?: number;
  empty?: string;
}

const PAD = { l: 52, r: 10, t: 10, b: 22 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const timeLabel = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Small dependency-free time-series chart with a hover readout. */
export function Chart({ series, format = (v) => v.toFixed(1), height = 160, min = 0, empty = 'Belum ada data' }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Draw in real pixels so axis text keeps its size on narrow screens.
  const [W, setW] = useState(600);
  const hasData = series.some((s) => s.points.length > 0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => { if (e && e.contentRect.width > 0) setW(Math.round(e.contentRect.width)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]); // the observed element changes between the empty state and the chart

  const geo = useMemo(() => {
    const pts = series.flatMap((s) => s.points);
    if (!pts.length) return null;
    const t0 = Math.min(...pts.map((p) => p.t));
    const t1 = Math.max(...pts.map((p) => p.t));
    const yMax = niceMax(Math.max(...pts.map((p) => p.v)) * 1.05);
    const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - min) / Math.max(1e-9, yMax - min)) * (height - PAD.t - PAD.b);
    return { t0, t1, yMax, x, y };
  }, [series, height, min, W]);

  if (!geo) return <div ref={boxRef} className="chart-empty" style={{ height }}>{empty}</div>;
  const { t0, t1, yMax, x, y } = geo;
  const ticks = [min, (min + yMax) / 2, yMax];

  const onMove = (e: React.MouseEvent) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0));
  };

  const readout = hover == null ? null : series.map((s, i) => {
    const p = s.points.reduce((best, q) => (Math.abs(q.t - hover) < Math.abs(best.t - hover) ? q : best), s.points[0] ?? { t: 0, v: 0 });
    return { label: s.label, v: p.v, t: p.t, color: PALETTE[i % PALETTE.length]! };
  });

  return (
    <div className="chart" ref={boxRef}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${height}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="axis">{format(v)}</text>
          </g>
        ))}
        <text x={PAD.l} y={height - 5} className="axis">{timeLabel(t0)}</text>
        <text x={W - PAD.r} y={height - 5} textAnchor="end" className="axis">{timeLabel(t1)}</text>
        {series.map((s, i) => {
          const color = PALETTE[i % PALETTE.length];
          const d = s.points.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
          const area = series.length === 1 && s.points.length > 1
            ? `${d}L${x(s.points.at(-1)!.t).toFixed(1)},${y(min)}L${x(s.points[0]!.t).toFixed(1)},${y(min)}Z` : null;
          return (
            <g key={s.label}>
              {area && <path d={area} fill={color} opacity={0.12} />}
              <path d={d} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        })}
        {hover != null && hover >= t0 && hover <= t1 && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={height - PAD.b} className="cursor" />}
      </svg>
      <div className="legend">
        {(readout ?? series.map((s, i) => ({ label: s.label, v: s.points.at(-1)?.v ?? 0, color: PALETTE[i % PALETTE.length]!, t: 0 }))).slice(0, 8).map((r) => (
          <span key={r.label}><i style={{ background: r.color }} />{r.label} <b>{format(r.v)}</b></span>
        ))}
        {readout?.[0] && <span className="sub">{timeLabel(readout[0].t)}</span>}
      </div>
    </div>
  );
}
