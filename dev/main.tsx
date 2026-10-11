// Dev harness entry. `npm run dev:demo`, then open:
//   /            live controller against the in-memory fake backend (dev/stubs/base44Client.ts)
//   /?demo       sample-data mode
// Add ?delay=0 to make the fake backend instant.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import OmniCompetitorPage from '../pages/OmniCompetitor';
import { configureFakeBackend } from './stubs/base44Client';
import './index.css';

const params = new URLSearchParams(window.location.search);
if (params.has('delay')) configureFakeBackend({ delayMs: Number(params.get('delay')) || 0 });

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <OmniCompetitorPage initialDemo={params.has('demo')} />
    </QueryClientProvider>
  </StrictMode>,
);
