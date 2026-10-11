// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureFakeBackend, resetFakeBackend } from '../dev/stubs/base44Client';
import OmniCompetitorPage from '../pages/OmniCompetitor';

function renderPage(props: Parameters<typeof OmniCompetitorPage>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OmniCompetitorPage {...props} />
    </QueryClientProvider>,
  );
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

describe('OmniCompetitorPage', () => {
  it('starts on the Audit view with empty live data and disabled result tabs', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /See exactly where you stand/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Competitors' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Dashboard' }) as HTMLButtonElement).disabled).toBe(true);
    // No sample-data banner in live mode (the toggle button's own label also says "sample data", so look for the banner text).
    expect(screen.queryByText(/fictional companies/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try sample data' })).toBeTruthy();
  });

  it('shows a clearly labelled sample-data banner and the sample dashboard in demo mode', () => {
    renderPage({ initialDemo: true });
    expect(screen.getByRole('status').textContent).toMatch(/sample data/);
    expect(screen.getByRole('heading', { level: 1, name: 'Acme Flow' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Exit sample data' }));
    expect(screen.queryByText(/fictional companies/)).toBeNull();
  });

  it('navigates between the three views', () => {
    renderPage({ initialDemo: true });
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Competitors' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    expect(screen.getByRole('heading', { name: /See exactly where you stand/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(screen.getByRole('heading', { name: 'Executive summary' })).toBeTruthy();
  });

  it('only shows Sign out when a handler is provided, and calls it', () => {
    const { unmount } = renderPage({ initialDemo: true });
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    unmount();
    const onSignOut = vi.fn();
    renderPage({ initialDemo: true, onSignOut });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('runs a full live audit through the real controller and lands on the dashboard', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Company website URL'), { target: { value: 'globex.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run Intelligence Audit' }));
    expect(await screen.findByRole('heading', { name: 'Executive summary' }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Globex' })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Competitors' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
