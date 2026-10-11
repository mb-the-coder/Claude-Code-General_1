// Runs under DENO (not Node). Loads the production function bundles produced by scripts/deno-smoke.mjs
// and drives them end to end with an in-memory Base44 fake and a stubbed network, so the real artifacts
// are exercised on the real runtime: npm: imports, Deno globals, fetch, streams, TextDecoder, etc.
//   deno run --allow-net --allow-env --allow-read scripts/deno-harness.ts <dir-with-bundles>

type Rec = Record<string, any> & { id: string };
const dir = Deno.args[0]!;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

// ---- fake Base44 SDK (owner-only like RLS) ------------------------------------------------------
const tables: Record<string, Rec[]> = { CompanyProfile: [], Competitor: [], BenchmarkReport: [] };
let counter = 0;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
function entity(name: string, user: string) {
  const mine = () => tables[name]!.filter((r) => r.created_by_id === user);
  const sortBy = (rows: Rec[], sort?: string) => {
    if (!sort) return rows;
    const desc = sort.startsWith('-');
    const key = desc ? sort.slice(1) : sort;
    return [...rows].sort((a, b) => (String(a[key] ?? '') < String(b[key] ?? '') ? -1 : 1) * (desc ? -1 : 1));
  };
  return {
    get: async (id: string) => {
      const r = mine().find((x) => x.id === id);
      if (!r) throw new Error('not found');
      return clone(r);
    },
    list: async (sort?: string, limit = 50) => clone(sortBy(mine(), sort).slice(0, limit)),
    filter: async (q: Record<string, unknown>, sort?: string, limit = 50) =>
      clone(sortBy(mine().filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)), sort).slice(0, limit)),
    create: async (d: Record<string, any>) => {
      const now = new Date().toISOString();
      const r: Rec = { ...clone(d), id: `${name}_${++counter}`, created_by_id: user, created_date: now, updated_date: now };
      tables[name]!.push(r);
      return clone(r);
    },
    update: async (id: string, d: Record<string, any>) => {
      const r = mine().find((x) => x.id === id);
      if (!r) throw new Error('not found');
      Object.assign(r, clone(d), { updated_date: new Date().toISOString() });
      return clone(r);
    },
    delete: async () => ({}),
  };
}
(globalThis as any).__base44Factory = (req: Request) => {
  const user = req.headers.get('x-test-user');
  return {
    auth: { me: async () => (user ? { id: user } : null) },
    entities: new Proxy({}, { get: (_t, n: string) => entity(n, user ?? '__anon__') }),
  };
};

// ---- stubbed network ---------------------------------------------------------------------------------
const page = (title: string, extra = '') =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${title} automates approvals."/></head><body><nav><a href="/pricing">Pricing</a></nav><h1>${title}</h1><h2>Why us</h2><p>${'Real marketing copy about the product. '.repeat(15)}</p>${extra}</body></html>`;
const sites: Record<string, string> = {
  'acmeflow.test': page('Acme Flow', '<div class="pricing"><h3>Starter</h3><p>$29 per month</p></div>'),
  'rival-one.test': page('Rival One'),
  'rival-two.test': page('Rival Two'),
  'rival-three.test': page('Rival Three'),
};
const analysis = (name: string) => ({
  name,
  threat_level: 'MEDIUM',
  features: { 'Public API': true, 'SSO / SAML': 'Enterprise plan', 'Free plan': false },
  pricing_summary: 'From $20 per user per month.',
  strengths: ['Strong brand'],
  weaknesses: ['Expensive'],
});
let claudeCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') {
    const name = url.searchParams.get('name')!;
    const A = url.searchParams.get('type') === 'A';
    return new Response(JSON.stringify({ Status: 0, Answer: A ? [{ name, type: 1, data: '93.184.216.34' }] : [] }), { headers: { 'content-type': 'application/dns-json' } });
  }
  if (url.hostname === 'api.anthropic.com') {
    claudeCalls++;
    const body = JSON.parse(String(init?.body));
    const tool = body.tool_choice.name as string;
    const prompt = body.messages[0].content as string;
    let input_: unknown;
    if (tool === 'submit_company_profile') {
      input_ = { industry: 'SaaS', description: 'Automates approvals.', target_audience: 'Ops teams', value_propositions: ['Fast'], pricing_tiers: [{ tierName: 'Starter', price: '$29', billingPeriod: 'month', featuresSummary: '' }] };
    } else if (tool === 'submit_competitors') {
      input_ = {
        competitors: ['one', 'two', 'three'].map((n, i) => ({
          name: `Rival ${n[0]!.toUpperCase()}${n.slice(1)}`,
          url: `https://rival-${n}.test`,
          relationship: 'DIRECT',
          threat_level: ['CRITICAL', 'HIGH', 'MEDIUM'][i],
          positioning_rationale: 'Competes for the same buyers.',
        })),
      };
    } else if (tool === 'submit_competitor_profile') {
      input_ = analysis(/Website: https:\/\/rival-(\w+)\.test/.exec(prompt)?.[1] ?? 'x');
    } else if (tool === 'submit_benchmark_report') {
      const keys = /exactly these keys: ([^\n]+)\./.exec(prompt)![1]!.split(', ').map((k) => k.replace(/"/g, ''));
      input_ = {
        scores: { overall_health: 71, market_positioning: 66, pricing_competitiveness: 58, feature_parity: 90 },
        executive_summary: 'Well positioned, with gaps in enterprise readiness.',
        swot: { strengths: ['a'], weaknesses: ['b'], opportunities: ['c'], threats: ['d'] },
        feature_matrix: [
          { featureName: 'SSO / SAML', targetHas: false, competitors: Object.fromEntries(keys.map((k) => [k.toUpperCase(), true])), gapImpact: 'HIGH' },
          { featureName: 'Public API', targetHas: true, competitors: Object.fromEntries(keys.map((k) => [k, true])), gapImpact: 'LOW' },
        ],
        recommendations: [
          { priority: 'P1', category: 'Pricing', title: 'Add annual plan', impact: 'Retention', effort: 'LOW', tacticalSteps: ['Design plan'] },
          { priority: 'P0', category: 'Product', title: 'Ship SSO', impact: 'Unblocks enterprise', effort: 'MED', tacticalSteps: ['Scope', 'Build'] },
        ],
      };
    } else {
      return new Response('{}', { status: 400 });
    }
    return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: tool, input: input_ }] }), { headers: { 'content-type': 'application/json' } });
  }
  const host = url.hostname.replace(/^www\./, '');
  const html = sites[host];
  if (!html || (url.pathname !== '/' && url.pathname !== '')) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}) as typeof fetch;
