import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Download, FileText, Loader2, RefreshCw, Printer } from 'lucide-react';
import type { BenchmarkReport, CompanyProfile, Competitor, Priority, Recommendation } from '../lib/types';
import { safeHref } from '../lib/url';
import { buildMarkdown, buildPrintHtml, downloadTextFile, formatDate, printHtml, roadmapKey, safeFilename } from '../lib/export';
import { FeatureMatrixTable } from './FeatureMatrixTable';
import { MetricCard } from './MetricCard';
import { SwotGrid } from './SwotGrid';

export interface ExecutiveDashboardProps {
  profile: Pick<CompanyProfile, 'name' | 'url' | 'industry'>;
  report: BenchmarkReport;
  competitors?: Competitor[];
  /** True when competitors changed after this report was generated. */
  stale?: boolean;
  regenerating?: boolean;
  onRegenerate?: () => void;
  /** Persist checkbox state per report. Disable for demo/test usage. */
  persistProgress?: boolean;
}

const COLUMNS: Array<{ priority: Priority; title: string; hint: string; accent: string; header: string }> = [
  { priority: 'P0', title: 'Do now', hint: 'This quarter · highest ROI', accent: 'border-t-rose-500', header: 'bg-rose-50 text-rose-800' },
  { priority: 'P1', title: 'Next up', hint: 'Next quarter', accent: 'border-t-amber-500', header: 'bg-amber-50 text-amber-800' },
  { priority: 'P2', title: 'Later', hint: 'Opportunistic / long-term', accent: 'border-t-slate-400', header: 'bg-slate-100 text-slate-700' },
];

const EFFORT_STYLE: Record<Recommendation['effort'], string> = {
  LOW: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  MED: 'bg-amber-50 text-amber-700 ring-amber-200',
  HIGH: 'bg-rose-50 text-rose-700 ring-rose-200',
};
const EFFORT_LABEL: Record<Recommendation['effort'], string> = { LOW: 'Low effort', MED: 'Medium effort', HIGH: 'High effort' };

/** Checkbox state for roadmap items, persisted per report in localStorage (best-effort). */
function useCompleted(reportId: string, persist: boolean) {
  const storageKey = `omni:roadmap:${reportId}`;
  const [completed, setCompleted] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!persist) return setCompleted(new Set());
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      setCompleted(new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []));
    } catch {
      setCompleted(new Set());
    }
  }, [storageKey, persist]);

  const toggle = useCallback(
    (key: string) => {
      setCompleted((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        if (persist) {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify([...next]));
          } catch {
            // storage may be unavailable (private mode); state still works for this session
          }
        }
        return next;
      });
    },
    [storageKey, persist],
  );

  return { completed, toggle };
}

