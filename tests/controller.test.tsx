// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base44, configureFakeBackend, fakeDb, resetFakeBackend } from '../dev/stubs/base44Client';
import { toFunctionError, FunctionCallError } from '../lib/api';
import { useDemoController } from '../lib/demoController';
import { useLiveController } from '../lib/hooks';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  resetFakeBackend();
  configureFakeBackend({ delayMs: 0 });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function runToCompletion(result: { current: ReturnType<typeof useLiveController> }, url = 'globex.com') {
  await waitFor(() => expect(result.current.profilesLoading).toBe(false));
  act(() => result.current.runAudit({ url: `https://${url}/` }));
  await waitFor(() => expect(result.current.pipeline.status).toBe('done'), { timeout: 4000 });
}

describe('useLiveController: pipeline', () => {
  it('runs audit -> discover -> benchmark -> report and selects the new company', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await runToCompletion(result);

    expect(result.current.pipeline).toMatchObject({ status: 'done', stepIndex: 3 });
    expect(result.current.pipeline.warnings).toEqual(['NO_PUBLIC_PRICING_FOUND']);
    await waitFor(() => expect(result.current.report).toBeTruthy());
    expect(result.current.profile?.name).toBe('Globex');
    expect(result.current.profile?.status).toBe('ANALYZED');
    expect(result.current.competitors).toHaveLength(3);
    expect(result.current.report?.company_profile_id).toBe(result.current.profile?.id);
    expect(result.current.busy).toBe(false);
  });

  it('reports each step while running', async () => {
    configureFakeBackend({ delayMs: 15 });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await waitFor(() => expect(result.current.profilesLoading).toBe(false));
    const seen = new Set<number>();
    const stop = setInterval(() => {
      if (result.current.pipeline.status === 'running') seen.add(result.current.pipeline.stepIndex);
    }, 2);
    act(() => result.current.runAudit({ url: 'https://globex.com/' }));
    expect(result.current.busy).toBe(true);
    await waitFor(() => expect(result.current.pipeline.status).toBe('done'), { timeout: 5000 });
    clearInterval(stop);
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('ignores a second runAudit while one is running', async () => {
    configureFakeBackend({ delayMs: 10 });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await waitFor(() => expect(result.current.profilesLoading).toBe(false));
    act(() => {
      result.current.runAudit({ url: 'https://globex.com/' });
      result.current.runAudit({ url: 'https://initech.com/' });
    });
    await waitFor(() => expect(result.current.pipeline.status).toBe('done'), { timeout: 5000 });
    expect(fakeDb.CompanyProfile.map((p) => p.name)).toEqual(['Globex']);
  });

  it('stops at the failing step with the server message, then resumes from that step on retry', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await waitFor(() => expect(result.current.profilesLoading).toBe(false));

    act(() => result.current.runAudit({ url: 'https://fail-site.com/' }));
    await waitFor(() => expect(result.current.pipeline.status).toBe('error'), { timeout: 4000 });
    expect(result.current.pipeline).toMatchObject({ failedStep: 'scrape', stepIndex: 0 });
    expect(result.current.pipeline.error).toMatch(/blocked automated access/);
    expect(result.current.pipeline.profileId).toBeTruthy();
    expect(result.current.busy).toBe(false);

    act(() => result.current.retryPipeline());
    await waitFor(() => expect(result.current.pipeline.status).toBe('done'), { timeout: 4000 });
    expect(fakeDb.CompanyProfile).toHaveLength(1); // retry reused the same company, no duplicate
  });

  it('resumes from "discover" without re-running the audit', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await waitFor(() => expect(result.current.profilesLoading).toBe(false));

    const original = base44.functions.invoke.bind(base44.functions); // capture BEFORE spying, or the spy would call itself
    const discover = vi.spyOn(base44.functions, 'invoke');
    let failDiscover = true;
    discover.mockImplementation(async (name: string, payload: unknown) => {
      if (name === 'discoverAndAnalyzeCompetitors' && failDiscover) {
        failDiscover = false;
        throw { response: { status: 502, data: { error: 'Claude did not respond within 60s.', code: 'AI_TIMEOUT', retryable: true } } };
      }
      return original(name, payload);
    });

    act(() => result.current.runAudit({ url: 'https://globex.com/' }));
    await waitFor(() => expect(result.current.pipeline.status).toBe('error'), { timeout: 4000 });
    expect(result.current.pipeline).toMatchObject({ failedStep: 'discover', stepIndex: 1, error: 'Claude did not respond within 60s.' });

    discover.mockClear();
    act(() => result.current.retryPipeline());
    await waitFor(() => expect(result.current.pipeline.status).toBe('done'), { timeout: 4000 });
    const calls = discover.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['discoverAndAnalyzeCompetitors', 'synthesizeBenchmarkReport']); // no second audit
  });

  it('resetPipeline returns to idle', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await runToCompletion(result);
    act(() => result.current.resetPipeline());
    expect(result.current.pipeline.status).toBe('idle');
  });
});

