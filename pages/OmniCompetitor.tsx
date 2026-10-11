import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, FlaskConical, LayoutDashboard, LogOut, Search, Users } from 'lucide-react';
import { AuditWorkspace } from '../components/AuditWorkspace';
import { CompetitorManager } from '../components/CompetitorManager';
import { ExecutiveDashboard } from '../components/ExecutiveDashboard';
import { useDemoController } from '../lib/demoController';
import { useLiveController } from '../lib/hooks';
import type { OmniController } from '../lib/types';

type Tab = 'audit' | 'competitors' | 'dashboard';

const TABS: Array<{ id: Tab; label: string; Icon: typeof Search }> = [
  { id: 'audit', label: 'Audit', Icon: Search },
  { id: 'competitors', label: 'Competitors', Icon: Users },
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
];

function EmptyState({ title, body, action }: { title: string; body: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <BarChart3 className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
      <p className="mt-3 font-semibold text-slate-800">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="mt-5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
          {action.label}
        </button>
      )}
    </div>
  );
}

function Shell({ c, demo, onToggleDemo, onSignOut }: { c: OmniController; demo: boolean; onToggleDemo: () => void; onSignOut?: () => void }) {
  const [tab, setTab] = useState<Tab>(c.report ? 'dashboard' : 'audit');

  // When a pipeline run finishes, take the user straight to the result.
  const prevStatus = useRef(c.pipeline.status);
  useEffect(() => {
    if (prevStatus.current === 'running' && c.pipeline.status === 'done') setTab('dashboard');
    prevStatus.current = c.pipeline.status;
  }, [c.pipeline.status]);

  const stale = useMemo(() => {
    if (!c.report) return false;
    const analyzed = Date.parse(c.report.last_analyzed_at);
    return c.competitors.some((x) => Date.parse(x.updated_date ?? x.created_date ?? '') > analyzed);
  }, [c.report, c.competitors]);

  const hasProfile = Boolean(c.profile);
  const includedCount = c.competitors.filter((x) => x.included_in_report !== false).length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <BarChart3 className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="text-base font-bold tracking-tight">OmniCompetitor</span>
          </div>

          <nav aria-label="Sections" className="order-3 flex w-full gap-1 sm:order-none sm:w-auto">
            {TABS.map(({ id, label, Icon }) => {
              const disabled = id !== 'audit' && !hasProfile;
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  disabled={disabled}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none ${
                    active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleDemo}
            aria-pressed={demo}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              demo ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <FlaskConical className="h-4 w-4" aria-hidden="true" />
            {demo ? 'Exit sample data' : 'Try sample data'}
          </button>
          {onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Sign out
            </button>
          )}
          </div>
        </div>
        {demo && (
          <p role="status" className="border-t border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">
            You are viewing <strong>sample data</strong> for fictional companies. Nothing here is a real analysis. Tip: enter a URL containing "fail" to see the error and retry flow.
          </p>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {c.loadError && (
          <p role="alert" className="mb-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {c.loadError}
          </p>
        )}

        {tab === 'audit' && (
          <AuditWorkspace
            pipeline={c.pipeline}
            onRun={c.runAudit}
            onRetry={c.retryPipeline}
            onReset={c.resetPipeline}
            recent={c.profiles}
            activeProfileId={c.profile?.id}
            onSelectProfile={(id) => {
              c.selectProfile(id);
              setTab('dashboard');
            }}
          />
        )}

        {tab === 'competitors' &&
          (c.profile ? (
            <CompetitorManager
              profile={c.profile}
              competitors={c.competitors}
              loading={c.competitorsLoading}
              busy={c.busy}
              actionError={c.actionError}
              onAddManual={c.addManualCompetitor}
              onToggle={c.toggleCompetitor}
              onRemove={c.removeCompetitor}
              onGenerateReport={c.regenerateReport}
              hasReport={Boolean(c.report)}
            />
          ) : (
            <EmptyState title="No company selected" body="Run an audit first to discover competitors." action={{ label: 'Go to Audit', onClick: () => setTab('audit') }} />
          ))}

        {tab === 'dashboard' &&
          (c.profile && c.report ? (
            <ExecutiveDashboard
              profile={c.profile}
              report={c.report}
              competitors={c.competitors}
              stale={stale}
              regenerating={c.regenerating}
              onRegenerate={c.regenerateReport}
              persistProgress={!demo}
            />
          ) : c.reportLoading ? (
            <div className="space-y-4" aria-busy="true" aria-label="Loading report">
              <div className="h-10 w-1/3 animate-pulse rounded bg-slate-200" />
              <div className="h-40 animate-pulse rounded-2xl bg-slate-200" />
            </div>
          ) : c.profile && includedCount > 0 ? (
            <EmptyState
              title="No report yet"
              body={`Generate the benchmark for ${c.profile.name} using ${includedCount} competitor${includedCount === 1 ? '' : 's'}.`}
              action={{ label: c.regenerating ? 'Generating…' : 'Generate report', onClick: c.regenerateReport }}
            />
          ) : (
            <EmptyState title="No report yet" body="Run an audit to create your first benchmark report." action={{ label: 'Go to Audit', onClick: () => setTab('audit') }} />
          ))}
      </main>
    </div>
  );
}

function DemoPage({ onToggleDemo, onSignOut }: { onToggleDemo: () => void; onSignOut?: () => void }) {
  const controller = useDemoController();
  return <Shell c={controller} demo onToggleDemo={onToggleDemo} onSignOut={onSignOut} />;
}

function LivePage({ onToggleDemo, onSignOut }: { onToggleDemo: () => void; onSignOut?: () => void }) {
  const controller = useLiveController();
  return <Shell c={controller} demo={false} onToggleDemo={onToggleDemo} onSignOut={onSignOut} />;
}

/**
 * OmniCompetitor page. Live mode talks to the Base44 entities and backend functions;
 * "Try sample data" switches to an in-memory demo so the UI can be explored with no backend.
 */
export default function OmniCompetitorPage({ initialDemo = false, onSignOut }: { initialDemo?: boolean; onSignOut?: () => void }) {
  const [demo, setDemo] = useState(initialDemo);
  return demo ? (
    <DemoPage key="demo" onToggleDemo={() => setDemo(false)} onSignOut={onSignOut} />
  ) : (
    <LivePage key="live" onToggleDemo={() => setDemo(true)} onSignOut={onSignOut} />
  );
}
