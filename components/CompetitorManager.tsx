import { useMemo, useState, type FormEvent } from 'react';
import { Check, ExternalLink, Loader2, Plus, Sparkles, Trash2, UserPlus, Wand2 } from 'lucide-react';
import type { CompanyProfile, Competitor, ThreatLevel } from '../lib/types';
import { hostKey, isValidWebsiteUrl, safeHref } from '../lib/url';
import { Modal } from './Modal';

const THREAT_RANK: Record<ThreatLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const THREAT_STYLE: Record<ThreatLevel, { badge: string; dot: string; label: string }> = {
  CRITICAL: { badge: 'bg-red-600 text-white ring-red-700', dot: 'bg-red-600', label: 'Critical threat' },
  HIGH: { badge: 'bg-red-100 text-red-800 ring-red-200', dot: 'bg-red-500', label: 'High threat' },
  MEDIUM: { badge: 'bg-amber-100 text-amber-800 ring-amber-200', dot: 'bg-amber-500', label: 'Medium threat' },
  LOW: { badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500', label: 'Low threat' },
};

export function ThreatBadge({ level }: { level: ThreatLevel | undefined }) {
  if (!level) return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-200">Unrated</span>;
  const s = THREAT_STYLE[level];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${s.badge}`}>{s.label}</span>;
}

export interface CompetitorManagerProps {
  profile: Pick<CompanyProfile, 'name' | 'url'>;
  competitors: Competitor[];
  loading?: boolean;
  /** True while a report / pipeline run is in progress: disables actions that would conflict. */
  busy?: boolean;
  actionError?: string | null;
  /** Resolve on success; throw an Error with a user-facing message on failure. */
  onAddManual: (input: { url: string; name?: string }) => Promise<void>;
  onToggle: (id: string, included: boolean) => void;
  onRemove: (id: string) => void;
  onGenerateReport?: () => void;
  hasReport?: boolean;
}

const isIncluded = (c: Competitor) => c.included_in_report !== false;

export function CompetitorManager({ profile, competitors, loading = false, busy = false, actionError, onAddManual, onToggle, onRemove, onGenerateReport, hasReport = false }: CompetitorManagerProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...competitors].sort((a, b) => THREAT_RANK[a.threat_level ?? 'LOW'] - THREAT_RANK[b.threat_level ?? 'LOW'] || a.name.localeCompare(b.name)),
    [competitors],
  );
  const suggestions = sorted.filter((c) => c.source === 'AI_DISCOVERED');
  const includedCount = competitors.filter(isIncluded).length;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Competitors</h1>
          <p className="mt-1 text-sm text-slate-500">
            {loading ? 'Loading…' : `${includedCount} of ${competitors.length} included in the benchmark for ${profile.name}.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Add Competitor Manually
          </button>
          {onGenerateReport && (
            <button
              type="button"
              onClick={onGenerateReport}
              disabled={busy || includedCount === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Wand2 className="h-4 w-4" aria-hidden="true" />}
              {busy ? 'Working…' : hasReport ? 'Update benchmark report' : 'Generate benchmark report'}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {actionError}
        </p>
      )}

      {/* AI suggestions: toggle pills */}
      {suggestions.length > 0 && (
        <section aria-labelledby="ai-suggestions">
          <h2 id="ai-suggestions" className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Sparkles className="h-4 w-4 text-indigo-500" aria-hidden="true" /> AI suggestions
          </h2>
          <p className="mb-3 text-xs text-slate-500">Toggle competitors in or out of the report.</p>
          <div role="group" aria-label="AI suggested competitors" className="relative -mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2">
            {suggestions.map((c) => {
              const on = isIncluded(c);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggle(c.id, !on)}
                  disabled={busy}
                  className={`inline-flex shrink-0 snap-start items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60 ${
                    on ? 'border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {on ? <Check className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
                  {c.name}
                  {c.threat_level && <span className={`h-2 w-2 rounded-full ${THREAT_STYLE[c.threat_level].dot} ${on ? 'ring-2 ring-white/70' : ''}`} aria-hidden="true" />}
                  <span className="sr-only">
                    {c.threat_level ? `, ${THREAT_STYLE[c.threat_level].label}` : ''}, {on ? 'included in report' : 'excluded from report'}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Cards */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="font-medium text-slate-700">No competitors yet</p>
          <p className="mt-1 text-sm text-slate-500">Run an audit to discover competitors automatically, or add one by hand.</p>
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((c) => {
            const on = isIncluded(c);
            const confirming = confirmRemoveId === c.id;
            return (
              <li key={c.id} className={`flex flex-col rounded-2xl border bg-white p-5 shadow-sm transition-opacity ${on ? 'border-slate-200' : 'border-slate-200 opacity-70'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-slate-900">{c.name}</h3>
                    <a href={safeHref(c.url)} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-xs text-slate-500 hover:text-indigo-600 hover:underline">
                      <span className="truncate">{c.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  </div>
                  <ThreatBadge level={c.threat_level} />
                </div>

                <p className="mt-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">{c.source === 'MANUAL_INPUT' ? 'Added manually' : 'AI discovered'}</p>

                {c.discovery_rationale && <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-slate-600">{c.discovery_rationale}</p>}

                <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <p className="mb-1 font-semibold text-emerald-700">Strengths</p>
                    <ul className="space-y-1 text-slate-600">
                      {(c.strengths ?? []).slice(0, 3).map((s, i) => (
                        <li key={i} className="line-clamp-2">
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-1 font-semibold text-amber-700">Weaknesses</p>
                    <ul className="space-y-1 text-slate-600">
                      {(c.weaknesses ?? []).slice(0, 3).map((w, i) => (
                        <li key={i} className="line-clamp-2">
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {c.pricing_summary && (
                  <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    <span className="font-semibold text-slate-700">Pricing: </span>
                    {c.pricing_summary}
                  </p>
                )}

                <div className="mt-auto flex items-center justify-between gap-3 pt-5">
                  {/* One button (not a wrapping <label>) so the accessible name stays specific to this competitor. */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={`Include ${c.name} in report`}
                    onClick={() => onToggle(c.id, !on)}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-full text-sm text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-60"
                  >
                    <span className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-indigo-600' : 'bg-slate-300'}`} aria-hidden="true">
                      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                    </span>
                    <span aria-hidden="true">In report</span>
                  </button>

                  {confirming ? (
                    <span className="flex items-center gap-1.5 text-xs">
                      <button type="button" onClick={() => { setConfirmRemoveId(null); onRemove(c.id); }} className="rounded-md bg-rose-600 px-2.5 py-1 font-medium text-white hover:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500">
                        Remove
                      </button>
                      <button type="button" onClick={() => setConfirmRemoveId(null)} className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveId(c.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-rose-50 hover:text-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Remove<span className="sr-only"> {c.name}</span>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AddCompetitorModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        ownUrl={profile.url}
        existing={competitors}
        onAdd={async (input) => {
          await onAddManual(input);
          setAddOpen(false);
        }}
      />
    </div>
  );
}

interface AddCompetitorModalProps {
  open: boolean;
  onClose: () => void;
  ownUrl: string;
  existing: Competitor[];
  onAdd: (input: { url: string; name?: string }) => Promise<void>;
}

function AddCompetitorModal({ open, onClose, ownUrl, existing, onAdd }: AddCompetitorModalProps) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    if (submitting) return;
    setUrl('');
    setName('');
    setError(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isValidWebsiteUrl(url)) return setError('Enter a valid website, for example rival.com.');
    if (hostKey(url) === hostKey(ownUrl)) return setError('That is your own website. Enter a competitor instead.');
    if (existing.some((c) => hostKey(c.url) === hostKey(url))) return setError('This competitor is already in your list.');

    setSubmitting(true);
    try {
      await onAdd({ url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      setUrl('');
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this competitor. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} title="Add competitor manually" onClose={close}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <label htmlFor="competitor-url" className="block text-sm font-medium text-slate-700">
            Website URL
          </label>
          <input
            id="competitor-url"
            data-autofocus
            type="text"
            inputMode="url"
            autoComplete="off"
            placeholder="rival.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={submitting}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'competitor-error' : undefined}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
          />
        </div>
        <div>
          <label htmlFor="competitor-name" className="block text-sm font-medium text-slate-700">
            Name <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id="competitor-name"
            type="text"
            maxLength={200}
            autoComplete="off"
            placeholder="Detected from the site if left blank"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50"
          />
        </div>

        {error && (
          <p id="competitor-error" role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}
        {submitting && (
          <p role="status" className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the site and profiling the competitor. This can take up to a minute.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={close} disabled={submitting} className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={submitting || !url.trim()} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
            {submitting ? 'Analyzing…' : 'Add and analyze'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default CompetitorManager;