describe('useLiveController: competitor actions', () => {
  async function ready() {
    const { wrapper, client } = makeWrapper();
    const hook = renderHook(() => useLiveController(), { wrapper });
    await runToCompletion(hook.result);
    await waitFor(() => expect(hook.result.current.competitors).toHaveLength(3));
    return { ...hook, client };
  }

  it('toggles optimistically and persists', async () => {
    const { result } = await ready();
    const target = result.current.competitors[0]!;
    act(() => result.current.toggleCompetitor(target.id, false));
    await waitFor(() => expect(result.current.competitors.find((c) => c.id === target.id)?.included_in_report).toBe(false));
    await waitFor(() => expect(fakeDb.Competitor.find((c) => c.id === target.id)?.included_in_report).toBe(false));
  });

  it('rolls back an optimistic toggle and surfaces the error when the update fails', async () => {
    const { result } = await ready();
    const target = result.current.competitors[0]!;
    vi.spyOn(base44.entities.Competitor, 'update').mockRejectedValue({ response: { status: 500, data: { error: 'Database unavailable.' } } });
    act(() => result.current.toggleCompetitor(target.id, false));
    await waitFor(() => expect(result.current.actionError).toBe('Database unavailable.'));
    await waitFor(() => expect(result.current.competitors.find((c) => c.id === target.id)?.included_in_report).toBe(true));
  });

  it('removes a competitor, and restores it if deletion fails', async () => {
    const { result } = await ready();
    const [first, second] = result.current.competitors;
    act(() => result.current.removeCompetitor(first!.id));
    await waitFor(() => expect(result.current.competitors.map((c) => c.id)).not.toContain(first!.id));

    vi.spyOn(base44.entities.Competitor, 'delete').mockRejectedValue(new Error('nope'));
    act(() => result.current.removeCompetitor(second!.id));
    await waitFor(() => expect(result.current.actionError).toBe('nope'));
    await waitFor(() => expect(result.current.competitors.map((c) => c.id)).toContain(second!.id));
  });

  it('adds a manual competitor via the backend function and refreshes the list', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.addManualCompetitor({ url: 'newrival.com', name: 'New Rival' });
    });
    await waitFor(() => expect(result.current.competitors.map((c) => c.name)).toContain('New Rival'));
    expect(result.current.competitors.find((c) => c.name === 'New Rival')?.source).toBe('MANUAL_INPUT');
  });

  it('rejects with the server message when a manual competitor cannot be analyzed', async () => {
    const { result } = await ready();
    let error: unknown;
    await act(async () => {
      await result.current.addManualCompetitor({ url: 'fail-rival.com' }).catch((e: unknown) => (error = e));
    });
    expect(error).toBeInstanceOf(FunctionCallError);
    expect((error as Error).message).toMatch(/HTTP 404/);
    expect(result.current.busy).toBe(false);
  });

  it('regenerates the report using only the included competitors', async () => {
    const { result } = await ready();
    const [first] = result.current.competitors;
    act(() => result.current.toggleCompetitor(first!.id, false));
    await waitFor(() => expect(fakeDb.Competitor.find((c) => c.id === first!.id)?.included_in_report).toBe(false));
    const before = result.current.report!.last_analyzed_at;
    await new Promise((r) => setTimeout(r, 5));

    act(() => result.current.regenerateReport());
    await waitFor(() => expect(result.current.report!.last_analyzed_at).not.toBe(before));
    const names = new Set(result.current.report!.feature_matrix.flatMap((r) => Object.keys(r.competitors)));
    expect(names.has(first!.name)).toBe(false);
    expect(names.size).toBe(2);
  });

  it('reports a clear error when regenerating with nothing included', async () => {
    const { result } = await ready();
    for (const c of result.current.competitors) act(() => result.current.toggleCompetitor(c.id, false));
    await waitFor(() => expect(fakeDb.Competitor.every((c) => c.included_in_report === false)).toBe(true));
    act(() => result.current.regenerateReport());
    await waitFor(() => expect(result.current.actionError).toMatch(/at least one competitor/));
  });
});

