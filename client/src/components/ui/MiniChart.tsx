import { useId, useMemo } from "react";

// Dependency-free area sparkline. The y domain is fixed to 0–100 (percent values).
// The SVG stretches to the container width: the viewBox is scaled without keeping the aspect ratio,
// and `vector-effect: non-scaling-stroke` keeps the line width constant.

interface MiniChartProps {
  data: { value: number }[];
  color?: string;
  height?: number;
  /** Accessible name, e.g. "CPU usage". The latest value is appended. */
  label?: string;
}

const VIEW_WIDTH = 100;
/** Keeps the 1.5 px line inside the box at 0 % and at 100 %. */
const PAD = 1;

export interface SparklinePaths {
  line: string;
  area: string;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/**
 * Monotone cubic interpolation (Fritsch–Carlson), the same family as the "monotone" curve of d3 and recharts:
 * smooth, and it never overshoots the data, so the line stays inside 0–100.
 * Returns null for fewer than two points.
 */
export function sparklinePaths(values: number[], width: number, height: number, pad = PAD): SparklinePaths | null {
  const n = values.length;
  if (n < 2) return null;
  const xs = values.map((_, i) => (i / (n - 1)) * width);
  const ys = values.map((v) => {
    const clamped = Math.min(100, Math.max(0, Number.isFinite(v) ? v : 0));
    return pad + (1 - clamped / 100) * (height - 2 * pad);
  });

  // Secant slopes, then tangents limited so that every segment stays monotone.
  const dx = xs[1] - xs[0];
  const secants = ys.slice(1).map((y, i) => (y - ys[i]) / dx);
  const tangents = ys.map((_, i) => {
    if (i === 0) return secants[0];
    if (i === n - 1) return secants[n - 2];
    const a = secants[i - 1];
    const b = secants[i];
    if (a * b <= 0) return 0;
    const mean = (a + b) / 2;
    return Math.sign(mean) * Math.min(Math.abs(mean), 3 * Math.abs(a), 3 * Math.abs(b));
  });

  let line = `M${fmt(xs[0])},${fmt(ys[0])}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = xs[i] + dx / 3;
    const c1y = ys[i] + (tangents[i] * dx) / 3;
    const c2x = xs[i + 1] - dx / 3;
    const c2y = ys[i + 1] - (tangents[i + 1] * dx) / 3;
    line += `C${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(xs[i + 1])},${fmt(ys[i + 1])}`;
  }
  return { line, area: `${line}L${fmt(width)},${fmt(height)}L0,${fmt(height)}Z` };
}

export function MiniChart({ data, color = "#06b6d4", height = 40, label = "Trend" }: MiniChartProps) {
  // useId() contains characters that are not safe inside url(#…) in every React version.
  const gradientId = `minichart-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const paths = useMemo(() => sparklinePaths(data.map((d) => d.value), VIEW_WIDTH, height), [data, height]);
  const last = data.length > 0 ? data[data.length - 1].value : null;
  const name = last === null || !Number.isFinite(last) ? `${label}: no data yet` : `${label}: latest ${Math.round(last)}%, scale 0 to 100%`;

  return (
    <svg
      role="img"
      aria-label={name}
      width="100%"
      height={height}
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {paths && (
        <>
          <path d={paths.area} fill={`url(#${gradientId})`} stroke="none" />
          <path
            d={paths.line}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}
