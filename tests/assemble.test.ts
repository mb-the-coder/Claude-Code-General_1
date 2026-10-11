import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTITY_NAMES, FRONTEND_FILES, ROOT, frontendImportGraph } from '../scripts/lib.mjs';

describe('Base44 assemble manifest', () => {
  it('ships every local file the page imports, and nothing from the backend', async () => {
    const graph = await frontendImportGraph();
    expect(graph.length).toBeGreaterThan(10);
    expect(graph.filter((f) => !FRONTEND_FILES.includes(f))).toEqual([]);
    expect(graph.some((f) => f.startsWith('backend/') || f.startsWith('lib/ai/'))).toBe(false);
  });

  it('has no stale entries: every shipped frontend file exists and is actually used', async () => {
    const graph = new Set(await frontendImportGraph());
    for (const file of FRONTEND_FILES) {
      expect(existsSync(path.join(ROOT, file)), `${file} exists`).toBe(true);
      expect(graph.has(file), `${file} is imported by the page`).toBe(true);
    }
  });

  it('never bundles zod or other backend-only dependencies into the browser graph', async () => {
    const graph = await frontendImportGraph();
    const sources = graph.map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    expect(sources).not.toMatch(/from ['"](zod|node-html-parser|zod-to-json-schema)['"]/);
  });

  it('has an entity definition file for every entity', () => {
    for (const name of ENTITY_NAMES) expect(existsSync(path.join(ROOT, 'entities', `${name}.jsonc`)), name).toBe(true);
  });
});

describe('entity schemas', () => {
  const read = (name: string) => {
    // JSONC: strip // line comments (none of our strings contain "//" outside comments except URLs, which we don't use).
    const text = readFileSync(path.join(ROOT, 'entities', `${name}.jsonc`), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(text) as {
      name: string;
      properties: Record<string, { type: string; enum?: string[]; minimum?: number; maximum?: number }>;
      required: string[];
      rls: Record<string, Record<string, string>>;
    };
  };

  it.each(ENTITY_NAMES)('%s is owner-only for every operation', (name) => {
    const schema = read(name);
    expect(schema.name).toBe(name);
    for (const op of ['read', 'create', 'update', 'delete']) {
      expect(schema.rls[op], `${name}.rls.${op}`).toEqual({ created_by_id: '{{user.id}}' });
    }
  });

  it('matches the specified fields, enums and required lists', () => {
    const company = read('CompanyProfile');
    expect(company.required).toEqual(['name', 'url']);
    expect(company.properties.status!.enum).toEqual(['IDLE', 'SCRAPING', 'ANALYZED', 'ERROR']);
    expect(Object.keys(company.properties)).toEqual(
      expect.arrayContaining(['name', 'url', 'industry', 'description', 'target_audience', 'value_propositions', 'pricing_tiers', 'raw_scraped_summary', 'status']),
    );

    const competitor = read('Competitor');
    expect(competitor.required).toEqual(['company_profile_id', 'name', 'url']);
    expect(competitor.properties.source!.enum).toEqual(['AI_DISCOVERED', 'MANUAL_INPUT']);
    expect(competitor.properties.threat_level!.enum).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

    const report = read('BenchmarkReport');
    for (const score of ['overall_health_score', 'market_positioning_score', 'pricing_competitiveness_score', 'feature_parity_score']) {
      expect(report.properties[score], score).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
    }
    expect(Object.keys(report.properties)).toEqual(
      expect.arrayContaining(['swot', 'feature_matrix', 'actionable_recommendations', 'executive_summary', 'last_analyzed_at']),
    );
  });
});
