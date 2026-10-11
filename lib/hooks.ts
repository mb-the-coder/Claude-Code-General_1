// Live OmniController: React Query hooks over Base44 entities + the three backend functions.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, entityApi, queryKeys, toFunctionError } from './api';
import {
  PIPELINE_STEPS,
  type AuditCompanyWebsiteInput,
  type Competitor,
  type CompanyProfile,
  type ManualCompetitorInput,
  type OmniController,
  type PipelineState,
  type PipelineStepId,
} from './types';

const ACTIVE_KEY = 'omni:activeProfile';
const STEP_IDS: PipelineStepId[] = PIPELINE_STEPS.map((s) => s.id);
const IDLE: PipelineState = { status: 'idle', stepIndex: 0 };

function readActiveId(): string | undefined {
  try {
    return window.localStorage.getItem(ACTIVE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeActiveId(id: string | undefined) {
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // storage unavailable: selection just won't persist across reloads
  }
}

export function useLiveController(): OmniController {
  const qc = useQueryClient();
  const [activeId, setActiveIdState] = useState<string | undefined>(readActiveId);
  const [pipeline, setPipeline] = useState<PipelineState>(IDLE);
  const [actionError, setActionError] = useState<string>();

  const inputRef = useRef<AuditCompanyWebsiteInput | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setActiveId = useCallback((id: string | undefined) => {
    setActiveIdState(id);
    writeActiveId(id);
  }, []);

  // --- queries -------------------------------------------------------------------------------
  const profilesQ = useQuery({
    queryKey: queryKeys.profiles,
    queryFn: entityApi.listProfiles,
    // If a run is in progress elsewhere (another tab, or before a reload), keep the status fresh.
    refetchInterval: (query) => (pipeline.status !== 'running' && query.state.data?.some((p) => p.status === 'SCRAPING') ? 5_000 : false),
  });
  const profiles = profilesQ.data ?? [];
  const profile: CompanyProfile | undefined = profiles.find((p) => p.id === activeId) ?? profiles[0];
  const profileId = profile?.id;

  const competitorsQ = useQuery({
    queryKey: queryKeys.competitors(profileId),
    queryFn: () => entityApi.listCompetitors(profileId!),
    enabled: Boolean(profileId),
  });
  const reportQ = useQuery({
    queryKey: queryKeys.report(profileId),
    queryFn: () => entityApi.latestReport(profileId!),
    enabled: Boolean(profileId),
  });

  const refreshAll = useCallback(
    (id: string | undefined) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.profiles }),
        qc.invalidateQueries({ queryKey: queryKeys.competitors(id) }),
        qc.invalidateQueries({ queryKey: queryKeys.report(id) }),
      ]),
    [qc],
  );

  // --- pipeline: audit -> discover -> benchmark -> report -------------------------------------
  const runFrom = useCallback(
    async (start: PipelineStepId, resumeProfileId?: string) => {
      const input = inputRef.current;
      if (!input || runningRef.current) return;
      runningRef.current = true;
      setActionError(undefined);

      let current = STEP_IDS.indexOf(start);
      let id = resumeProfileId;
      let warnings: string[] = [];
      const mark = (stepIndex: number) => {
        current = stepIndex;
        if (mountedRef.current) setPipeline({ status: 'running', stepIndex, ...(id ? { profileId: id } : {}) });
      };

      try {
        if (current <= 0) {
          mark(0);
          const out = await api.audit(input);
          id = out.profile.id;
          warnings = out.scrape.warnings;
          // Put the new profile in the cache and select it right away, before any refetch lands.
          qc.setQueryData<CompanyProfile[]>(queryKeys.profiles, (old = []) => [out.profile, ...old.filter((p) => p.id !== out.profile.id)]);
          setActiveId(id);
        }
        if (!id) throw new Error('Missing company profile. Please start the audit again.');
        if (current <= 1) {
          mark(1);
          await api.discover({ companyProfileId: id });
          await qc.invalidateQueries({ queryKey: queryKeys.competitors(id) });
        }
        if (current <= 2) {
          mark(2);
          await api.synthesize({ companyProfileId: id });
        }
        // Step 4: pull the saved report + fresh statuses into the UI.
        mark(3);
        await refreshAll(id);
        if (mountedRef.current) setPipeline({ status: 'done', stepIndex: 3, profileId: id, warnings });
      } catch (err) {
        const e = toFunctionError(err);
        void qc.invalidateQueries({ queryKey: queryKeys.profiles });
        if (mountedRef.current) {
          setPipeline({
            status: 'error',
            stepIndex: current,
            failedStep: STEP_IDS[current],
            error: e.message,
            profileId: e.profileId ?? id,
          });
        }
      } finally {
        runningRef.current = false;
      }
    },
    [qc, refreshAll, setActiveId],
  );

  const runAudit = useCallback(
    (input: AuditCompanyWebsiteInput) => {
      inputRef.current = input;
      void runFrom('scrape');
    },
    [runFrom],
  );

  const retryPipeline = useCallback(() => {
    if (pipeline.status !== 'error' || !pipeline.failedStep) return;
    void runFrom(pipeline.failedStep, pipeline.profileId);
  }, [pipeline, runFrom]);

  // --- mutations -----------------------------------------------------------------------------
  const failure = (err: unknown) => setActionError(toFunctionError(err).message);

  const toggleM = useMutation({
    mutationFn: ({ id, included }: { id: string; included: boolean }) => entityApi.setCompetitorIncluded(id, included),
    onMutate: async ({ id, included }) => {
      setActionError(undefined);
      const key = queryKeys.competitors(profileId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<Competitor[]>(key);
      qc.setQueryData<Competitor[]>(key, (old = []) =>
        old.map((c) => (c.id === id ? { ...c, included_in_report: included, updated_date: new Date().toISOString() } : c)),
      );
      return { key, previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx) qc.setQueryData(ctx.key, ctx.previous);
      failure(err);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.competitors(profileId) }),
  });

  const removeM = useMutation({
    mutationFn: (id: string) => entityApi.removeCompetitor(id),
    onMutate: async (id) => {
      setActionError(undefined);
      const key = queryKeys.competitors(profileId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<Competitor[]>(key);
      qc.setQueryData<Competitor[]>(key, (old = []) => old.filter((c) => c.id !== id));
      return { key, previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx) qc.setQueryData(ctx.key, ctx.previous);
      failure(err);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.competitors(profileId) }),
  });

  const addM = useMutation({
    mutationFn: async (input: ManualCompetitorInput) => {
      if (!profileId) throw new Error('Select a company first.');
      return api.discover({ companyProfileId: profileId, skipDiscovery: true, manualCompetitors: [input] });
    },
    onSuccess: () => refreshAll(profileId),
  });

  const regenM = useMutation({
    mutationFn: async () => {
      if (!profileId) throw new Error('Select a company first.');
      return api.synthesize({ companyProfileId: profileId });
    },
    onMutate: () => setActionError(undefined),
    onSuccess: () => refreshAll(profileId),
    onError: (err) => {
      failure(err);
      void qc.invalidateQueries({ queryKey: queryKeys.profiles });
    },
  });

  return {
    profiles,
    profilesLoading: profilesQ.isLoading,
    profile,
    competitors: competitorsQ.data ?? [],
    competitorsLoading: Boolean(profileId) && competitorsQ.isLoading,
    report: reportQ.data ?? undefined,
    reportLoading: Boolean(profileId) && reportQ.isLoading,
    pipeline,
    busy: pipeline.status === 'running' || regenM.isPending || addM.isPending,
    regenerating: regenM.isPending,
    actionError,
    loadError: profilesQ.error ? `Could not load your companies: ${toFunctionError(profilesQ.error).message}` : undefined,
    selectProfile: (id) => {
      setActionError(undefined);
      setActiveId(id);
    },
    runAudit,
    retryPipeline,
    resetPipeline: () => setPipeline(IDLE),
    addManualCompetitor: async (input) => {
      setActionError(undefined);
      try {
        await addM.mutateAsync(input);
      } catch (err) {
        throw toFunctionError(err); // the modal shows this message
      }
    },
    toggleCompetitor: (id, included) => toggleM.mutate({ id, included }),
    removeCompetitor: (id) => removeM.mutate(id),
    regenerateReport: () => regenM.mutate(),
  };
}
