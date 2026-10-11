// Development / test stand-in for `@/api/base44Client` (aliased by dev/vite.config.ts, vitest and tsconfig).
// Behaves like a tiny in-memory Base44 backend: owner-less entity CRUD plus fake implementations of the
// three backend functions, so the *live* controller (lib/hooks.ts) can be exercised without Base44.
// In a real Base44 app this module is the app's own generated client and this file is not used.

import { MOCK_COMPETITORS, MOCK_PROFILE, MOCK_REPORT } from '../../lib/mockData';
import { hostKey, nameFromUrl, normalizeUrl } from '../../lib/url';

type Rec = Record<string, any> & { id: string };
type EntityName = 'CompanyProfile' | 'Competitor' | 'BenchmarkReport';

interface FakeEntity {
  list(sort?: string, limit?: number): Promise<any[]>;
  filter(query: Record<string, unknown>, sort?: string, limit?: number): Promise<any[]>;
  create(data: Record<string, any>): Promise<any>;
  update(id: string, data: Record<string, any>): Promise<any>;
  delete(id: string): Promise<unknown>;
}

const db: Record<EntityName, Rec[]> = { CompanyProfile: [], Competitor: [], BenchmarkReport: [] };
let counter = 0;
let failedOnce = false;
let delayMs = 450;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const wait = () => (delayMs > 0 ? new Promise<void>((r) => setTimeout(r, delayMs)) : Promise.resolve());

export function configureFakeBackend(options: { delayMs?: number }) {
  if (options.delayMs !== undefined) delayMs = options.delayMs;
}

export function resetFakeBackend() {
  db.CompanyProfile = [];
  db.Competitor = [];
  db.BenchmarkReport = [];
  counter = 0;
  failedOnce = false;
}

/** Test helper: direct access to stored rows. */
export const fakeDb = db;

function sortRecs(recs: Rec[], sort?: string): Rec[] {
  if (!sort) return recs;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  return [...recs].sort((a, b) => (String(a[key] ?? '') < String(b[key] ?? '') ? -1 : String(a[key] ?? '') > String(b[key] ?? '') ? 1 : 0) * (desc ? -1 : 1));
}

function entity(name: EntityName): FakeEntity {
  return {
    list: async (sort, limit) => (await wait(), clone(sortRecs(db[name], sort).slice(0, limit ?? 50))),
    filter: async (query, sort, limit) => (
      await wait(),
      clone(sortRecs(db[name].filter((r) => Object.entries(query).every(([k, v]) => r[k] === v)), sort).slice(0, limit ?? 50))
    ),
    create: async (data) => {
      const rec: Rec = { ...clone(data), id: `${name}_${++counter}`, created_date: new Date().toISOString(), updated_date: new Date().toISOString() };
      db[name].push(rec);
      return clone(rec);
    },
    update: async (id, data) => {
      await wait();
      const rec = db[name].find((r) => r.id === id);
      if (!rec) throw { response: { status: 404, data: { error: 'Not found' } } };
      Object.assign(rec, clone(data), { updated_date: new Date().toISOString() });
      return clone(rec);
    },
    delete: async (id) => {
      await wait();
      const i = db[name].findIndex((r) => r.id === id);
      if (i === -1) throw { response: { status: 404, data: { error: 'Not found' } } };
      db[name].splice(i, 1);
      return { ok: true };
    },
  };
}

const httpError = (status: number, error: string, code: string, extra: Record<string, unknown> = {}) => ({
  message: `Request failed with status code ${status}`,
  response: { status, data: { error, code, retryable: status >= 500, ...extra } },
});

async function auditCompanyWebsite(payload: any) {
  await wait();
  let url: string;
  try {
    url = normalizeUrl(String(payload?.url ?? ''));
  } catch (e) {
    throw httpError(400, (e as Error).message, 'VALIDATION_ERROR');
  }
  const profiles = db.CompanyProfile;
  let profile = profiles.find((p) => hostKey(p.url) === hostKey(url));
  if (!profile) {
    profile = (await entity('CompanyProfile').create({ ...MOCK_PROFILE, id: undefined, name: payload.name || nameFromUrl(url), url, status: 'SCRAPING', raw_scraped_summary: '' })) as Rec;
    profile = db.CompanyProfile.find((p) => p.id === profile!.id)!;
  }
  if (/fail/i.test(url) && !failedOnce) {
    failedOnce = true;
    Object.assign(profile, { status: 'ERROR', last_error: 'The site blocked automated access (HTTP 403).' });
    throw httpError(422, 'The site blocked automated access (HTTP 403). Try a different page or add the competitor manually.', 'SCRAPE_BLOCKED_BY_SITE', { profileId: profile.id, retryable: false });
  }
  Object.assign(profile, { name: payload.name || profile.name, industry: payload.industry || MOCK_PROFILE.industry, status: 'IDLE', last_error: '', updated_date: new Date().toISOString() });
  return { data: { profile: clone(profile), scrape: { finalUrl: url, pagesFetched: 2, warnings: ['NO_PUBLIC_PRICING_FOUND'] } } };
}

