// In-memory OmniController backed by sample data. Lets the whole UI be exercised with no backend.
// Try a URL containing "fail" to see the error banner and Retry (the first scrape attempt fails).

import { useCallback, useEffect, useRef, useState } from 'react';
import { MOCK_COMPETITORS, MOCK_PROFILE, MOCK_REPORT } from './mockData';
import {
  PIPELINE_STEPS,
  type AuditCompanyWebsiteInput,
  type BenchmarkReport,
  type CompanyProfile,
  type Competitor,
  type ManualCompetitorInput,
  type OmniController,
  type PipelineState,
  type PipelineStepId,
} from './types';
import { hostKey, nameFromUrl } from './url';

interface ProfileData {
  competitors: Competitor[];
  report?: BenchmarkReport;
}

const STEP_MS = 650;
const IDLE: PipelineState = { status: 'idle', stepIndex: 0 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const STEP_IDS = PIPELINE_STEPS.map((s) => s.id);

function buildDemoFor(profileId: string): ProfileData {
  return {
    competitors: MOCK_COMPETITORS.map((c) => ({ ...c, id: `${profileId}_${c.id}`, company_profile_id: profileId })),
    report: { ...MOCK_REPORT, id: `${profileId}_report`, company_profile_id: profileId, last_analyzed_at: new Date().toISOString() },
  };
}

export function useDemoController(): OmniController {
  const [profiles, setProfiles] = useState<CompanyProfile[]>([MOCK_PROFILE]);
  const [data, setData] = useState<Record<string, ProfileData>>({ [MOCK_PROFILE.id]: { competitors: MOCK_COMPETITORS, report: MOCK_REPORT } });
  const [activeId, setActiveId] = useState<string | undefined>(MOCK_PROFILE.id);
  const [pipeline, setPipeline] = useState<PipelineState>(IDLE);
  const [regenerating, setRegenerating] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const alive = useRef(true);
  const failedOnce = useRef(false);
  const lastInput = useRef<AuditCompanyWebsiteInput | null>(null);
  const counter = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const profile = profiles.find((p) => p.id === activeId);
  const current = activeId ? data[activeId] : undefined;

  const runFrom = useCallback(async (start: PipelineStepId, profileId?: string) => {
    const input = lastInput.current;
    if (!input) return;
    let step = STEP_IDS.indexOf(start);
    let id = profileId;
    setPipeline({ status: 'running', stepIndex: step, ...(id ? { profileId: id } : {}) });
    try {
      for (; step < STEP_IDS.length; step++) {
        setPipeline((p) => ({ ...p, status: 'running', stepIndex: step, ...(id ? { profileId: id } : {}) }));
        await sleep(STEP_MS);
        if (!alive.current) return;

        if (STEP_IDS[step] === 'scrape') {
          if (/fail/i.test(input.url) && !failedOnce.current) {
            failedOnce.current = true;
            throw new Error('The site blocked automated access (HTTP 403). Try a different page or add the competitor manually.');
          }
          id = `demo_${++counter.current}`;
          const created: CompanyProfile = {
            ...MOCK_PROFILE,
            id,
            name: nameFromUrl(input.url),
            url: input.url,
            industry: input.industry ?? MOCK_PROFILE.industry,
            status: 'IDLE',
            created_date: new Date().toISOString(),
          };
          setProfiles((list) => [created, ...list.filter((p) => hostKey(p.url) !== hostKey(input.url))]);
          setData((d) => ({ ...d, [id!]: { ...buildDemoFor(id!), competitors: [], report: undefined } }));
          setActiveId(id);
        }
        if (STEP_IDS[step] === 'discover' && id) {
          const full = buildDemoFor(id);
          setData((d) => ({ ...d, [id!]: { competitors: full.competitors, report: undefined } }));
          setProfiles((list) => list.map((p) => (p.id === id ? { ...p, status: 'IDLE' } : p)));
        }
        if (STEP_IDS[step] === 'benchmark' && id) {
          const full = buildDemoFor(id);
          setData((d) => ({ ...d, [id!]: { competitors: d[id!]?.competitors ?? full.competitors, report: full.report } }));
          setProfiles((list) => list.map((p) => (p.id === id ? { ...p, status: 'ANALYZED' } : p)));
        }
      }
      if (alive.current) setPipeline({ status: 'done', stepIndex: 3, ...(id ? { profileId: id } : {}), warnings: ['NO_PUBLIC_PRICING_FOUND'] });
    } catch (err) {
      if (alive.current) {
        setPipeline({
          status: 'error',
          stepIndex: step,
          failedStep: STEP_IDS[step],
          error: err instanceof Error ? err.message : 'Something went wrong.',
          ...(id ? { profileId: id } : {}),
        });
      }
    }
  }, []);

  const runAudit = useCallback(
    (input: AuditCompanyWebsiteInput) => {
      if (pipeline.status === 'running') return;
      lastInput.current = input;
      failedOnce.current = false;
      setActionError(undefined);
      void runFrom('scrape');
    },
    [pipeline.status, runFrom],
  );

  const retryPipeline = useCallback(() => {
    if (pipeline.status !== 'error' || !pipeline.failedStep) return;
    void runFrom(pipeline.failedStep, pipeline.profileId);
  }, [pipeline, runFrom]);

  const updateCompetitors = useCallback(
    (fn: (list: Competitor[]) => Competitor[]) => {
      if (!activeId) return;
      setData((d) => ({ ...d, [activeId]: { ...(d[activeId] ?? { competitors: [] }), competitors: fn(d[activeId]?.competitors ?? []) } }));
    },
    [activeId],
  );

  const addManualCompetitor = useCallback(
    async (input: ManualCompetitorInput) => {
      if (!activeId) throw new Error('Select a company first.');
      await sleep(900);
      if (/fail/i.test(input.url)) throw new Error('The page could not be loaded (HTTP 404). Check the address and try again.');
      const stamp = new Date().toISOString();
      const added: Competitor = {
        id: `${activeId}_manual_${++counter.current}`,
        company_profile_id: activeId,
        name: input.name?.trim() || nameFromUrl(input.url),
        url: /^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`,
        source: 'MANUAL_INPUT',
        discovery_rationale: 'Added manually.',
        threat_level: 'MEDIUM',
        strengths: ['Established presence in the category'],
        weaknesses: ['Limited public information available'],
        features: { 'Public API': true, 'Free plan': false },
        pricing_summary: 'Not public.',
        included_in_report: true,
        created_date: stamp,
        updated_date: stamp,
      };
      updateCompetitors((list) => [...list, added]);
    },
    [activeId, updateCompetitors],
  );

  const toggleCompetitor = useCallback(
    (id: string, included: boolean) => updateCompetitors((list) => list.map((c) => (c.id === id ? { ...c, included_in_report: included, updated_date: new Date().toISOString() } : c))),
    [updateCompetitors],
  );

  const removeCompetitor = useCallback((id: string) => updateCompetitors((list) => list.filter((c) => c.id !== id)), [updateCompetitors]);

  const regenerateReport = useCallback(() => {
    if (!activeId || !current?.report || regenerating) return;
    const included = new Set(current.competitors.filter((c) => c.included_in_report !== false).map((c) => c.name));
    if (included.size === 0) return setActionError('Add or enable at least one competitor before generating a report.');
    setActionError(undefined);
    setRegenerating(true);
    void sleep(1200).then(() => {
      if (!alive.current) return;
      setData((d) => {
        const entry = d[activeId];
        if (!entry?.report) return d;
        const matrix = entry.report.feature_matrix.map((row) => ({ ...row, competitors: Object.fromEntries(Object.entries(row.competitors).filter(([name]) => included.has(name))) }));
        return { ...d, [activeId]: { ...entry, report: { ...entry.report, feature_matrix: matrix, last_analyzed_at: new Date().toISOString() } } };
      });
      setRegenerating(false);
    });
  }, [activeId, current, regenerating]);

  return {
    profiles,
    profilesLoading: false,
    profile,
    competitors: current?.competitors ?? [],
    competitorsLoading: false,
    report: current?.report,
    reportLoading: false,
    pipeline,
    busy: pipeline.status === 'running' || regenerating,
    regenerating,
    actionError,
    selectProfile: setActiveId,
    runAudit,
    retryPipeline,
    resetPipeline: () => setPipeline(IDLE),
    addManualCompetitor,
    toggleCompetitor,
    removeCompetitor,
    regenerateReport,
  };
}
