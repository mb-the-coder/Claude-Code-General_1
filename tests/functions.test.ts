import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import auditCompanyWebsite from '../backend/functions/auditCompanyWebsite';
import discoverAndAnalyzeCompetitors from '../backend/functions/discoverAndAnalyzeCompetitors';
import synthesizeBenchmarkReport from '../backend/functions/synthesizeBenchmarkReport';
import { FakeDb, installFakeBase44, post } from './helpers/fakeBase44';
import { installFakeNetwork, page, type ClaudeHandler } from './helpers/fakeNetwork';

const LANDING = readFileSync(new URL('./fixtures/landing.html', import.meta.url), 'utf8');

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  installFakeBase44(db);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

const extraction = {
  industry: 'B2B SaaS - Workflow automation',
  description: 'Acme Flow automates approvals and handoffs.',
  target_audience: 'Operations teams',
  value_propositions: ['Automate approvals', 'No-code builder'],
  pricing_tiers: [
    { tierName: 'Starter', price: '$29', billingPeriod: 'month', featuresSummary: '5 workflows' },
    { tierName: 'Enterprise', price: 'Custom', billingPeriod: '', featuresSummary: '' },
    { tierName: '', price: '$1', billingPeriod: '', featuresSummary: '' }, // dropped: no name
  ],
};

const analysisFor = (name: string, threat = 'MEDIUM') => ({
  name,
  threat_level: threat,
  features: { 'SSO / SAML': true, 'Public API': 'REST + webhooks', 'Free plan': false },
  pricing_summary: 'From $15/user/month.',
  strengths: ['Strong brand'],
  weaknesses: ['Expensive'],
});

const discovery = (list: Array<[string, string, string]>) => ({
  competitors: list.map(([name, url, threat_level]) => ({
    name,
    url,
    relationship: 'DIRECT',
    threat_level,
    positioning_rationale: `${name} competes for the same buyers.`,
  })),
});

function seedProfile(extra: Record<string, unknown> = {}, user = 'user_1') {
  return db.seed(
    'CompanyProfile',
    { name: 'Acme Flow', url: 'https://acmeflow.com/', industry: 'SaaS', description: 'Workflow automation', status: 'IDLE', ...extra },
    user,
  );
}

async function body(res: Response) {
  return (await res.json()) as any;
}

