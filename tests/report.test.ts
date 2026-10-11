import { describe, expect, it } from 'vitest';
import type { BenchmarkReportOutput } from '../lib/ai/schemas';
import { computeFeatureParity, normalizeFeatureMatrix, normalizeReport, uniqueCompetitorKeys } from '../backend/utils/report';

type Row = BenchmarkReportOutput['feature_matrix'][number];
const row = (featureName: string, targetHas: boolean, competitors: Record<string, boolean>, gapImpact: Row['gapImpact'] = 'MED'): Row => ({
  featureName,
  targetHas,
  competitors,
  gapImpact,
});

describe('normalizeFeatureMatrix', () => {
  it('forces competitor keys to the exact names, tolerating case/punctuation drift', () => {
    const out = normalizeFeatureMatrix([row('SSO', false, { 'rival one': true, 'Rival-Two': true, Hallucinated: true })], ['Rival One', 'Rival Two', 'Rival Three']);
    expect(out[0]!.competitors).toEqual({ 'Rival One': true, 'Rival Two': true, 'Rival Three': false });
  });

  it('dedupes feature names, drops blanks and caps at 25 rows', () => {
    const rows = [row('SSO', true, {}), row(' sso ', false, {}), row('  ', true, {}), ...Array.from({ length: 40 }, (_, i) => row(`Feature ${i}`, true, {}))];
    const out = normalizeFeatureMatrix(rows, ['A']);
    expect(out.filter((r) => r.featureName.toLowerCase().trim() === 'sso')).toHaveLength(1);
    expect(out.some((r) => r.featureName.trim() === '')).toBe(false);
    expect(out).toHaveLength(25);
  });
});

describe('computeFeatureParity', () => {
  it('is the weighted share of market-relevant features the target covers', () => {
    const rows = normalizeFeatureMatrix(
      [
        row('SSO', false, { A: true, B: true }, 'HIGH'), // weight 3*1.0, target lacks
        row('API', true, { A: true, B: false }, 'MED'), // weight 2*0.5, target has
        row('Dark mode', true, { A: false, B: false }, 'LOW'), // nobody else has it -> ignored
      ],
      ['A', 'B'],
    );
    // covered = 1, total = 3 + 1 = 4 -> 25
    expect(computeFeatureParity(rows)).toBe(25);
  });

  it('returns null when no competitor offers any listed feature', () => {
    expect(computeFeatureParity(normalizeFeatureMatrix([row('X', true, { A: false })], ['A']))).toBeNull();
    expect(computeFeatureParity([])).toBeNull();
  });

  it('scores 100 when the target has everything competitors have', () => {
    expect(computeFeatureParity(normalizeFeatureMatrix([row('X', true, { A: true }, 'HIGH')], ['A']))).toBe(100);
  });
});

describe('uniqueCompetitorKeys', () => {
  it('disambiguates identical names by host', () => {
    const keys = uniqueCompetitorKeys(
      [
        { name: 'Notion', url: 'https://notion.so' },
        { name: 'notion', url: 'https://notion.com' },
        { name: 'Linear', url: 'https://linear.app' },
      ],
      (u) => new URL(u).hostname,
    );
    expect(keys).toEqual(['Notion (notion.so)', 'notion (notion.com)', 'Linear']);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('normalizeReport', () => {
  const output: BenchmarkReportOutput = {
    scores: { overall_health: 71.6, market_positioning: 64.2, pricing_competitiveness: 55, feature_parity: 99 },
    executive_summary: '  Summary.  ',
    swot: { strengths: [' a ', ''], weaknesses: ['b'], opportunities: ['c'], threats: ['d'] },
    feature_matrix: [row('SSO', false, { A: true }, 'HIGH')],
    recommendations: [
      { priority: 'P2', category: 'Growth', title: 'Third', impact: 'i', effort: 'LOW', tacticalSteps: ['x'] },
      { priority: 'P0', category: 'Product', title: ' First ', impact: 'i', effort: 'MED', tacticalSteps: ['x', ' '] },
      { priority: 'P1', category: 'Pricing', title: 'Second', impact: 'i', effort: 'HIGH', tacticalSteps: ['x'] },
    ],
  };

  it('rounds scores, replaces the model parity with the computed one and orders recommendations', () => {
    const r = normalizeReport(output, ['A']);
    expect(r.overall_health_score).toBe(72);
    expect(r.market_positioning_score).toBe(64);
    expect(r.feature_parity_score).toBe(0); // target lacks the only competitor-offered feature
    expect(r.actionable_recommendations.map((x) => x.title)).toEqual(['First', 'Second', 'Third']);
    expect(r.actionable_recommendations[0]!.tacticalSteps).toEqual(['x']);
    expect(r.swot.strengths).toEqual(['a']);
    expect(r.executive_summary).toBe('Summary.');
  });

  it('falls back to the model parity when the matrix cannot determine one', () => {
    const r = normalizeReport({ ...output, feature_matrix: [row('Only us', true, { A: false })] }, ['A']);
    expect(r.feature_parity_score).toBe(99);
  });
});
