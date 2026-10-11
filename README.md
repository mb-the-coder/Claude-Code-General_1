# OmniCompetitor

Market & competitive intelligence for the Base44 platform. Give it a company website and it will:

1. **Audit** the site (messaging, value propositions, pricing, CTAs) and build a company profile.
2. **Discover** 3-5 real competitors with AI, plus any you add by hand, and profile each from its live site.
3. **Benchmark** everything into an executive dashboard: four 0-100 scores, a SWOT matrix, a feature gap matrix and a prioritized (P0/P1/P2) action roadmap with tactical steps, exportable as Markdown or PDF.

## Repository layout

Source is organized as requested; `npm run build:base44` assembles it into the layout a Base44 app expects.

| Source | Becomes (in your Base44 app) |
| --- | --- |
| `entities/*.jsonc` | `base44/entities/*.jsonc` |
| `backend/functions/<name>.ts` + `backend/utils/*` + `lib/ai/*` | `base44/functions/<name>/entry.ts` (one self-contained file per function) |
| `components/*`, `pages/OmniCompetitor.tsx`, `lib/{types,url,api,hooks,demoController,mockData,export}.ts` | `src/omnicompetitor/...` (relative imports preserved) |

```
entities/            CompanyProfile, Competitor, BenchmarkReport (owner-only row-level security)
backend/functions/   auditCompanyWebsite, discoverAndAnalyzeCompetitors, synthesizeBenchmarkReport
backend/utils/       scraper.ts (SSRF-safe fetch + HTML parsing), claudeClient.ts, report.ts, common.ts
lib/ai/              schemas.ts (Zod), prompts.ts (system prompts + prompt builders)
lib/                 types.ts, url.ts, api.ts, hooks.ts (live), demoController.ts (sample data), export.ts
components/          AuditWorkspace, CompetitorManager, ExecutiveDashboard, FeatureMatrixTable, SwotGrid, MetricCard, Modal
pages/               OmniCompetitor.tsx  (ties the three views together)
dev/                 Vite harness + in-memory fake Base44 backend for local development
tests/               unit, integration, component, hook, bundle and manifest tests (`npm test`)
```

## Try it locally (no Base44 account needed)

```bash
npm install
npm run dev:demo      # http://localhost:5173  (add ?demo for sample data, ?delay=0 for an instant fake backend)
npm run check         # typecheck + all tests + assemble
```

The dev harness runs the real UI and the real data hooks against an in-memory fake of Base44. In the UI,
**Try sample data** loads a fictional company so every screen is populated. Enter a URL containing `fail` to see the
error banner and Retry flow. Sample data is always labelled; components never fall back to it silently.

## Deploy to Base44

1. `npm run build:base44` creates `build/base44-bundle/`.
2. Copy into your Base44 app repository (the same repo the Base44 builder syncs with):
   - `build/base44-bundle/base44/entities/*` -> `base44/entities/`
   - `build/base44-bundle/base44/functions/*` -> `base44/functions/`
   - `build/base44-bundle/src/omnicompetitor/` -> `src/omnicompetitor/`
3. Register the page in `src/App.jsx`, inside the `ProtectedRoute` group:
   ```jsx
   import OmniCompetitor from '@/omnicompetitor/pages/OmniCompetitor';
   // ...
   <Route path="/omnicompetitor" element={<OmniCompetitor />} />
   ```
4. Add the app secret **`ANTHROPIC_API_KEY`** (Base44 app secrets; the platform API also exposes `POST /api/apps/{app_id}/secrets`).
   Optionally set **`ANTHROPIC_MODEL`** (default `claude-sonnet-5-5`). Never commit the key to the repository.
5. Push and publish (`base44 dashboard open`, then publish).

The page needs only packages every Base44 app already has (`react`, `@tanstack/react-query`, `lucide-react`, Tailwind).
The generated `entry.ts` files bundle `zod`, `zod-to-json-schema` and `node-html-parser`; only the platform SDK
(`npm:@base44/sdk`) stays external. They are ~600 KB unminified (mostly HTML-entity tables).

## How a run works

```
auditCompanyWebsite            -> CompanyProfile   (SCRAPING -> IDLE)
discoverAndAnalyzeCompetitors  -> Competitor[]     (SCRAPING -> IDLE)
synthesizeBenchmarkReport      -> BenchmarkReport  (SCRAPING -> ANALYZED)      any failure -> ERROR + last_error
```

The UI stepper maps these to four steps (the fourth, *Generating Report*, is loading the saved report into the dashboard).
Retry resumes from the step that failed, not from the beginning.

