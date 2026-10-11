import { useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Check, Info, Loader2, RotateCcw, Search } from 'lucide-react';
import { PIPELINE_STEPS, type CompanyProfile, type PipelineState } from '../lib/types';
import { normalizeUrl } from '../lib/url';

export const INDUSTRIES = ['SaaS / Software', 'E-commerce', 'Fintech', 'Healthcare', 'Education', 'Marketing / Agency', 'Professional services', 'Other'] as const;

const WARNING_TEXT: Record<string, string> = {
  THIN_CONTENT: 'The page has very little readable text (it may load content with JavaScript), so results may be less detailed.',
  NO_PUBLIC_PRICING_FOUND: 'No public pricing was found on the site, so pricing comparisons will be limited.',
  AI_EXTRACTION_FAILED: 'AI summarization was unavailable, so the profile was built from page metadata only.',
  PAGE_TRUNCATED: 'The page was very large; only the first part was analyzed.',
};

const STATUS_CHIP: Record<CompanyProfile['status'], { label: string; cls: string }> = {
  ANALYZED: { label: 'Report ready', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  IDLE: { label: 'Profile ready', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
  SCRAPING: { label: 'Running', cls: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
  ERROR: { label: 'Needs attention', cls: 'bg-rose-50 text-rose-700 ring-rose-200' },
};

export interface AuditWorkspaceProps {
  pipeline: PipelineState;
  onRun: (input: { url: string; industry?: string }) => void;
  /** Resume from the step that failed. */
  onRetry: () => void;
  /** Dismiss the error / finished state and return to the form. */
  onReset: () => void;
  recent?: CompanyProfile[];
  activeProfileId?: string;
  onSelectProfile?: (id: string) => void;
  initialUrl?: string;
}

type StepState = 'done' | 'active' | 'pending' | 'error';

function stepStates(p: PipelineState): StepState[] {
  return PIPELINE_STEPS.map((_, i) => {
    if (p.status === 'done') return 'done';
    if (p.status === 'idle') return 'pending';
    if (i < p.stepIndex) return 'done';
    if (i === p.stepIndex) return p.status === 'error' ? 'error' : 'active';
    return 'pending';
  });
}

export function AuditWorkspace({ pipeline, onRun, onRetry, onReset, recent = [], activeProfileId, onSelectProfile, initialUrl = '' }: AuditWorkspaceProps) {
  const [url, setUrl] = useState(initialUrl);
  const [industry, setIndustry] = useState<string>('');
  const [customIndustry, setCustomIndustry] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const running = pipeline.status === 'running';
  const showStepper = pipeline.status !== 'idle';
  const states = stepStates(pipeline);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (running) return;
    try {
      const normalized = normalizeUrl(url);
      setFormError(null);
      const chosen = industry === 'Other' ? customIndustry.trim() : industry;
      onRun({ url: normalized, ...(chosen ? { industry: chosen } : {}) });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Enter a valid website URL.');
    }
  };

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="rounded-3xl bg-gradient-to-br from-indigo-600 via-indigo-600 to-violet-700 px-6 py-10 text-white shadow-lg sm:px-10 sm:py-14">
        <p className="text-xs font-semibold uppercase tracking-widest text-indigo-200">OmniCompetitor</p>
        <h1 className="mt-2 max-w-2xl text-3xl font-bold leading-tight sm:text-4xl">See exactly where you stand against your market.</h1>
        <p className="mt-3 max-w-2xl text-indigo-100">
          Enter a website. We audit its messaging and pricing, find the competitors that matter, and deliver an executive benchmark with a prioritized action plan.
        </p>

        <form onSubmit={submit} noValidate className="mt-8 max-w-3xl">
          <label htmlFor="audit-url" className="sr-only">
            Company website URL
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                id="audit-url"
                type="text"
                inputMode="url"
                autoComplete="url"
                placeholder="yourcompany.com"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (formError) setFormError(null);
                }}
                disabled={running}
                aria-invalid={formError ? true : undefined}
                aria-describedby={formError ? 'audit-url-error' : undefined}
                className="w-full rounded-xl border-0 bg-white py-3.5 pl-11 pr-4 text-base text-slate-900 shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-white/80 disabled:opacity-70"
              />
            </div>
            <button
              type="submit"
              disabled={running || !url.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-6 py-3.5 text-base font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {running ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <ArrowRight className="h-5 w-5" aria-hidden="true" />}
              {running ? 'Auditing…' : 'Run Intelligence Audit'}
            </button>
          </div>
          {formError && (
            <p id="audit-url-error" role="alert" className="mt-2 rounded-lg bg-white/15 px-3 py-2 text-sm text-white">
              {formError}
            </p>
          )}

          <fieldset className="mt-5" disabled={running}>
            <legend className="text-xs font-medium uppercase tracking-wide text-indigo-200">Industry (optional)</legend>
            <div role="radiogroup" aria-label="Industry" className="mt-2 flex flex-wrap gap-2">
              {INDUSTRIES.map((name) => {
                const selected = industry === name;
                return (
                  <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setIndustry(selected ? '' : name)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60 ${
                      selected ? 'border-white bg-white font-semibold text-indigo-700' : 'border-white/30 bg-white/10 text-white hover:bg-white/20'
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
            {industry === 'Other' && (
              <div className="mt-3 max-w-sm">
                <label htmlFor="custom-industry" className="sr-only">
                  Describe your industry
                </label>
                <input
                  id="custom-industry"
                  type="text"
                  maxLength={120}
                  placeholder="e.g. Commercial real estate"
                  value={customIndustry}
                  onChange={(e) => setCustomIndustry(e.target.value)}
                  className="w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-white/80"
                />
              </div>
            )}
          </fieldset>
        </form>
      </section>

      {/* Progress / errors */}
      {showStepper && (
        <section aria-labelledby="progress-heading" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 id="progress-heading" className="text-lg font-semibold text-slate-900">
              {pipeline.status === 'done' ? 'Analysis complete' : pipeline.status === 'error' ? 'Analysis paused' : 'Analysis in progress'}
            </h2>
            {pipeline.status !== 'running' && (
              <button type="button" onClick={onReset} className="text-sm text-slate-500 hover:text-slate-800 hover:underline">
                Dismiss
              </button>
            )}
          </div>

          <ol className="mt-6 grid gap-4 md:grid-cols-4" aria-label="Analysis steps">
            {PIPELINE_STEPS.map((step, i) => {
              const state = states[i]!;
              return (
                <li key={step.id} aria-current={state === 'active' ? 'step' : undefined} className="relative flex gap-3 md:flex-col md:gap-2">
                  <div className="flex items-center gap-3 md:gap-0">
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                        state === 'done' ? 'bg-emerald-500 text-white' : state === 'active' ? 'bg-indigo-600 text-white' : state === 'error' ? 'bg-rose-500 text-white' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {state === 'done' ? <Check className="h-5 w-5" aria-hidden="true" /> : state === 'active' ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : state === 'error' ? <AlertTriangle className="h-5 w-5" aria-hidden="true" /> : i + 1}
                    </span>
                    {i < PIPELINE_STEPS.length - 1 && (
                      <span className={`ml-3 hidden h-0.5 flex-1 md:block ${state === 'done' ? 'bg-emerald-300' : 'bg-slate-200'}`} aria-hidden="true" />
                    )}
                  </div>
                  <div>
                    <p className={`text-sm font-semibold ${state === 'pending' ? 'text-slate-400' : 'text-slate-900'}`}>
                      <span className="text-slate-400">Step {i + 1} · </span>
                      {step.label}
                    </p>
                    <p className="text-xs text-slate-500">
                      {state === 'active' ? step.hint : state === 'done' ? 'Done' : state === 'error' ? 'Stopped here' : 'Waiting'}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="sr-only" aria-live="polite">
            {pipeline.status === 'running' && `Step ${pipeline.stepIndex + 1} of 4: ${PIPELINE_STEPS[pipeline.stepIndex]?.label}`}
            {pipeline.status === 'done' && 'Analysis complete'}
          </div>

          {pipeline.status === 'error' && (
            <div role="alert" className="mt-6 flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
                <div>
                  <p className="font-semibold text-rose-900">
                    {pipeline.failedStep === 'scrape' ? "We couldn't read that website" : 'Something went wrong'}
                  </p>
                  <p className="mt-0.5 text-sm text-rose-800">{pipeline.error ?? 'Please try again.'}</p>
                  {pipeline.failedStep === 'scrape' && <p className="mt-1 text-xs text-rose-700">Check the address, or try the site's main page.</p>}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2">
                  <RotateCcw className="h-4 w-4" aria-hidden="true" /> Retry
                </button>
                <button type="button" onClick={onReset} className="rounded-lg border border-rose-300 bg-white px-3.5 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100">
                  Try another URL
                </button>
              </div>
            </div>
          )}

          {pipeline.status === 'done' && pipeline.warnings && pipeline.warnings.length > 0 && (
            <ul className="mt-6 space-y-2" aria-label="Notes about this analysis">
              {pipeline.warnings.map((w) => (
                <li key={w} className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {WARNING_TEXT[w] ?? w}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Previous audits */}
      {recent.length > 0 && (
        <section aria-labelledby="recent-heading">
          <h2 id="recent-heading" className="mb-3 text-lg font-semibold text-slate-900">
            Recent audits
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((p) => {
              const chip = STATUS_CHIP[p.status] ?? STATUS_CHIP.IDLE;
              const active = p.id === activeProfileId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onSelectProfile?.(p.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border bg-white p-4 text-left shadow-sm transition hover:border-indigo-300 hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${active ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-slate-200'}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-900">{p.name}</span>
                      <span className="block truncate text-xs text-slate-500">{p.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                    </span>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${chip.cls}`}>{chip.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

export default AuditWorkspace;
