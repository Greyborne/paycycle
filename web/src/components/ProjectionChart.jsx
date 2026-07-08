import React, { useMemo, useRef, useState } from 'react';
import { fmtDate, fmtMoney, fmtMoneyCompact, fmtRange } from '../format.js';

// Estimated-running-balance projection: one series over pay periods, so no
// legend (the card title names it). 2px line, gradient area wash above zero,
// hairline solid grid, crosshair + tooltip snapping to the nearest period.

const H = 280;
const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = span / count / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = step * mult;
  const ticks = [];
  for (let v = Math.ceil(min / s) * s; v <= max + 1e-9; v += s) ticks.push(v);
  return ticks;
}

export default function ProjectionChart({ entries, currency, firstNegative, width = 900 }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);

  const geom = useMemo(() => {
    const w = width - PAD.left - PAD.right;
    const h = H - PAD.top - PAD.bottom;
    const values = entries.map((e) => e.estBalance);
    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    const span = max - min || 100;
    min -= span * 0.06;
    max += span * 0.06;
    const x = (i) => PAD.left + (entries.length === 1 ? w / 2 : (i / (entries.length - 1)) * w);
    const y = (v) => PAD.top + h - ((v - min) / (max - min)) * h;
    return { w, h, min, max, x, y, ticks: niceTicks(min, max) };
  }, [entries, width]);

  if (!entries.length) return null;

  const { x, y, ticks } = geom;
  const line = entries.map((e, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(e.estBalance).toFixed(1)}`).join('');
  const area = `${line}L${x(entries.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const currentIdx = entries.findIndex((e) => e.isCurrent);
  const negIdx = firstNegative ? entries.findIndex((e) => e.start === firstNegative.start) : -1;

  // Short horizons show every period: a marker per period and its start date
  // on the axis. Long horizons fall back to sparse month/year labels.
  const detailed = entries.length <= 16;
  const labelEvery = detailed ? 1 : Math.max(1, Math.round(entries.length / 6));
  const xLabels = entries
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => i % labelEvery === 0 || i === entries.length - 1);

  const onMove = (evt) => {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * width;
    const frac = (px - PAD.left) / (geom.w || 1);
    const i = Math.max(0, Math.min(entries.length - 1, Math.round(frac * (entries.length - 1))));
    setHover(i);
  };

  const hoverEntry = hover != null ? entries[hover] : null;

  return (
    <div className="chart-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${H}`}
        className="projection-chart"
        role="img"
        aria-label="Estimated running balance by pay period"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          {/* accent → transparent wash under the line; colors come from CSS stops.
             userSpaceOnUse pins the fade to the plot height instead of the path
             bbox, so a rising line doesn't turn the whole fill muddy. */}
          <linearGradient
            id="projArea" gradientUnits="userSpaceOnUse"
            x1="0" y1={PAD.top} x2="0" y2={Math.max(y(0), H - PAD.bottom)}
          >
            <stop className="area-stop-top" offset="0" />
            <stop className="area-stop-bottom" offset="1" />
          </linearGradient>
        </defs>

        {/* gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
              {fmtMoneyCompact(t, currency)}
            </text>
          </g>
        ))}
        {/* zero baseline, slightly stronger than the grid */}
        <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />

        {/* today divider between the current period and the projection */}
        {currentIdx >= 0 && currentIdx < entries.length - 1 && (
          <g>
            <line className="today-line" x1={x(currentIdx)} x2={x(currentIdx)} y1={PAD.top} y2={H - PAD.bottom} />
            <text className="tick" x={x(currentIdx) + 5} y={PAD.top + 10}>today</text>
          </g>
        )}

        <path className="area" d={area} />
        <path className="line" d={line} />

        {/* per-period markers when every period is individually visible */}
        {detailed && entries.map((e, i) => (
          <g key={e.start}>
            <circle className="ring" cx={x(i)} cy={y(e.estBalance)} r={6} />
            <circle
              className={e.estBalance < 0 ? 'neg-dot' : 'point-dot'}
              cx={x(i)} cy={y(e.estBalance)} r={4}
            />
          </g>
        ))}

        {/* first projected negative period: critical marker with surface ring */}
        {negIdx >= 0 && (
          <g>
            <circle className="ring" cx={x(negIdx)} cy={y(entries[negIdx].estBalance)} r={7} />
            <circle className="neg-dot" cx={x(negIdx)} cy={y(entries[negIdx].estBalance)} r={5} />
          </g>
        )}

        {/* x labels */}
        {xLabels.map(({ e, i }) => (
          <text
            key={e.start} className="tick" x={x(i)} y={H - 8}
            textAnchor={i === entries.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
          >
            {fmtDate(e.start, detailed ? { month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' })}
          </text>
        ))}

        {/* crosshair + hover marker */}
        {hoverEntry && (
          <g>
            <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} />
            <circle className="ring" cx={x(hover)} cy={y(hoverEntry.estBalance)} r={6} />
            <circle className="hover-dot" cx={x(hover)} cy={y(hoverEntry.estBalance)} r={4} />
          </g>
        )}
      </svg>

      {hoverEntry && (
        <div
          className="chart-tooltip"
          style={{ left: `${(x(hover) / width) * 100}%`, top: 0 }}
        >
          <div className="tooltip-value">{fmtMoney(hoverEntry.estBalance, currency)}</div>
          <div className="tooltip-label">{fmtRange(hoverEntry.start, hoverEntry.end)}</div>
          <div className="tooltip-label">
            {hoverEntry.materialized ? (hoverEntry.isCurrent ? 'Current period' : 'Recorded period') : 'Projected'}
          </div>
        </div>
      )}
    </div>
  );
}