void realFetch;

// ---- drive the real bundles --------------------------------------------------------------------------
const load = async (name: string) => (await import(`file://${dir}/${name}.ts`)).default as (req: Request) => Promise<Response>;
const call = (fn: (r: Request) => Promise<Response>, body: unknown, user: string | null = 'user_1') =>
  fn(new Request('https://app.test/fn', { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) }));

Deno.env.set('ANTHROPIC_API_KEY', 'test-key');
const audit = await load('auditCompanyWebsite');
const discover = await load('discoverAndAnalyzeCompetitors');
const synthesize = await load('synthesizeBenchmarkReport');
check('all three bundles import on Deno (npm: deps resolve)', typeof audit === 'function' && typeof discover === 'function' && typeof synthesize === 'function');

check('unauthenticated -> 401', (await call(audit, { url: 'acmeflow.test' }, null)).status === 401);
const ssrf = await call(audit, { url: 'http://169.254.169.254/latest/meta-data/' });
check('metadata IP blocked -> 400', ssrf.status === 400, String(ssrf.status));
check('no record created for blocked target', tables.CompanyProfile!.length === 0);

const a = await call(audit, { url: 'acmeflow.test', industry: 'SaaS' });
const aBody = await a.json();
check('audit -> 200', a.status === 200, JSON.stringify(aBody).slice(0, 300));
check('audit built the profile from the page', aBody.profile?.name === 'Acme Flow' && aBody.profile?.status === 'IDLE' && /H1: Acme Flow/.test(aBody.profile?.raw_scraped_summary ?? ''), aBody.profile?.name);
check('audit extracted pricing tier', aBody.profile?.pricing_tiers?.[0]?.tierName === 'Starter');

const d = await call(discover, { companyProfileId: aBody.profile.id });
const dBody = await d.json();
check('discover -> 200 with 3 competitors', d.status === 200 && dBody.competitors?.length === 3, JSON.stringify(dBody).slice(0, 300));
check('threat levels come from discovery', dBody.competitors?.map((c: any) => c.threat_level).sort().join() === 'CRITICAL,HIGH,MEDIUM');

const m = await call(discover, { companyProfileId: aBody.profile.id, skipDiscovery: true, manualCompetitors: [{ url: 'rival-three.test', name: 'Mine' }] });
check('manual add re-uses the same record (upsert)', m.status === 200 && tables.Competitor!.length === 3, String(tables.Competitor!.length));

const s = await call(synthesize, { companyProfileId: aBody.profile.id });
const sBody = await s.json();
check('synthesize -> 200', s.status === 200, JSON.stringify(sBody).slice(0, 300));
check('feature parity is computed from the matrix, not the model', sBody.report?.feature_parity_score === 25, String(sBody.report?.feature_parity_score));
check('matrix keys normalized to competitor names', Object.keys(sBody.report?.feature_matrix?.[0]?.competitors ?? {}).length === 3);
check('recommendations sorted P0 first', sBody.report?.actionable_recommendations?.[0]?.priority === 'P0');
check('profile marked ANALYZED', tables.CompanyProfile![0]!.status === 'ANALYZED');
check('another user cannot read it (RLS + ownership)', (await call(synthesize, { companyProfileId: aBody.profile.id }, 'user_2')).status === 404);
check('Claude was called (profile + discovery + 3 analyses + report)', claudeCalls >= 6, String(claudeCalls));

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, failed }, null, 2));
Deno.exit(failed.length ? 1 : 0);