// ===========================================================================================
describe('auditCompanyWebsite', () => {
  const claude: ClaudeHandler = (tool) => {
    if (tool === 'submit_company_profile') return extraction;
    throw new Error('unexpected ' + tool);
  };

  it('requires authentication', async () => {
    installFakeNetwork({ claude });
    const res = await auditCompanyWebsite(post({ url: 'acmeflow.com' }, null));
    expect(res.status).toBe(401);
    expect((await body(res)).code).toBe('UNAUTHORIZED');
  });

  it('rejects non-POST methods and bad input', async () => {
    installFakeNetwork({ claude });
    expect((await auditCompanyWebsite(post({}, 'user_1', 'GET'))).status).toBe(405);
    const bad = await auditCompanyWebsite(post({ url: 'javascript:alert(1)' }));
    expect(bad.status).toBe(400);
    expect((await body(bad)).code).toBe('VALIDATION_ERROR');
    expect((await auditCompanyWebsite(post({}))).status).toBe(400);
  });

  it('blocks private targets before writing any record', async () => {
    const net = installFakeNetwork({ claude });
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:8080']) {
      const res = await auditCompanyWebsite(post({ url }));
      expect(res.status).toBe(400);
    }
    expect(db.table('CompanyProfile')).toHaveLength(0);
    expect(net.requests.filter((r) => r.kind === 'site')).toHaveLength(0);
  });

  it('does not create a record for a domain that does not resolve', async () => {
    // NXDOMAIN: the DNS-over-HTTPS lookup returns no answers for any record type.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 })));
    const res = await auditCompanyWebsite(post({ url: 'typo-domain.com' }));
    expect(res.status).toBe(422);
    expect((await body(res)).code).toBe('SCRAPE_DNS_FAILURE');
    expect(db.table('CompanyProfile')).toHaveLength(0);
  });

  it('scrapes, extracts and stores a complete profile', async () => {
    const net = installFakeNetwork({ sites: { 'acmeflow.com': LANDING }, claude });
    const res = await auditCompanyWebsite(post({ url: 'https://www.acmeflow.com', industry: 'SaaS' }));
    expect(res.status).toBe(200);
    const out = await body(res);

    expect(out.profile.status).toBe('IDLE');
    expect(out.profile.name).toBe('Acme Flow'); // from og:site_name
    expect(out.profile.industry).toBe('SaaS'); // explicit input wins over AI
    expect(out.profile.description).toBe(extraction.description);
    expect(out.profile.pricing_tiers).toEqual([
      { tierName: 'Starter', price: '$29', billingPeriod: 'month', featuresSummary: '5 workflows' },
      { tierName: 'Enterprise', price: 'Custom' },
    ]);
    expect(out.profile.raw_scraped_summary).toMatch(/H1: Stop chasing approvals/);
    expect(out.profile.raw_scraped_summary).not.toMatch(/dataLayer|<script/);
    expect(out.scrape.warnings).toEqual([]);

    // The scraped text reached Claude, wrapped as untrusted content.
    const userPrompt = net.claudeCalls[0]!.body.messages[0].content as string;
    expect(userPrompt).toMatch(/<scraped_content>[\s\S]*Stop chasing approvals[\s\S]*<\/scraped_content>/);

    // Stored exactly once, owned by the caller.
    expect(db.table('CompanyProfile')).toHaveLength(1);
    expect(db.table('CompanyProfile')[0]!.created_by_id).toBe('user_1');
  });

  it('refreshes the existing profile for the same domain instead of duplicating it', async () => {
    installFakeNetwork({ sites: { 'acmeflow.com': LANDING }, claude });
    const first = await body(await auditCompanyWebsite(post({ url: 'acmeflow.com', name: 'My Custom Name' })));
    const secondRes = await auditCompanyWebsite(post({ url: 'https://www.acmeflow.com/' }));
    expect(secondRes.status).toBe(200);
    const second = await body(secondRes);
    expect(second.profile.id).toBe(first.profile.id);
    expect(second.profile.name).toBe('My Custom Name'); // a name the user chose is not overwritten by scraping
    expect(db.table('CompanyProfile')).toHaveLength(1);
  });

  it('keeps users isolated: the same domain audited by another user is a separate record', async () => {
    installFakeNetwork({ sites: { 'acmeflow.com': LANDING }, claude });
    await auditCompanyWebsite(post({ url: 'acmeflow.com' }, 'user_1'));
    await auditCompanyWebsite(post({ url: 'acmeflow.com' }, 'user_2'));
    const rows = db.table('CompanyProfile');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.created_by_id))).toEqual(new Set(['user_1', 'user_2']));
  });

  it('marks the profile ERROR with a readable reason when the site blocks scraping', async () => {
    installFakeNetwork({ sites: { 'blocked.com': { '/': 403 } }, claude });
    const res = await auditCompanyWebsite(post({ url: 'blocked.com' }));
    expect(res.status).toBe(422);
    const out = await body(res);
    expect(out.code).toBe('SCRAPE_BLOCKED_BY_SITE');
    expect(out.retryable).toBe(false);
    expect(out.profileId).toBeTruthy();
    const stored = db.table('CompanyProfile')[0]!;
    expect(stored.status).toBe('ERROR');
    expect(stored.last_error).toMatch(/blocked automated access/);
  });

  it('degrades to page metadata when the AI step fails, and says so', async () => {
    installFakeNetwork({ sites: { 'acmeflow.com': LANDING }, claude: () => ({ nonsense: true }) });
    const res = await auditCompanyWebsite(post({ url: 'acmeflow.com' }));
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.scrape.warnings).toContain('AI_EXTRACTION_FAILED');
    expect(out.profile.description).toMatch(/automates approvals/);
    expect(out.profile.value_propositions[0]).toBe('Stop chasing approvals. Automate them.');
    expect(out.profile.status).toBe('IDLE');
  });

  it('fails clearly when the Anthropic API key is not configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    installFakeNetwork({ sites: { 'acmeflow.com': LANDING }, claude });
    const res = await auditCompanyWebsite(post({ url: 'acmeflow.com' }));
    expect(res.status).toBe(500);
    const out = await body(res);
    expect(out.code).toBe('AI_NO_API_KEY');
    expect(out.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(db.table('CompanyProfile')[0]!.status).toBe('ERROR');
  });

  it('refuses to start a second run while one is in flight, but recovers from stale locks', async () => {
    installFakeNetwork({ sites: { 'acmeflow.com': LANDING }, claude });
    seedProfile({ status: 'SCRAPING' });
    const busy = await auditCompanyWebsite(post({ url: 'acmeflow.com' }));
    expect(busy.status).toBe(409);
    expect((await body(busy)).code).toBe('ALREADY_RUNNING');
    expect(db.table('CompanyProfile')[0]!.status).toBe('SCRAPING'); // untouched

    db.table('CompanyProfile')[0]!.updated_date = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // lock is now stale
    expect((await auditCompanyWebsite(post({ url: 'acmeflow.com' }))).status).toBe(200);
  });
});