export function ExecutiveDashboard({ profile, report, competitors, stale = false, regenerating = false, onRegenerate, persistProgress = true }: ExecutiveDashboardProps) {
  const { completed, toggle } = useCompleted(report.id, persistProgress);
  const [exportError, setExportError] = useState<string | null>(null);

  const recs = report.actionable_recommendations;
  const doneCount = recs.filter((r, i) => completed.has(roadmapKey(r, i))).length;
  const analyzed = formatDate(report.last_analyzed_at);

  const matrixNames = useMemo(() => [...new Set(report.feature_matrix.flatMap((r) => Object.keys(r.competitors)))], [report.feature_matrix]);
  const threatByName = useMemo(() => new Map((competitors ?? []).map((c) => [c.name, c.threat_level])), [competitors]);

  const exportInput = { profile, report, competitors, completed };
  const exportMarkdown = () => {
    try {
      setExportError(null);
      downloadTextFile(safeFilename(profile.name, 'md'), buildMarkdown(exportInput));
    } catch {
      setExportError('Could not create the Markdown file.');
    }
  };
  const exportPdf = () => {
    try {
      setExportError(null);
      printHtml(buildPrintHtml(exportInput));
    } catch {
      setExportError('Could not open the print dialog.');
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">Competitive benchmark</p>
          <h1 className="mt-1 truncate text-2xl font-bold text-slate-900 sm:text-3xl">{profile.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            <a href={safeHref(profile.url)} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-600 hover:underline">
              {profile.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
            {profile.industry && <span> · {profile.industry}</span>}
            {analyzed && <span> · Analyzed {analyzed}</span>}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Export executive summary">
          <span className="mr-1 hidden text-sm text-slate-500 sm:inline">Export Executive Summary</span>
          <button type="button" onClick={exportMarkdown} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            <FileText className="h-4 w-4" aria-hidden="true" /> Markdown
          </button>
          <button type="button" onClick={exportPdf} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            <Printer className="h-4 w-4" aria-hidden="true" /> PDF
          </button>
          {onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={regenerating}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {regenerating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </button>
          )}
        </div>
      </header>

      {exportError && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {exportError}
        </p>
      )}

      {stale && onRegenerate && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Your competitor list changed after this report was generated.
          </span>
          <button type="button" onClick={onRegenerate} disabled={regenerating} className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-60">
            Update report
          </button>
        </div>
      )}

      {/* Executive summary */}
      <section aria-labelledby="exec-summary" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 id="exec-summary" className="text-lg font-semibold text-slate-900">
          Executive summary
        </h2>
        <p className="mt-3 max-w-4xl whitespace-pre-line text-[15px] leading-relaxed text-slate-700">{report.executive_summary}</p>
        {matrixNames.length > 0 && (
          <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            Compared against
            {matrixNames.map((n) => {
              const threat = threatByName.get(n);
              return (
                <span key={n} className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
                  {n}
                  {threat && <span className="ml-1.5 text-slate-400">{threat.toLowerCase()}</span>}
                </span>
              );
            })}
          </p>
        )}
      </section>

      {/* Scorecards */}
      <section aria-label="Scorecards" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Overall health" score={report.overall_health_score} description="Composite of positioning, pricing, product and traction" />
        <MetricCard label="Market positioning" score={report.market_positioning_score} description="Clarity and differentiation of your message versus rivals" />
        <MetricCard label="Pricing competitiveness" score={report.pricing_competitiveness_score} description="Entry price, packaging and transparency" />
        <MetricCard label="Feature parity" score={report.feature_parity_score} description="Share of market-standard features you offer" />
      </section>

      {/* SWOT */}
      <section aria-labelledby="swot-heading">
        <h2 id="swot-heading" className="mb-4 text-lg font-semibold text-slate-900">
          SWOT analysis
        </h2>
        <SwotGrid swot={report.swot} />
      </section>

      {/* Feature matrix */}
      <section aria-labelledby="matrix-heading" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 id="matrix-heading" className="mb-4 text-lg font-semibold text-slate-900">
          Feature gap matrix
        </h2>
        <FeatureMatrixTable rows={report.feature_matrix} targetName={profile.name} competitorNames={matrixNames} />
      </section>

      {/* Roadmap */}
      <section aria-labelledby="roadmap-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="roadmap-heading" className="text-lg font-semibold text-slate-900">
              Action roadmap
            </h2>
            <p className="text-sm text-slate-500">Prioritized by ROI. Check items off as your team ships them.</p>
          </div>
          {recs.length > 0 && (
            <div className="min-w-[200px]">
              <p className="mb-1 flex justify-between text-xs font-medium text-slate-600">
                <span>Progress</span>
                <span aria-live="polite">
                  {doneCount} of {recs.length} done
                </span>
              </p>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Roadmap progress" aria-valuemin={0} aria-valuemax={recs.length} aria-valuenow={doneCount}>
                <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${recs.length ? (doneCount / recs.length) * 100 : 0}%` }} />
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {COLUMNS.map((col) => {
            const items = recs.map((r, index) => ({ r, index })).filter(({ r }) => r.priority === col.priority);
            return (
              <div key={col.priority} className={`flex flex-col rounded-2xl border border-t-4 border-slate-200 bg-slate-50/60 ${col.accent}`}>
                <div className={`flex items-center justify-between rounded-t-xl px-4 py-3 ${col.header}`}>
                  <div>
                    <h3 className="text-sm font-semibold">
                      {col.priority} · {col.title}
                    </h3>
                    <p className="text-xs opacity-75">{col.hint}</p>
                  </div>
                  <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-semibold">{items.length}</span>
                </div>
                <ul className="flex-1 space-y-3 p-3">
                  {items.length === 0 && <li className="p-3 text-center text-sm text-slate-400">No items</li>}
                  {items.map(({ r, index }) => {
                    const key = roadmapKey(r, index);
                    const isDone = completed.has(key);
                    const id = `rec-${report.id}-${index}`;
                    return (
                      <li key={key} className={`rounded-xl border bg-white p-3.5 shadow-sm transition-colors ${isDone ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200'}`}>
                        <div className="flex items-start gap-3">
                          <input
                            id={id}
                            type="checkbox"
                            checked={isDone}
                            onChange={() => toggle(key)}
                            className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                          />
                          <div className="min-w-0 flex-1">
                            <label htmlFor={id} className={`block cursor-pointer text-sm font-semibold leading-snug ${isDone ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                              {r.title}
                            </label>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200">{r.category}</span>
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${EFFORT_STYLE[r.effort]}`}>{EFFORT_LABEL[r.effort]}</span>
                            </div>
                            <p className="mt-2 text-xs leading-relaxed text-slate-600">{r.impact}</p>
                            {r.tacticalSteps.length > 0 && (
                              <details className="group mt-2">
                                <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800">
                                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
                                  {r.tacticalSteps.length} tactical steps
                                </summary>
                                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-slate-600">
                                  {r.tacticalSteps.map((s, n) => (
                                    <li key={n}>{s}</li>
                                  ))}
                                </ol>
                              </details>
                            )}
                          </div>
                          {isDone && <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" aria-label="Completed" />}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <footer className="flex items-center gap-2 pb-4 text-xs text-slate-400">
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        Scores are AI-generated estimates based on public website content. Verify key claims before acting on them.
      </footer>
    </div>
  );
}

export default ExecutiveDashboard;