async function discoverAndAnalyzeCompetitors(payload: any) {
  await wait();
  const profile = db.CompanyProfile.find((p) => p.id === payload?.companyProfileId);
  if (!profile) throw httpError(404, 'Company profile not found.', 'PROFILE_NOT_FOUND');
  const manual: Array<{ url: string; name?: string }> = [...(payload.manualCompetitors ?? []), ...(payload.manualCompetitorUrls ?? []).map((url: string) => ({ url }))];
  const created: Rec[] = [];
  const failures: Array<{ name: string; url: string; reason: string }> = [];

  for (const m of manual) {
    if (/fail/i.test(m.url)) {
      failures.push({ name: m.name ?? nameFromUrl(m.url), url: m.url, reason: 'The page could not be loaded (HTTP 404).' });
      continue;
    }
    created.push((await entity('Competitor').create({
      ...MOCK_COMPETITORS[2], id: undefined, company_profile_id: profile.id, name: m.name || nameFromUrl(m.url), url: normalizeUrl(m.url), source: 'MANUAL_INPUT', included_in_report: true,
    })) as Rec);
  }
  if (!payload.skipDiscovery) {
    for (const c of MOCK_COMPETITORS.filter((x) => x.source === 'AI_DISCOVERED')) {
      if (db.Competitor.some((x) => x.company_profile_id === profile.id && hostKey(x.url) === hostKey(c.url))) continue;
      created.push((await entity('Competitor').create({ ...c, id: undefined, company_profile_id: profile.id, included_in_report: true })) as Rec);
    }
  }
  if (created.length === 0) {
    throw httpError(502, failures[0]?.reason ? `None of the competitors could be analyzed (${failures[0].reason})` : 'No usable competitors were found.', 'NO_COMPETITORS_ANALYZED');
  }
  profile.status = 'IDLE';
  return { data: { competitors: clone(created), failures, counts: { aiDiscovered: created.filter((c) => c.source === 'AI_DISCOVERED').length, manual: created.filter((c) => c.source === 'MANUAL_INPUT').length, created: created.length, updated: 0 } } };
}

async function synthesizeBenchmarkReport(payload: any) {
  await wait();
  const profile = db.CompanyProfile.find((p) => p.id === payload?.companyProfileId);
  if (!profile) throw httpError(404, 'Company profile not found.', 'PROFILE_NOT_FOUND');
  const included = db.Competitor.filter((c) => c.company_profile_id === profile.id && c.included_in_report !== false);
  if (included.length === 0) throw httpError(400, 'Add or enable at least one competitor before generating a report.', 'NO_COMPETITORS');
  const names = included.map((c) => c.name);
  const fields = {
    ...clone(MOCK_REPORT),
    id: undefined,
    company_profile_id: profile.id,
    feature_matrix: MOCK_REPORT.feature_matrix.map((row) => ({ ...row, competitors: Object.fromEntries(names.map((n) => [n, row.competitors[n] ?? false])) })),
    last_analyzed_at: new Date().toISOString(),
  };
  const existing = db.BenchmarkReport.find((r) => r.company_profile_id === profile.id);
  const report = existing ? Object.assign(existing, fields, { id: existing.id }) : ((await entity('BenchmarkReport').create(fields)) as Rec);
  profile.status = 'ANALYZED';
  return { data: { report: clone(report), competitorsUsed: names } };
}

const handlers: Record<string, (payload: any) => Promise<{ data: unknown }>> = { auditCompanyWebsite, discoverAndAnalyzeCompetitors, synthesizeBenchmarkReport };

export const base44 = {
  entities: { CompanyProfile: entity('CompanyProfile'), Competitor: entity('Competitor'), BenchmarkReport: entity('BenchmarkReport') } as Record<EntityName, FakeEntity>,
  functions: {
    invoke: async (name: string, payload: unknown) => {
      const handler = handlers[name];
      if (!handler) throw httpError(404, `Unknown function ${name}`, 'NOT_FOUND');
      return handler(payload);
    },
  },
};