// ===========================================================================================
describe('discoverAndAnalyzeCompetitors', () => {
  const sites = {
    'rival-one.com': page('Rival One', '<p>$15 per user</p>'),
    'rival-two.io': page('Rival Two', ''),
    'indirect.co': page('Indirect Co', ''),
    'handmade.dev': page('Handmade', ''),
  };

  const claude: ClaudeHandler = (tool, req) => {
    if (tool === 'submit_competitors') {
      return discovery([
        ['Rival One', 'https://www.rival-one.com', 'CRITICAL'],
        ['Rival Two', 'rival-two.io', 'HIGH'],
        ['Indirect Co', 'https://indirect.co', 'LOW'],
        ['Acme Flow Itself', 'https://acmeflow.com', 'HIGH'], // the target: must be dropped
        ['Bad URL', 'not a url at all', 'LOW'], // unusable: must be dropped
      ]);
    }
    if (tool === 'submit_competitor_profile') {
      const m = /Website: (\S+)/.exec(req.messages[0].content);
      return analysisFor(`Analyzed ${m?.[1]}`, 'LOW');
    }
    throw new Error('unexpected ' + tool);
  };

  it('requires auth and ownership', async () => {
    installFakeNetwork({ sites, claude });
    const profile = seedProfile({}, 'user_2');
    expect((await discoverAndAnalyzeCompetitors(post({ companyProfileId: profile.id }, null))).status).toBe(401);
    const foreign = await discoverAndAnalyzeCompetitors(post({ companyProfileId: profile.id }, 'user_1'));
    expect(foreign.status).toBe(404);
    expect((await body(foreign)).code).toBe('PROFILE_NOT_FOUND');
    expect((await discoverAndAnalyzeCompetitors(post({ companyProfileId: '{"$ne":1}' }))).status).toBe(400);
  });

  it('discovers, validates, analyzes and stores competitors', async () => {
    const net = installFakeNetwork({ sites, claude });
    const profile = seedProfile();
    const res = await discoverAndAnalyzeCompetitors(post({ companyProfileId: profile.id }));
    expect(res.status).toBe(200);
    const out = await body(res);

    expect(out.competitors).toHaveLength(3); // target + invalid URL were dropped
    expect(out.counts).toMatchObject({ aiDiscovered: 3, manual: 0, created: 3, updated: 0 });
    expect(out.failures).toEqual([]);

    const byName = Object.fromEntries(out.competitors.map((c: any) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(['Indirect Co', 'Rival One', 'Rival Two']);
    expect(byName['Rival One']).toMatchObject({
      source: 'AI_DISCOVERED',
      threat_level: 'CRITICAL', // taken from the discovery stage, not the per-site analysis
      company_profile_id: profile.id,
      included_in_report: true,
      url: 'https://www.rival-one.com/',
      pricing_summary: 'From $15/user/month.',
    });
    expect(byName['Rival One'].discovery_rationale).toMatch(/competes for the same buyers/);
    expect(byName['Rival One'].features['SSO / SAML']).toBe(true);

    expect(db.table('Competitor')).toHaveLength(3);
    expect(db.table('CompanyProfile')[0]!.status).toBe('IDLE');
    expect(net.siteHits('rival-one.com')).toBeGreaterThan(0);
  });

  it('merges manual competitors, excludes them from discovery and keeps them manual', async () => {
    const net = installFakeNetwork({ sites, claude });
    const profile = seedProfile();
    const res = await discoverAndAnalyzeCompetitors(
      post({
        companyProfileId: profile.id,
        manualCompetitorUrls: ['handmade.dev', 'https://www.handmade.dev/about', 'acmeflow.com'],
        manualCompetitors: [{ url: 'rival-one.com', name: 'My Rival' }],
      }),
    );
    const out = await body(res);
    expect(res.status).toBe(200);

    const manual = out.competitors.filter((c: any) => c.source === 'MANUAL_INPUT');
    expect(manual.map((c: any) => c.name).sort()).toEqual(['Analyzed https://handmade.dev/', 'My Rival']);
    expect(out.counts.manual).toBe(2);

    // rival-one was claimed by the user, so the AI copy is deduped away (no second record for it)
    expect(db.table('Competitor').filter((c) => c.url.includes('rival-one'))).toHaveLength(1);
    const discoveryPrompt = net.claudeCalls.find((c) => c.toolName === 'submit_competitors')!.body.messages[0].content as string;
    expect(discoveryPrompt).toMatch(/<excluded_domains>[\s\S]*rival-one\.com[\s\S]*handmade\.dev[\s\S]*<\/excluded_domains>/);
  });

  it('upserts on re-run: no duplicates, manual source and include flag are preserved', async () => {
    installFakeNetwork({ sites, claude });
    const profile = seedProfile();
    await discoverAndAnalyzeCompetitors(post({ companyProfileId: profile.id, manualCompetitorUrls: ['handmade.dev'] }));
    const [handmade] = db.table('Competitor').filter((c) => c.url.includes('handmade'));
    handmade!.included_in_report = false; // user toggled it off
    const rival = db.table('Competitor').find((c) => c.url.includes('rival-one'))!;
    rival.included_in_report = false;

    const again = await body(await discoverAndAnalyzeCompetitors(post({ companyProfileId: profile.id, manualCompetitorUrls: ['handmade.dev'] })));
    expect(again.counts.created).toBe(0);
    expect(again.counts.updated).toBe(4);
    expect(db.table('Competitor')).toHaveLength(4);
    expect(db.table('Competitor').find((c) => c.url.includes('handmade'))).toMatchObject({ source: 'MANUAL_INPUT', included_in_report: false });
    expect(db.table('Competitor').find((c) => c.url.includes('rival-one'))!.included_in_report).toBe(false);
  });

  it('keeps an AI competitor whose site is unreadable (flagged) but reports an unreadable MANUAL one as a failure', async () => {
    installFakeNetwork({ sites: { 'rival-two.io': page('Rival Two', ''), 'indirect.co': page('Indirect', '') }, claude });
    const profile = seedProfile();
    const out = await body(
      await discoverAndAnalyzeCompetitors(post({ companyProfileId: profile.id, manualCompetitorUrls: ['dead-site.com'] })),
    );
    const rivalOne = out.competitors.find((c: any) => c.url.includes('rival-one'));
    expect(rivalOne.discovery_rationale).toMatch(/could not be read/);
    expect(out.failures).toEqual([expect.objectContaining({ url: 'https://dead-site.com/', reason: expect.stringMatching(/HTTP 404/) })]);
    expect(out.competitors.some((c: any) => c.url.includes('dead-site'))).toBe(false);
  });

  it('skipDiscovery analyzes only the manual competitor and never calls discovery', async () => {
    const net = installFakeNetwork({ sites, claude });
    const profile = seedProfile({ status: 'ANALYZED' });
    const res = await discoverAndAnalyzeCompetitors(
      post({ companyProfileId: profile.id, skipDiscovery: true, manualCompetitors: [{ url: 'handmade.dev', name: 'Handmade' }] }),
    );
    const out = await body(res);
    expect(res.status).toBe(200);
    expect(out.competitors).toHaveLength(1);
    expect(out.competitors[0]).toMatchObject({ name: 'Handmade', source: 'MANUAL_INPUT', included_in_report: true });
    expect(net.claudeCalls.map((c) => c.toolName)).not.toContain('submit_competitors');
  });

  it('a failed manual add leaves an ANALYZED profile ANALYZED', async () => {
    installFakeNetwork({ sites: {}, claude });
    const profile = seedProfile({ status: 'ANALYZED' });
    const res = await discoverAndAnalyzeCompetitors(
      post({ companyProfileId: profile.id, skipDiscovery: true, manualCompetitorUrls: ['nowhere.example'] }),
    );
    expect(res.status).toBe(502);
    expect((await body(res)).code).toBe('NO_COMPETITORS_ANALYZED');
    expect(db.table('CompanyProfile')[0]!.status).toBe('ANALYZED');
  });

  it('marks the profile ERROR when a full discovery run produces nothing', async () => {
    installFakeNetwork({ sites, claude: (tool) => (tool === 'submit_competitors' ? discovery([['Self', 'https://acmeflow.com', 'LOW'], ['B', 'https://acmeflow.com', 'LOW'], ['C', 'https://acmeflow.com', 'LOW']]) : analysisFor('x')) });
    const profile = seedProfile();
    const res = await discoverAndAnalyzeCompetitors(post({ companyProfileId: profile.id }));
    expect(res.status).toBe(502);
    expect((await body(res)).code).toBe('NO_COMPETITORS_FOUND');
    expect(db.table('CompanyProfile')[0]!.status).toBe('ERROR');
  });

  it('caps the total at 8 competitors', async () => {
    installFakeNetwork({
      sites: Object.fromEntries(['m1', 'm2', 'm3', 'm4', 'm5', 'rival-one', 'rival-two', 'indirect'].map((h) => [`${h}.${h.startsWith('rival-two') ? 'io' : 'com'}`, page(h, '')])),
      claude,
    });
    const profile = seedProfile();
    const out = await body(
      await discoverAndAnalyzeCompetitors(post({ companyProfileId: profile.id, manualCompetitorUrls: ['m1.com', 'm2.com', 'm3.com', 'm4.com', 'm5.com'] })),
    );
    expect(out.competitors.length).toBeLessThanOrEqual(8);
    expect(out.counts.manual).toBe(5);
    expect(out.counts.aiDiscovered).toBeLessThanOrEqual(3);
  });
});

// ===========================================================================================
describe('synthesizeBenchmarkReport', () => {
  const reportFor = (names: string[]) => ({
    scores: { overall_health: 72.4, market_positioning: 66, pricing_competitiveness: 58, feature_parity: 95 },
    executive_summary: 'Acme Flow is well positioned but lags on enterprise readiness.',
    swot: { strengths: ['Clear value prop'], weaknesses: ['No SSO'], opportunities: ['Mid-market'], threats: ['Incumbents'] },
    feature_matrix: [
      { featureName: 'SSO / SAML', targetHas: false, competitors: Object.fromEntries(names.map((n) => [n.toUpperCase(), true])), gapImpact: 'HIGH' },
      { featureName: 'Public API', targetHas: true, competitors: Object.fromEntries(names.map((n, i) => [n, i === 0])), gapImpact: 'LOW' },
    ],
    recommendations: [
      { priority: 'P1', category: 'Pricing', title: 'Add annual plan', impact: 'Improves retention', effort: 'LOW', tacticalSteps: ['Design plan'] },
      { priority: 'P0', category: 'Product', title: 'Ship SSO', impact: 'Unblocks enterprise', effort: 'MED', tacticalSteps: ['Scope SAML', 'Build', 'Launch'] },
    ],
  });

  const seedCompetitors = (profileId: string, extra: Array<Record<string, unknown>> = []) => {
    const base = [
      { name: 'Rival One', url: 'https://rival-one.com/', threat_level: 'CRITICAL' },
      { name: 'Rival Two', url: 'https://rival-two.io/', threat_level: 'HIGH' },
      ...extra,
    ];
    return base.map((c) => db.seed('Competitor', { company_profile_id: profileId, source: 'AI_DISCOVERED', included_in_report: true, strengths: ['s'], weaknesses: ['w'], features: { 'SSO / SAML': true }, pricing_summary: '$10', ...c }, 'user_1'));
  };

  const claude: ClaudeHandler = (tool, req) => {
    if (tool !== 'submit_benchmark_report') throw new Error('unexpected ' + tool);
    const keys = /exactly these keys: ([^\n]+)\./.exec(req.messages[0].content)![1]!.split(', ').map((k) => k.replace(/"/g, ''));
    return reportFor(keys);
  };

  it('requires auth, ownership and at least one included competitor', async () => {
    installFakeNetwork({ claude });
    const profile = seedProfile();
    expect((await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }, null))).status).toBe(401);
    expect((await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }, 'user_2'))).status).toBe(404);
    const none = await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }));
    expect(none.status).toBe(400);
    expect((await body(none)).code).toBe('NO_COMPETITORS');

    seedCompetitors(profile.id).forEach((c) => (c.included_in_report = false));
    expect((await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }))).status).toBe(400);
  });

  it('generates, normalizes and stores the report, then marks the company ANALYZED', async () => {
    const net = installFakeNetwork({ claude });
    const profile = seedProfile();
    seedCompetitors(profile.id);
    const res = await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }));
    expect(res.status).toBe(200);
    const out = await body(res);

    expect(out.competitorsUsed).toEqual(['Rival One', 'Rival Two']);
    const r = out.report;
    expect(r).toMatchObject({
      company_profile_id: profile.id,
      overall_health_score: 72,
      market_positioning_score: 66,
      pricing_competitiveness_score: 58,
    });
    // Computed from the matrix, not the model's 95: SSO (HIGH, both rivals, target lacks) = 3 weight uncovered;
    // Public API (LOW, 1 of 2 rivals, target has) = 0.5 weight covered -> 0.5 / 3.5 = 14%.
    expect(r.feature_parity_score).toBe(14);
    expect(r.feature_matrix[0].competitors).toEqual({ 'Rival One': true, 'Rival Two': true }); // keys normalized from "RIVAL ONE"
    expect(r.actionable_recommendations.map((x: any) => x.priority)).toEqual(['P0', 'P1']);
    expect(r.swot.weaknesses).toEqual(['No SSO']);
    expect(Date.parse(r.last_analyzed_at)).not.toBeNaN();

    expect(db.table('BenchmarkReport')).toHaveLength(1);
    expect(db.table('CompanyProfile')[0]!.status).toBe('ANALYZED');

    // The user prompt lists the real data; the system prompt forbids Markdown-wrapped JSON.
    const call = net.claudeCalls[0]!;
    expect(call.body.system).toMatch(/NEVER wrap the JSON in Markdown/);
    expect(call.body.tool_choice).toEqual({ type: 'tool', name: 'submit_benchmark_report' });
    expect(call.body.messages[0].content).toMatch(/Rival One[\s\S]*Rival Two/);
  });

  it('updates the existing report in place on re-run', async () => {
    installFakeNetwork({ claude });
    const profile = seedProfile();
    seedCompetitors(profile.id);
    await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }));
    const firstId = db.table('BenchmarkReport')[0]!.id;
    await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }));
    expect(db.table('BenchmarkReport')).toHaveLength(1);
    expect(db.table('BenchmarkReport')[0]!.id).toBe(firstId);
  });

  it('leaves excluded competitors out of the prompt and the matrix', async () => {
    const net = installFakeNetwork({ claude });
    const profile = seedProfile();
    const [, two] = seedCompetitors(profile.id);
    two!.included_in_report = false;
    const out = await body(await synthesizeBenchmarkReport(post({ companyProfileId: profile.id })));
    expect(out.competitorsUsed).toEqual(['Rival One']);
    expect(net.claudeCalls[0]!.body.messages[0].content).not.toMatch(/Rival Two/);
    expect(Object.keys(out.report.feature_matrix[0].competitors)).toEqual(['Rival One']);
  });

  it('gives same-named competitors unique matrix keys', async () => {
    installFakeNetwork({ claude });
    const profile = seedProfile();
    seedCompetitors(profile.id, [{ name: 'Rival One', url: 'https://rival-one.org/', threat_level: 'LOW' }]);
    const out = await body(await synthesizeBenchmarkReport(post({ companyProfileId: profile.id })));
    expect(new Set(out.competitorsUsed).size).toBe(3);
    expect(out.competitorsUsed).toEqual(expect.arrayContaining(['Rival One (rival-one.com)', 'Rival One (rival-one.org)']));
  });

  it('returns a retryable AI error and flags the profile when the model output is unusable', async () => {
    installFakeNetwork({ claude: () => ({ scores: { overall_health: 500 } }) });
    const profile = seedProfile();
    seedCompetitors(profile.id);
    const res = await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }));
    expect(res.status).toBe(502);
    const out = await body(res);
    expect(out).toMatchObject({ code: 'AI_INVALID_OUTPUT', retryable: true, profileId: profile.id });
    expect(db.table('CompanyProfile')[0]!.status).toBe('ERROR');
    expect(db.table('BenchmarkReport')).toHaveLength(0);
  });

  it('never leaks internal error details for unexpected failures', async () => {
    installFakeNetwork({ claude });
    const profile = seedProfile();
    seedCompetitors(profile.id);
    db.failOn('BenchmarkReport', 'create', new Error('db password=hunter2 leaked'));
    const res = await synthesizeBenchmarkReport(post({ companyProfileId: profile.id }));
    expect(res.status).toBe(500);
    const out = await body(res);
    expect(out.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(out)).not.toMatch(/hunter2/);
    expect(db.table('CompanyProfile')[0]!.status).toBe('ERROR');
  });
});
