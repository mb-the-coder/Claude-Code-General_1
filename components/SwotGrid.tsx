import { useState } from 'react';
import { AlertTriangle, ChevronRight, Compass, ShieldCheck, TrendingDown, type LucideIcon } from 'lucide-react';
import type { SwotMatrix } from '../lib/types';
import { Modal } from './Modal';

type Quadrant = keyof SwotMatrix;

interface QuadrantStyle {
  title: string;
  blurb: string;
  Icon: LucideIcon;
  card: string;
  header: string;
  dot: string;
  button: string;
}

const QUADRANTS: Record<Quadrant, QuadrantStyle> = {
  strengths: {
    title: 'Strengths',
    blurb: 'Internal advantages to protect and amplify',
    Icon: ShieldCheck,
    card: 'border-emerald-200 bg-emerald-50/60',
    header: 'text-emerald-800',
    dot: 'bg-emerald-500',
    button: 'text-emerald-800 hover:bg-emerald-100 focus-visible:ring-emerald-500',
  },
  weaknesses: {
    title: 'Weaknesses',
    blurb: 'Internal gaps that cost you deals',
    Icon: TrendingDown,
    card: 'border-amber-200 bg-amber-50/60',
    header: 'text-amber-800',
    dot: 'bg-amber-500',
    button: 'text-amber-800 hover:bg-amber-100 focus-visible:ring-amber-500',
  },
  opportunities: {
    title: 'Opportunities',
    blurb: 'External openings you can move on',
    Icon: Compass,
    card: 'border-blue-200 bg-blue-50/60',
    header: 'text-blue-800',
    dot: 'bg-blue-500',
    button: 'text-blue-800 hover:bg-blue-100 focus-visible:ring-blue-500',
  },
  threats: {
    title: 'Threats',
    blurb: 'External forces that could erode your position',
    Icon: AlertTriangle,
    card: 'border-rose-200 bg-rose-50/60',
    header: 'text-rose-800',
    dot: 'bg-rose-500',
    button: 'text-rose-800 hover:bg-rose-100 focus-visible:ring-rose-500',
  },
};

// Order puts the 2x2 matrix in the classic arrangement: S W / O T.
const ORDER: Quadrant[] = ['strengths', 'weaknesses', 'opportunities', 'threats'];

export interface SwotGridProps {
  swot: SwotMatrix;
  /** How many items each quadrant previews before "View all". */
  previewCount?: number;
}

export function SwotGrid({ swot, previewCount = 3 }: SwotGridProps) {
  const [open, setOpen] = useState<Quadrant | null>(null);
  const active = open ? QUADRANTS[open] : null;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2" role="list" aria-label="SWOT matrix">
        {ORDER.map((key) => {
          const q = QUADRANTS[key];
          const items = swot[key] ?? [];
          const hidden = Math.max(0, items.length - previewCount);
          return (
            <section key={key} role="listitem" className={`flex flex-col rounded-2xl border p-5 ${q.card}`} aria-labelledby={`swot-${key}`}>
              <header className="flex items-start gap-3">
                <q.Icon className={`mt-0.5 h-5 w-5 shrink-0 ${q.header}`} aria-hidden="true" />
                <div className="min-w-0">
                  <h3 id={`swot-${key}`} className={`text-base font-semibold ${q.header}`}>
                    {q.title} <span className="ml-1 text-sm font-normal opacity-70">({items.length})</span>
                  </h3>
                  <p className="text-xs text-slate-500">{q.blurb}</p>
                </div>
              </header>

              {items.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">Nothing identified.</p>
              ) : (
                <ul className="mt-4 space-y-2.5">
                  {items.slice(0, previewCount).map((item, i) => (
                    <li key={i} className="flex gap-2.5 text-sm leading-snug text-slate-700">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${q.dot}`} aria-hidden="true" />
                      <span className="line-clamp-2">{item}</span>
                    </li>
                  ))}
                </ul>
              )}

              {items.length > 0 && (
                <button
                  type="button"
                  onClick={() => setOpen(key)}
                  className={`mt-4 inline-flex items-center gap-1 self-start rounded-lg px-2.5 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 ${q.button}`}
                  aria-haspopup="dialog"
                >
                  {hidden > 0 ? `View all ${items.length}` : 'View details'}
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">for {q.title}</span>
                </button>
              )}
            </section>
          );
        })}
      </div>

      <Modal open={open !== null} title={active ? `${active.title} (${swot[open!]?.length ?? 0})` : ''} onClose={() => setOpen(null)} widthClass="max-w-xl">
        {open && active && (
          <>
            <p className="mb-4 text-sm text-slate-500">{active.blurb}</p>
            <ol className="space-y-3">
              {swot[open].map((item, i) => (
                <li key={i} className="flex gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-700">
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${active.dot}`}>{i + 1}</span>
                  <span>{item}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </Modal>
    </>
  );
}

export default SwotGrid;
