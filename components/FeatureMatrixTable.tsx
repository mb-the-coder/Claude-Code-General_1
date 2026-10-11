import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, X } from 'lucide-react';
import type { FeatureMatrixRow, GapImpact } from '../lib/types';

export const IMPACT_RANK: Record<GapImpact, number> = { HIGH: 3, MED: 2, LOW: 1 };

/** A gap is a feature the target lacks that at least one competitor offers. */
export function isGap(row: FeatureMatrixRow): boolean {
  return !row.targetHas && Object.values(row.competitors).some(Boolean);
}

type SortKey = 'gapImpact' | 'featureName';
type SortDir = 'asc' | 'desc';

const IMPACT_STYLE: Record<GapImpact, { gap: string; muted: string; label: string }> = {
  HIGH: { gap: 'bg-red-100 text-red-800 ring-red-200', muted: 'bg-slate-100 text-slate-500 ring-slate-200', label: 'High' },
  MED: { gap: 'bg-amber-100 text-amber-800 ring-amber-200', muted: 'bg-slate-100 text-slate-500 ring-slate-200', label: 'Medium' },
  LOW: { gap: 'bg-slate-100 text-slate-700 ring-slate-300', muted: 'bg-slate-100 text-slate-500 ring-slate-200', label: 'Low' },
};

export interface FeatureMatrixTableProps {
  rows: FeatureMatrixRow[];
  targetName: string;
  /** Column order for competitors; defaults to the keys found in the rows. */
  competitorNames?: string[];
}

function Mark({ value, who, feature }: { value: boolean; who: string; feature: string }) {
  return value ? (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700" title={`${who} offers ${feature}`}>
      <Check className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{`${who}: yes`}</span>
    </span>
  ) : (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-slate-400" title={`${who} does not offer ${feature}`}>
      <X className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{`${who}: no`}</span>
    </span>
  );
}

export function FeatureMatrixTable({ rows, targetName, competitorNames }: FeatureMatrixTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('gapImpact');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [gapsOnly, setGapsOnly] = useState(false);

  const names = useMemo(() => {
    if (competitorNames?.length) return competitorNames;
    const seen = new Set<string>();
    rows.forEach((r) => Object.keys(r.competitors).forEach((k) => seen.add(k)));
    return [...seen];
  }, [rows, competitorNames]);

  const gapCount = rows.filter(isGap).length;
  const highGapCount = rows.filter((r) => isGap(r) && r.gapImpact === 'HIGH').length;

  const visible = useMemo(() => {
    const filtered = gapsOnly ? rows.filter(isGap) : rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'featureName') return a.featureName.localeCompare(b.featureName) * dir;
      // Real gaps always outrank non-gaps; impact orders within each group.
      const gapDiff = Number(isGap(a)) - Number(isGap(b));
      if (gapDiff !== 0) return gapDiff * dir;
      return (IMPACT_RANK[a.gapImpact] - IMPACT_RANK[b.gapImpact]) * dir || a.featureName.localeCompare(b.featureName);
    });
  }, [rows, gapsOnly, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'gapImpact' ? 'desc' : 'asc');
    }
  };

  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';

  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey !== k ? <ArrowUpDown className="h-3.5 w-3.5 opacity-50" aria-hidden="true" /> : sortDir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />;

  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No feature comparison available yet.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600" aria-live="polite">
          <span className="font-semibold text-slate-900">{gapCount}</span> feature {gapCount === 1 ? 'gap' : 'gaps'}
          {highGapCount > 0 && (
            <>
              {' '}
              · <span className="font-semibold text-red-700">{highGapCount} high impact</span>
            </>
          )}
        </p>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={gapsOnly}
            onChange={(e) => setGapsOnly(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          Show gaps only
        </label>
      </div>

      {/* `relative` keeps the absolutely-positioned sr-only labels inside this scroller (otherwise they widen the page on mobile). */}
      <div className="relative overflow-x-auto rounded-xl border border-slate-200">
        <table className="min-w-full border-collapse text-sm">
          <caption className="sr-only">Feature comparison between {targetName} and its competitors</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" aria-sort={ariaSort('featureName')} className="sticky left-0 z-10 bg-slate-50 px-4 py-3 font-medium">
                <button type="button" onClick={() => toggleSort('featureName')} className="inline-flex items-center gap-1.5 uppercase tracking-wide hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                  Feature <SortIcon k="featureName" />
                </button>
              </th>
              <th scope="col" className="px-4 py-3 text-center font-semibold text-indigo-700">
                {targetName} <span className="block text-[10px] font-normal normal-case text-slate-400">you</span>
              </th>
              {names.map((n) => (
                <th key={n} scope="col" className="px-4 py-3 text-center font-medium">
                  {n}
                </th>
              ))}
              <th scope="col" aria-sort={ariaSort('gapImpact')} className="px-4 py-3 text-center font-medium">
                <button type="button" onClick={() => toggleSort('gapImpact')} className="inline-flex items-center gap-1.5 uppercase tracking-wide hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                  Gap impact <SortIcon k="gapImpact" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {visible.map((row) => {
              const gap = isGap(row);
              const style = IMPACT_STYLE[row.gapImpact];
              return (
                <tr key={row.featureName} className={gap ? 'bg-rose-50/40' : undefined}>
                  <th scope="row" className={`sticky left-0 z-10 px-4 py-3 text-left font-medium text-slate-800 ${gap ? 'border-l-4 border-rose-400 bg-rose-50' : 'border-l-4 border-transparent bg-white'}`}>
                    {row.featureName}
                  </th>
                  <td className="px-4 py-3 text-center">
                    <Mark value={row.targetHas} who={targetName} feature={row.featureName} />
                  </td>
                  {names.map((n) => (
                    <td key={n} className="px-4 py-3 text-center">
                      <Mark value={row.competitors[n] === true} who={n} feature={row.featureName} />
                    </td>
                  ))}
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${gap ? style.gap : style.muted}`}>
                      {style.label}
                      {!gap && <span className="sr-only"> (not a gap)</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={names.length + 3} className="px-4 py-8 text-center text-slate-500">
                  No gaps found. {targetName} matches or leads every compared feature.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default FeatureMatrixTable;
