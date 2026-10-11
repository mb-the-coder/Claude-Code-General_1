// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditWorkspace } from '../components/AuditWorkspace';
import { CompetitorManager } from '../components/CompetitorManager';
import { ExecutiveDashboard } from '../components/ExecutiveDashboard';
import { FeatureMatrixTable, isGap } from '../components/FeatureMatrixTable';
import { MetricCard, toneForScore } from '../components/MetricCard';
import { SwotGrid } from '../components/SwotGrid';
import { MOCK_COMPETITORS, MOCK_PROFILE, MOCK_REPORT } from '../lib/mockData';
import type { PipelineState } from '../lib/types';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('MetricCard', () => {
  it('buckets scores into strong / moderate / weak', () => {
    expect([toneForScore(75), toneForScore(74), toneForScore(50), toneForScore(49)]).toEqual(['strong', 'moderate', 'moderate', 'weak']);
  });

  it('exposes an accessible progressbar and clamps / rounds the value', () => {
    render(<MetricCard label="Pricing" score={54.6} />);
    const bar = screen.getByRole('progressbar', { name: 'Pricing' });
    expect(bar.getAttribute('aria-valuenow')).toBe('55');
    expect(bar.getAttribute('aria-valuetext')).toBe('55 out of 100, Moderate');
    cleanup();
    render(<MetricCard label="X" score={250} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows an empty state (not a misleading zero) when there is no score', () => {
    render(<MetricCard label="Health" score={undefined} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Not available yet')).toBeTruthy();
  });

  it('supports the bar variant', () => {
    render(<MetricCard label="Parity" score={39} variant="bar" />);
    expect(screen.getByText('Needs work')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('39');
  });
});

describe('SwotGrid', () => {
  it('previews three items and opens a modal with all of them', () => {
    render(<SwotGrid swot={MOCK_REPORT.swot} />);
    const strengths = screen.getByRole('listitem', { name: /Strengths/ });
    expect(within(strengths).getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: /View all 4\s*for Strengths/ }));
    const dialog = screen.getByRole('dialog', { name: 'Strengths (4)' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(4);
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes via the close button and the backdrop', () => {
    render(<SwotGrid swot={MOCK_REPORT.swot} />);
    fireEvent.click(screen.getByRole('button', { name: /for Threats/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('handles empty quadrants', () => {
    render(<SwotGrid swot={{ strengths: [], weaknesses: ['w'], opportunities: [], threats: [] }} />);
    expect(screen.getAllByText('Nothing identified.')).toHaveLength(3);
  });
});

describe('FeatureMatrixTable', () => {
  const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('rowheader')[0]!.textContent);

  it('defines a gap as: target lacks it and at least one competitor has it', () => {
    expect(isGap({ featureName: 'a', targetHas: false, competitors: { x: true }, gapImpact: 'LOW' })).toBe(true);
    expect(isGap({ featureName: 'a', targetHas: false, competitors: { x: false }, gapImpact: 'HIGH' })).toBe(false);
    expect(isGap({ featureName: 'a', targetHas: true, competitors: { x: true }, gapImpact: 'HIGH' })).toBe(false);
  });

  it('sorts real gaps first, highest impact first, then toggles direction', () => {
    render(<FeatureMatrixTable rows={MOCK_REPORT.feature_matrix} targetName="Acme Flow" />);
    const order = names();
    expect(order.slice(0, 2).sort()).toEqual(['Audit logs', 'SSO / SAML']); // HIGH gaps
    expect(order[2]).toMatch(/Advanced reporting|Free plan|Mobile app/); // MED gaps next
    fireEvent.click(screen.getByRole('button', { name: /Gap impact/ }));
    expect(names()[0]).not.toMatch(/Audit logs|SSO/);
  });

  it('sorts by feature name and reports aria-sort', () => {
    render(<FeatureMatrixTable rows={MOCK_REPORT.feature_matrix} targetName="Acme Flow" />);
    fireEvent.click(screen.getByRole('button', { name: /^Feature/ }));
    expect(names()[0]).toBe('Advanced reporting');
    expect(screen.getByRole('columnheader', { name: /Feature/ }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByRole('button', { name: /^Feature/ }));
    expect(names()[0]).toBe('Template library');
  });

  it('filters to gaps only and summarizes them', () => {
    render(<FeatureMatrixTable rows={MOCK_REPORT.feature_matrix} targetName="Acme Flow" />);
    expect(screen.getByText(/6/).textContent).toContain('6');
    expect(screen.getByText('2 high impact')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show gaps only'));
    expect(names()).toHaveLength(6);
  });

  it('labels checks and crosses for assistive tech', () => {
    render(
      <FeatureMatrixTable
        rows={[{ featureName: 'SSO', targetHas: false, competitors: { Rival: true }, gapImpact: 'HIGH' }]}
        targetName="Acme"
      />,
    );
    expect(screen.getByText('Acme: no')).toBeTruthy();
    expect(screen.getByText('Rival: yes')).toBeTruthy();
  });

  it('shows empty and no-gap states', () => {
    const { unmount } = render(<FeatureMatrixTable rows={[]} targetName="Acme" />);
    expect(screen.getByText(/No feature comparison/)).toBeTruthy();
    unmount();
    render(<FeatureMatrixTable rows={[{ featureName: 'API', targetHas: true, competitors: { R: true }, gapImpact: 'LOW' }]} targetName="Acme" />);
    fireEvent.click(screen.getByLabelText('Show gaps only'));
    expect(screen.getByText(/No gaps found/)).toBeTruthy();
  });
});

describe('CompetitorManager', () => {
  const setup = (overrides: Partial<Parameters<typeof CompetitorManager>[0]> = {}) => {
    const props = {
      profile: MOCK_PROFILE,
      competitors: MOCK_COMPETITORS,
      onAddManual: vi.fn().mockResolvedValue(undefined),
      onToggle: vi.fn(),
      onRemove: vi.fn(),
      onGenerateReport: vi.fn(),
      ...overrides,
    };
    render(<CompetitorManager {...props} />);
    return props;
  };

  it('orders cards by threat and colors the badges (red high/critical, amber medium)', () => {
    setup();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Streamline', 'Orbit Ops', 'FlowForge', 'Cascade HQ']);
    expect(screen.getByText('Critical threat').className).toMatch(/bg-red-600/);
    expect(screen.getByText('High threat').className).toMatch(/red-/);
    expect(screen.getByText('Medium threat').className).toMatch(/amber-/);
  });

  it('gives every switch a unique, competitor-specific accessible name and toggles it', () => {
    const props = setup();
    const sw = screen.getByRole('switch', { name: 'Include Streamline in report' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(props.onToggle).toHaveBeenCalledWith('demo_comp_1', false);
    expect(screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toHaveLength(4);
  });

  it('toggles AI suggestion pills in and out', () => {
    const props = setup();
    const pill = screen.getByRole('button', { name: /Cascade HQ.*excluded/ });
    expect(pill.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pill);
    expect(props.onToggle).toHaveBeenCalledWith('demo_comp_4', true);
    // manual competitors are not "AI suggestions"
    expect(screen.queryByRole('button', { name: /FlowForge.*(in|ex)cluded/ })).toBeNull();
  });

  it('requires a second click to remove a competitor', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: /Remove Streamline/ }));
    expect(props.onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(props.onRemove).toHaveBeenCalledWith('demo_comp_1');
  });

  it('validates the manual-add form before calling the backend', async () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add Competitor Manually' }));
    const url = screen.getByLabelText('Website URL');
    const submit = screen.getByRole('button', { name: 'Add and analyze' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(url, { target: { value: 'not a url' } });
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toMatch(/valid website/);

    fireEvent.change(url, { target: { value: 'https://www.acmeflow.example/pricing' } });
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toMatch(/your own website/);

    fireEvent.change(url, { target: { value: 'streamline.example' } });
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toMatch(/already in your list/);
    expect(props.onAddManual).not.toHaveBeenCalled();
  });

  it('submits a valid competitor and closes; keeps the modal open and shows the message on failure', async () => {
    const onAddManual = vi.fn().mockRejectedValueOnce(new Error('The page could not be loaded (HTTP 404).')).mockResolvedValueOnce(undefined);
    setup({ onAddManual });
    fireEvent.click(screen.getByRole('button', { name: 'Add Competitor Manually' }));
    fireEvent.change(screen.getByLabelText('Website URL'), { target: { value: 'newrival.com' } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: ' New Rival ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and analyze' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/HTTP 404/);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onAddManual).toHaveBeenCalledWith({ url: 'newrival.com', name: 'New Rival' });

    fireEvent.click(screen.getByRole('button', { name: 'Add and analyze' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onAddManual).toHaveBeenCalledTimes(2);
  });

  it('disables report generation without included competitors and shows busy state', () => {
    setup({ competitors: MOCK_COMPETITORS.map((c) => ({ ...c, included_in_report: false })) });
    expect((screen.getByRole('button', { name: /benchmark report/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    setup({ busy: true });
    expect((screen.getByRole('button', { name: 'Add Competitor Manually' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('never renders a non-http(s) stored URL as a link target', () => {
    setup({ competitors: [{ ...MOCK_COMPETITORS[0]!, url: 'javascript:alert(document.cookie)' }] });
    const link = screen.getByRole('link', { name: /opens in a new tab/ });
    expect(link.getAttribute('href')).toBe('#');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows empty and loading states', () => {
    setup({ competitors: [] });
    expect(screen.getByText('No competitors yet')).toBeTruthy();
    cleanup();
    setup({ loading: true });
    expect(screen.getByText('Loading…')).toBeTruthy();
  });
});

describe('AuditWorkspace', () => {
  const idle: PipelineState = { status: 'idle', stepIndex: 0 };
  const noop = () => undefined;

  it('validates the URL and submits a normalized value with the chosen industry', () => {
    const onRun = vi.fn();
    render(<AuditWorkspace pipeline={idle} onRun={onRun} onRetry={noop} onReset={noop} />);
    fireEvent.change(screen.getByLabelText('Company website URL'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Intelligence Audit' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Company website URL'), { target: { value: ' acme.com ' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Fintech' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Intelligence Audit' }));
    expect(onRun).toHaveBeenCalledWith({ url: 'https://acme.com/', industry: 'Fintech' });
  });

  it('supports a custom industry and deselecting a chip', () => {
    const onRun = vi.fn();
    render(<AuditWorkspace pipeline={idle} onRun={onRun} onRetry={noop} onReset={noop} />);
    fireEvent.change(screen.getByLabelText('Company website URL'), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.change(screen.getByLabelText('Describe your industry'), { target: { value: 'Commercial real estate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Intelligence Audit' }));
    expect(onRun).toHaveBeenLastCalledWith({ url: 'https://acme.com/', industry: 'Commercial real estate' });

    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Intelligence Audit' }));
    expect(onRun).toHaveBeenLastCalledWith({ url: 'https://acme.com/' });
  });

  it('renders the four-step stepper with the active step marked', () => {
    render(<AuditWorkspace pipeline={{ status: 'running', stepIndex: 1 }} onRun={noop} onRetry={noop} onReset={noop} initialUrl="acme.com" />);
    const steps = screen.getAllByRole('listitem').filter((li) => li.closest('ol[aria-label="Analysis steps"]'));
    expect(steps).toHaveLength(4);
    expect(steps[0]!.textContent).toMatch(/Done/);
    expect(steps[1]!.getAttribute('aria-current')).toBe('step');
    expect(steps[1]!.textContent).toMatch(/Discovering Competitors/);
    expect(steps[2]!.textContent).toMatch(/Waiting/);
    expect((screen.getByRole('button', { name: /Auditing/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the error banner with retry / reset and marks the failed step', () => {
    const onRetry = vi.fn();
    const onReset = vi.fn();
    render(
      <AuditWorkspace
        pipeline={{ status: 'error', stepIndex: 0, failedStep: 'scrape', error: 'The site blocked automated access (HTTP 403).' }}
        onRun={noop}
        onRetry={onRetry}
        onReset={onReset}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/couldn't read that website/);
    expect(alert.textContent).toMatch(/HTTP 403/);
    expect(screen.getByText('Stopped here')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try another URL' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('uses a generic title for non-scrape failures and shows completion warnings', () => {
    const { rerender } = render(
      <AuditWorkspace pipeline={{ status: 'error', stepIndex: 2, failedStep: 'benchmark', error: 'Claude did not respond within 120s.' }} onRun={noop} onRetry={noop} onReset={noop} />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong/);
    rerender(
      <AuditWorkspace pipeline={{ status: 'done', stepIndex: 3, warnings: ['THIN_CONTENT', 'NO_PUBLIC_PRICING_FOUND'] }} onRun={noop} onRetry={noop} onReset={noop} />,
    );
    expect(screen.getByLabelText('Notes about this analysis').textContent).toMatch(/very little readable text/);
    // The same text is also announced via an sr-only live region, so target the visible heading.
    expect(screen.getByRole('heading', { name: 'Analysis complete' })).toBeTruthy();
  });

  it('lists recent audits and selects one', () => {
    const onSelect = vi.fn();
    render(
      <AuditWorkspace
        pipeline={idle}
        onRun={noop}
        onRetry={noop}
        onReset={noop}
        recent={[MOCK_PROFILE, { ...MOCK_PROFILE, id: 'p2', name: 'Globex', url: 'https://globex.com/', status: 'ERROR' }]}
        onSelectProfile={onSelect}
        activeProfileId={MOCK_PROFILE.id}
      />,
    );
    expect(screen.getByText('Report ready')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Globex/ }));
    expect(onSelect).toHaveBeenCalledWith('p2');
  });
});

describe('ExecutiveDashboard', () => {
  const renderDash = (props: Partial<Parameters<typeof ExecutiveDashboard>[0]> = {}) =>
    render(<ExecutiveDashboard profile={MOCK_PROFILE} report={MOCK_REPORT} competitors={MOCK_COMPETITORS} {...props} />);

  it('renders scorecards, summary, SWOT, matrix and roadmap', () => {
    renderDash();
    expect(screen.getByRole('heading', { level: 1, name: 'Acme Flow' })).toBeTruthy();
    expect(screen.getAllByRole('progressbar', { name: /health|positioning|pricing|parity/i })).toHaveLength(4);
    expect(screen.getByText(/sharp, ops-focused message/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'SWOT analysis' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('P0 · Do now')).toBeTruthy();
    expect(screen.getAllByRole('checkbox', { name: /./ }).length).toBeGreaterThanOrEqual(MOCK_REPORT.actionable_recommendations.length);
  });

  it('tracks roadmap progress and persists it per report', () => {
    const first = renderDash();
    const box = screen.getByRole('checkbox', { name: 'Ship SSO and audit logs on the Business plan' });
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('1 of 8 done')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('omni:roadmap:demo_report')!)).toHaveLength(1);

    first.unmount();
    renderDash(); // new mount reads the saved state
    expect((screen.getByRole('checkbox', { name: 'Ship SSO and audit logs on the Business plan' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('1 of 8 done')).toBeTruthy();
  });

  it('does not persist progress when persistence is off (demo mode)', () => {
    renderDash({ persistProgress: false });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ship SSO and audit logs on the Business plan' }));
    expect(window.localStorage.getItem('omni:roadmap:demo_report')).toBeNull();
  });

  it('survives unavailable localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderDash();
    const box = screen.getByRole('checkbox', { name: 'Ship SSO and audit logs on the Business plan' });
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(true); // still works in-session
  });

  it('shows the stale banner and regenerates', () => {
    const onRegenerate = vi.fn();
    renderDash({ stale: true, onRegenerate });
    fireEvent.click(screen.getByRole('button', { name: 'Update report' }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(onRegenerate).toHaveBeenCalledTimes(2);
  });

  it('exports Markdown as a file download including completed items', async () => {
    let blob: Blob | undefined;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:test';
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderDash();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Publish a security and compliance page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));

    expect(click).toHaveBeenCalledTimes(1);
    // jsdom's Blob has no .text(), so read it the old-fashioned way.
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob!);
    });
    expect(text).toMatch(/^# Competitive Benchmark: Acme Flow/);
    expect(text).toMatch(/- \[x\] \*\*Publish a security and compliance page\*\*/);
  });

  it('hides the regenerate controls when no handler is provided', () => {
    renderDash();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
  });
});

beforeEach(() => {
  window.localStorage.clear();
});
