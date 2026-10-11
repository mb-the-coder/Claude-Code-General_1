import { useEffect, useState } from 'react';

export type ScoreTone = 'strong' | 'moderate' | 'weak';

export function toneForScore(score: number): ScoreTone {
  if (score >= 75) return 'strong';
  if (score >= 50) return 'moderate';
  return 'weak';
}

const TONES: Record<ScoreTone, { stroke: string; bar: string; text: string; chip: string; label: string }> = {
  strong: { stroke: 'stroke-emerald-500', bar: 'bg-emerald-500', text: 'text-emerald-600', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', label: 'Strong' },
  moderate: { stroke: 'stroke-amber-500', bar: 'bg-amber-500', text: 'text-amber-600', chip: 'bg-amber-50 text-amber-700 ring-amber-200', label: 'Moderate' },
  weak: { stroke: 'stroke-rose-500', bar: 'bg-rose-500', text: 'text-rose-600', chip: 'bg-rose-50 text-rose-700 ring-rose-200', label: 'Needs work' },
};

export interface MetricCardProps {
  label: string;
  /** 0-100. Null / undefined renders an empty state instead of a misleading zero. */
  score: number | null | undefined;
  description?: string;
  variant?: 'ring' | 'bar';
  loading?: boolean;
}

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function MetricCard({ label, score, description, variant = 'ring', loading = false }: MetricCardProps) {
  const valid = typeof score === 'number' && Number.isFinite(score);
  const value = valid ? Math.max(0, Math.min(100, Math.round(score))) : 0;
  const tone = TONES[toneForScore(value)];

  // Animate from empty on mount so the ring / bar "fills in".
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-busy="true" aria-label={`${label} loading`}>
        <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
        <div className="mt-4 h-24 w-24 animate-pulse rounded-full bg-slate-100" />
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-600">{label}</h3>
        {valid && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone.chip}`}>{tone.label}</span>}
      </div>

      {!valid ? (
        <p className="mt-6 text-sm text-slate-400">Not available yet</p>
      ) : variant === 'ring' ? (
        <div className="mt-3 flex items-center gap-4">
          <div
            className="relative h-24 w-24 shrink-0"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={value}
            aria-valuetext={`${value} out of 100, ${tone.label}`}
          >
            <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true">
              <circle cx="50" cy="50" r={RADIUS} fill="none" strokeWidth="9" className="stroke-slate-100" />
              <circle
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                strokeWidth="9"
                strokeLinecap="round"
                className={`${tone.stroke} transition-[stroke-dashoffset] duration-700 ease-out`}
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - shown / 100)}
              />
            </svg>
            <span className={`absolute inset-0 flex items-center justify-center text-2xl font-semibold tabular-nums ${tone.text}`}>{value}</span>
          </div>
          {description && <p className="text-xs leading-relaxed text-slate-500">{description}</p>}
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex items-baseline gap-1">
            <span className={`text-3xl font-semibold tabular-nums ${tone.text}`}>{value}</span>
            <span className="text-sm text-slate-400">/ 100</span>
          </div>
          <div
            className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={value}
            aria-valuetext={`${value} out of 100, ${tone.label}`}
          >
            <div className={`h-full rounded-full ${tone.bar} transition-[width] duration-700 ease-out`} style={{ width: `${shown}%` }} />
          </div>
          {description && <p className="mt-3 text-xs leading-relaxed text-slate-500">{description}</p>}
        </div>
      )}
    </div>
  );
}

export default MetricCard;
