// Smoke-tests the exact artifacts that get deployed: bundles each function with the production
// esbuild config (SDK swapped for the test stub), then runs the BUNDLED code end to end.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FUNCTION_NAMES, NPM_DEPS, ROOT, bundleFunction, findUnresolvedImports, npmSpecifier } from '../scripts/lib.mjs';
import { FakeDb, installFakeBase44, post } from './helpers/fakeBase44';
import { installFakeNetwork, page } from './helpers/fakeNetwork';

const STUB = fileURLToPath(new URL('./stubs/base44-sdk.ts', import.meta.url));
const OUT_DIR = path.join(ROOT, 'build', 'test-bundles');

async function loadBundled(name: string) {
  const code = await bundleFunction(name, { alias: { 'npm:@base44/sdk@0.8.40': STUB }, external: [], npmDeps: false });
  await mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.mjs`);
  await writeFile(file, code);
  return (await import(/* @vite-ignore */ `${pathToFileURL(file).href}?t=${Date.now()}`)).default as (req: Request) => Promise<Response>;
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('production bundles', () => {
  it.each(FUNCTION_NAMES)('%s bundles to one self-contained module with a default export', async (name) => {
    const code = await bundleFunction(name);
    // Only the platform-provided SDK may remain as an import; everything else must be inlined.
    expect(findUnresolvedImports(code)).toEqual([]);
    expect(code).toContain("from 'npm:@base44/sdk@0.8.40'".replace(/'/g, '"'));
    expect(code).toMatch(/export\s*\{[^}]*\bas default\b/);
    expect(code).not.toMatch(/from "(zod|node-html-parser|zod-to-json-schema)"/);
    // Third-party libraries are imported by Deno from npm at pinned versions, not inlined.
    // synthesizeBenchmarkReport never scrapes, so it does not need the HTML parser.
    const expected = name === 'synthesizeBenchmarkReport' ? ['zod', 'zod-to-json-schema'] : NPM_DEPS;
    for (const pkg of expected) expect(code, `${name} imports ${pkg}`).toContain(`"${npmSpecifier(pkg)}"`);
    if (name === 'synthesizeBenchmarkReport') expect(code).not.toContain('node-html-parser');
    expect(code.length, `${name} stays small enough to review`).toBeLessThan(120_000);
  });

  it('the bundled auditCompanyWebsite runs end to end (scrape -> AI -> entity)', async () => {
    const db = new FakeDb();
    installFakeBase44(db);
    installFakeNetwork({
      sites: { 'acmeflow.com': page('Acme Flow', '<p>$29 per month</p>') },
      claude: () => ({ industry: 'SaaS', description: 'Does things.', target_audience: 'Ops', value_propositions: ['Fast'], pricing_tiers: [] }),
    });
    const handler = await loadBundled('auditCompanyWebsite');
    const res = await handler(post({ url: 'acmeflow.com' }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;
    expect(out.profile).toMatchObject({ name: 'Acme Flow', status: 'IDLE', industry: 'SaaS' });
    expect(out.profile.raw_scraped_summary).toMatch(/TITLE: Acme Flow/);
  });

  it('the bundled functions enforce auth and block SSRF targets', async () => {
    installFakeBase44(new FakeDb());
    installFakeNetwork({});
    const handler = await loadBundled('auditCompanyWebsite');
    expect((await handler(post({ url: 'acmeflow.com' }, null))).status).toBe(401);
    expect((await handler(post({ url: 'http://169.254.169.254/' }))).status).toBe(400);
  });

  it('the bundled synthesizeBenchmarkReport converts the Zod schema to a valid tool schema', async () => {
    const db = new FakeDb();
    installFakeBase44(db);
    const net = installFakeNetwork({
      claude: () => ({
        scores: { overall_health: 60, market_positioning: 60, pricing_competitiveness: 60, feature_parity: 60 },
        executive_summary: 'ok',
        swot: { strengths: ['a'], weaknesses: ['b'], opportunities: ['c'], threats: ['d'] },
        feature_matrix: [{ featureName: 'SSO', targetHas: true, competitors: { Rival: true }, gapImpact: 'LOW' }],
        recommendations: [{ priority: 'P0', category: 'x', title: 't', impact: 'i', effort: 'LOW', tacticalSteps: ['s'] }],
      }),
    });
    const profile = db.seed('CompanyProfile', { name: 'Acme', url: 'https://acme.com/', status: 'IDLE' }, 'user_1');
    db.seed('Competitor', { company_profile_id: profile.id, name: 'Rival', url: 'https://rival.com/', source: 'AI_DISCOVERED', included_in_report: true }, 'user_1');

    const handler = await loadBundled('synthesizeBenchmarkReport');
    const res = await handler(post({ companyProfileId: profile.id }));
    expect(res.status).toBe(200);

    const schema = net.claudeCalls[0]!.body.tools[0].input_schema;
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties).sort()).toEqual(['executive_summary', 'feature_matrix', 'recommendations', 'scores', 'swot']);
    expect(schema.properties.recommendations.items.properties.priority.enum).toEqual(['P0', 'P1', 'P2']);
    expect(schema.properties.scores.properties.overall_health).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
  });
});