| Function | Input | Notes |
| --- | --- | --- |
| `auditCompanyWebsite` | `{ url, name?, industry? }` | Re-auditing a domain refreshes the existing profile. If the AI step fails the profile is still saved from page metadata (warning `AI_EXTRACTION_FAILED`). |
| `discoverAndAnalyzeCompetitors` | `{ companyProfileId, manualCompetitorUrls?, manualCompetitors?, skipDiscovery? }` | Max 8 competitors per profile. Upserts by domain, so re-runs never duplicate and never overwrite your include/exclude choices. |
| `synthesizeBenchmarkReport` | `{ companyProfileId }` | Uses competitors with `included_in_report !== false`. Updates the single report per company in place. |

### Quality guarantees in the AI layer

- **Structured output twice over:** Zod schemas are sent as a forced tool call *and* validated on return; one automatic repair round-trip feeds validation errors back to the model. Prompts also forbid Markdown-wrapped JSON, and a fenced-JSON fallback parser exists.
- **Consistency:** matrix columns are forced to the exact competitor names, duplicate/blank features are dropped, and **`feature_parity` is computed from the matrix** (weighted coverage of competitor-offered features) so the scorecard can never contradict the table.
- **Honesty about gaps:** an AI-suggested competitor whose site cannot be read is kept but flagged (analysis from general knowledge only); a *manual* competitor whose site cannot be read is reported as a failure instead of being filled with guesses.

## Security

- **Authentication:** every function calls `base44.auth.me()` and returns 401 otherwise. (Existing Base44 functions identify the caller this way rather than through a `context.user` object.)
- **Ownership:** all entities use owner-only RLS (`created_by_id == user`); functions use the user-scoped client so RLS applies, and additionally check ownership of the profile id they are given (foreign ids are indistinguishable from missing ones: 404).
- **Input sanitization:** Zod on every input; record ids are restricted to `[A-Za-z0-9_-]`, URLs are normalized to http(s) with no credentials, bodies are capped at 64 KB.
- **SSRF protection (the scraper fetches user-supplied URLs from a server):** blocks non-http(s) schemes, odd ports, internal hostnames, IP literals in private / loopback / link-local / metadata ranges (IPv4 and IPv6, including v4-mapped and NAT64), and hostnames that *resolve* to any such address; **every redirect hop is re-validated**; response size and time are capped. Residual risk: a DNS record can change between our lookup and the fetch's own lookup (rebinding); the function sandbox should not have access to internal networks.
- **Prompt injection:** scraped text is untrusted. It is wrapped in delimiter tags (with any attempt to close them neutralized) and every system prompt instructs the model to treat it as data only.
- **Output safety:** exports escape all text; the print document contains no scripts. Unexpected server errors are masked in responses (details go to logs only) and the API key is never logged or returned.
- **Cost control:** an in-flight guard rejects a second run on a profile that is already running (409), and competitor count and token budgets are capped.

## Deviations from the original spec (and why)

| Spec | What was built | Why |
| --- | --- | --- |
| `claude-3-5-sonnet` | Configurable `ANTHROPIC_MODEL`, default `claude-sonnet-5-5` | The 3.5 Sonnet model has been retired, so a hard-coded id would eventually fail; the env var lets you change models without a redeploy of code. |
| `context.user` | `base44.auth.me()` | That is how the Base44 functions in your other apps identify the caller. |
| `/entities/*.json`, `/backend/functions/*.ts` | `.jsonc` sources + an assemble step | Base44 reads `base44/entities/*.jsonc` and `base44/functions/<name>/entry.ts`; function files must be self-contained. |
| `created_by` ownership | `created_by_id: "{{user.id}}"` RLS | The rule form the platform uses. |
| Entity fields | Added `Competitor.included_in_report` and `CompanyProfile.last_error` | The include/exclude toggle and a persistent failure reason need somewhere to live. |
| `manualCompetitorUrls` | Also accepts `manualCompetitors: [{url, name}]` and `skipDiscovery` | The "Add Competitor" modal collects a name and should analyze only that competitor. |
| Dummy-data fallbacks | Explicit "Try sample data" mode | Silent fallbacks would let fake numbers pass as a real analysis. |
| Claude "tool calling or JSON mode" | Forced tool call + Zod validation + repair retry | Strongest guarantee available. |

## Known limits

- **Function run time:** a full discovery run profiles up to 8 competitors (3 at a time). Base44's function timeout is not documented in this repo; if you hit it, lower `MAX_TOTAL_COMPETITORS` in `discoverAndAnalyzeCompetitors.ts`. The UI already calls the three functions as separate steps.
- **JavaScript-rendered sites** return little HTML; the audit reports `THIN_CONTENT` and results are less detailed. Sites that block bots (HTTP 401/403/429) surface a clear message and can be added manually.
- **AI output is an estimate** based on public website content; the dashboard says so. Verify key claims before acting on them.
- The `claude-sonnet-5-5` default and the Anthropic request format were written against the documented Messages API; they have not been exercised against the live API from this environment (no key available). Run one audit after deploying to confirm.