describe('useLiveController: loading and persistence', () => {
  it('restores the previously selected company after a reload', async () => {
    const first = makeWrapper();
    const a = renderHook(() => useLiveController(), { wrapper: first.wrapper });
    await runToCompletion(a.result, 'globex.com');
    await runToCompletion(a.result, 'initech.com');
    await waitFor(() => expect(a.result.current.profile?.name).toBe('Initech'));
    const initech = a.result.current.profile!.id;
    act(() => a.result.current.selectProfile(fakeDb.CompanyProfile.find((p) => p.name === 'Globex')!.id));
    a.unmount();

    const second = makeWrapper(); // brand-new query client = a page reload
    const b = renderHook(() => useLiveController(), { wrapper: second.wrapper });
    await waitFor(() => expect(b.result.current.profile?.name).toBe('Globex'));
    expect(b.result.current.profile?.id).not.toBe(initech);
    await waitFor(() => expect(b.result.current.report).toBeTruthy());
  });

  it('falls back to the most recent company when the stored selection no longer exists', async () => {
    window.localStorage.setItem('omni:activeProfile', 'deleted_profile');
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await runToCompletion(result);
    expect(result.current.profile?.name).toBe('Globex');
  });

  it('exposes a load error instead of crashing when entities cannot be read', async () => {
    vi.spyOn(base44.entities.CompanyProfile, 'list').mockRejectedValue({ code: 'ERR_NETWORK', message: 'Network Error' });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await waitFor(() => expect(result.current.loadError).toMatch(/Could not reach the server/));
    expect(result.current.profiles).toEqual([]);
  });

  it('works when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useLiveController(), { wrapper });
    await runToCompletion(result);
    expect(result.current.profile?.name).toBe('Globex');
  });
});

describe('toFunctionError', () => {
  it('prefers the structured server message and keeps the profile id for retries', () => {
    const e = toFunctionError({ response: { status: 422, data: { error: 'Blocked.', code: 'SCRAPE_BLOCKED_BY_SITE', retryable: false, profileId: 'p1' } } });
    expect(e).toMatchObject({ message: 'Blocked.', code: 'SCRAPE_BLOCKED_BY_SITE', retryable: false, profileId: 'p1', status: 422 });
  });

  it('turns transport failures and auth problems into friendly messages', () => {
    expect(toFunctionError({ code: 'ERR_NETWORK', message: 'Network Error' }).message).toMatch(/Could not reach the server/);
    expect(toFunctionError({ response: { status: 401, data: {} } }).message).toMatch(/session has expired/);
    expect(toFunctionError({ response: { status: 429 } }).message).toMatch(/Too many requests/);
    expect(toFunctionError({ response: { status: 504 } }).message).toMatch(/took too long/);
    expect(toFunctionError(undefined).message).toMatch(/Something went wrong/);
  });

  it('never exposes raw HTML or stack traces from an unstructured response body', () => {
    const e = toFunctionError({ message: 'Request failed with status code 500', response: { status: 500, data: '<html>stack trace</html>' } });
    expect(e.message).toBe('Request failed with status code 500');
    expect(e.message).not.toMatch(/<html>/);
  });
});

describe('useDemoController', () => {
  it('starts with sample data and completes a simulated audit', async () => {
    const { result } = renderHook(() => useDemoController());
    expect(result.current.profile?.name).toBe('Acme Flow');
    expect(result.current.report).toBeTruthy();

    act(() => result.current.runAudit({ url: 'https://initech.com/' }));
    expect(result.current.pipeline.status).toBe('running');
    await waitFor(() => expect(result.current.pipeline.status).toBe('done'), { timeout: 6000 });
    expect(result.current.profile?.name).toBe('Initech');
    expect(result.current.competitors.length).toBeGreaterThan(0);
  }, 10_000);

  it('demonstrates the failure + retry flow with a "fail" URL', async () => {
    const { result } = renderHook(() => useDemoController());
    act(() => result.current.runAudit({ url: 'https://fail-demo.com/' }));
    await waitFor(() => expect(result.current.pipeline.status).toBe('error'), { timeout: 4000 });
    expect(result.current.pipeline.failedStep).toBe('scrape');
    act(() => result.current.retryPipeline());
    await waitFor(() => expect(result.current.pipeline.status).toBe('done'), { timeout: 6000 });
  }, 12_000);
});
