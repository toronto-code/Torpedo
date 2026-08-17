import type { TelemetrySample } from "../../sim/types";

export interface PlotSeries {
  label: string;
  color: string;
  value: (sample: TelemetrySample) => number | null | undefined;
}

interface Props {
  title: string;
  unit: string;
  samples: TelemetrySample[];
  series: PlotSeries[];
  symmetric?: boolean;
}

const WIDTH = 420;
const HEIGHT = 116;
const PAD_X = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

function pathFor(
  values: Array<number | null>,
  minimum: number,
  maximum: number,
): string {
  let path = "";
  let drawing = false;
  const range = Math.max(1e-9, maximum - minimum);
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      drawing = false;
      return;
    }
    const x = PAD_X + (index / Math.max(1, values.length - 1)) * (WIDTH - PAD_X * 2);
    const y = PAD_TOP + (1 - (value - minimum) / range) * (HEIGHT - PAD_TOP - PAD_BOTTOM);
    path += `${drawing ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    drawing = true;
  });
  return path;
}

function compact(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000) return value.toExponential(1);
  if (absolute >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function latestValue(values: Array<number | null>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null) return values[index];
  }
  return null;
}

export function MiniPlot({ title, unit, samples, series, symmetric = false }: Props) {
  const visible = samples.slice(-600);
  const values = series.map((entry) => visible.map((sample) => entry.value(sample) ?? null));
  const finite = values.flat().filter((value): value is number => value !== null && Number.isFinite(value));
  let minimum = finite.length ? Math.min(...finite) : -1;
  let maximum = finite.length ? Math.max(...finite) : 1;
  if (symmetric) {
    const extent = Math.max(Math.abs(minimum), Math.abs(maximum), 1e-3);
    minimum = -extent;
    maximum = extent;
  } else if (Math.abs(maximum - minimum) < 1e-9) {
    minimum -= 1;
    maximum += 1;
  }
  const padding = (maximum - minimum) * 0.08;
  minimum -= padding;
  maximum += padding;

  return (
    <section className="plot-card">
      <header>
        <span>{title}</span>
        <span className="plot-unit">{unit}</span>
      </header>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${title} telemetry plot`}>
        <line className="plot-grid" x1={PAD_X} x2={WIDTH - PAD_X} y1={HEIGHT / 2} y2={HEIGHT / 2} />
        <line className="plot-grid" x1={PAD_X} x2={WIDTH - PAD_X} y1={PAD_TOP} y2={PAD_TOP} />
        <line className="plot-grid" x1={PAD_X} x2={WIDTH - PAD_X} y1={HEIGHT - PAD_BOTTOM} y2={HEIGHT - PAD_BOTTOM} />
        {series.map((entry, index) => (
          <path
            key={entry.label}
            d={pathFor(values[index], minimum, maximum)}
            fill="none"
            stroke={entry.color}
            strokeWidth="1.7"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <text className="plot-axis" x={PAD_X + 2} y={PAD_TOP + 10}>{compact(maximum)}</text>
        <text className="plot-axis" x={PAD_X + 2} y={HEIGHT - PAD_BOTTOM - 3}>{compact(minimum)}</text>
      </svg>
      <footer>
        {series.map((entry, index) => {
          const latest = latestValue(values[index]);
          return (
            <span key={entry.label}>
              <i style={{ background: entry.color }} />
              {entry.label} {latest === null ? "—" : compact(latest)}
            </span>
          );
        })}
      </footer>
    </section>
  );
}
