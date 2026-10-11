// Pure post-processing of Claude's benchmark output. Keeps what we store consistent even when the
// model drifts: competitor keys are forced to the exact names we sent, rows are deduped and capped,
// scores are clamped, and the feature-parity score is computed from the matrix itself.

import type { BenchmarkReportOutput } from '../../lib/ai/schemas';
import type { FeatureMatrixRow, GapImpact, Recommendation, SwotMatrix } from '../../lib/types';

const IMPACT_WEIGHT: Record<GapImpact, number> = { HIGH: 3, MED: 2, LOW: 1 };
const PRIORITY_ORDER: Record<Recommendation['priority'], number> = { P0: 0, P1: 1, P2: 2 };

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

/** Gives every competitor a unique key for the feature matrix ("Notion", "Notion (notion.so)" on collision). */
export function uniqueCompetitorKeys(competitors: Array<{ name: string; url: string }>, hostOf: (url: string) => string): string[] {
  const counts = new Map<string, number>();
  for (const c of competitors) counts.set(squash(c.name), (counts.get(squash(c.name)) ?? 0) + 1);
  const used = new Set<string>();
  return competitors.map((c) => {
    let key = (counts.get(squash(c.name)) ?? 0) > 1 ? `${c.name} (${hostOf(c.url)})` : c.name;
    let n = 2;
    while (used.has(squash(key))) key = `${c.name} #${n++}`;
    used.add(squash(key));
    return key;
  });
}

/**
 * Forces `competitors` on every row to contain exactly `names` (booleans), matching the model's keys
 * case/punctuation-insensitively. Drops duplicate and empty feature rows and caps the table at 25 rows.
 */
export function normalizeFeatureMatrix(rows: BenchmarkReportOutput['feature_matrix'], names: string[]): FeatureMatrixRow[] {
  const seen = new Set<string>();
  const out: FeatureMatrixRow[] = [];
  for (const row of rows) {
    const featureName = row.featureName.trim().slice(0, 120);
    const id = squash(featureName);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const lookup = new Map(Object.entries(row.competitors).map(([k, v]) => [squash(k), v] as const));
    const competitors: Record<string, boolean> = {};
    for (const name of names) competitors[name] = lookup.get(squash(name)) === true;

    out.push({ featureName, targetHas: row.targetHas, competitors, gapImpact: row.gapImpact });
    if (out.length >= 25) break;
  }
  return out;
}

/**
 * Weighted share of market-relevant features the target covers.
 * A feature is market-relevant when at least one competitor has it; it is weighted by how many
 * competitors offer it and by its gap impact. Returns null when no feature qualifies.
 */
export function computeFeatureParity(rows: FeatureMatrixRow[]): number | null {
  let covered = 0;
  let total = 0;
  for (const row of rows) {
    const flags = Object.values(row.competitors);
    if (flags.length === 0) continue;
    const share = flags.filter(Boolean).length / flags.length;
    if (share === 0) continue;
    const weight = IMPACT_WEIGHT[row.gapImpact] * share;
    total += weight;
    if (row.targetHas) covered += weight;
  }
  return total === 0 ? null : clampScore((covered / total) * 100);
}

export interface NormalizedReport {
  overall_health_score: number;
  market_positioning_score: number;
  pricing_competitiveness_score: number;
  feature_parity_score: number;
  swot: SwotMatrix;
  feature_matrix: FeatureMatrixRow[];
  actionable_recommendations: Recommendation[];
  executive_summary: string;
}

const clean = (items: string[], max = 8) => items.map((s) => s.trim()).filter(Boolean).slice(0, max);

export function normalizeReport(output: BenchmarkReportOutput, competitorKeys: string[]): NormalizedReport {
  const feature_matrix = normalizeFeatureMatrix(output.feature_matrix, competitorKeys);
  const parity = computeFeatureParity(feature_matrix);

  const actionable_recommendations = output.recommendations
    .map((r, index) => ({ index, r }))
    .sort((a, b) => PRIORITY_ORDER[a.r.priority] - PRIORITY_ORDER[b.r.priority] || a.index - b.index)
    .map(({ r }) => ({
      priority: r.priority,
      title: r.title.trim(),
      category: r.category.trim(),
      impact: r.impact.trim(),
      effort: r.effort,
      tacticalSteps: clean(r.tacticalSteps, 8),
    }));

  return {
    overall_health_score: clampScore(output.scores.overall_health),
    market_positioning_score: clampScore(output.scores.market_positioning),
    pricing_competitiveness_score: clampScore(output.scores.pricing_competitiveness),
    feature_parity_score: parity ?? clampScore(output.scores.feature_parity),
    swot: {
      strengths: clean(output.swot.strengths),
      weaknesses: clean(output.swot.weaknesses),
      opportunities: clean(output.swot.opportunities),
      threats: clean(output.swot.threats),
    },
    feature_matrix,
    actionable_recommendations,
    executive_summary: output.executive_summary.trim(),
  };
}
