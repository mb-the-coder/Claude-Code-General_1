// synthesizeBenchmarkReport: turn a CompanyProfile + its competitors into the executive benchmark.
//
// Input : { companyProfileId }
// Output: { report: BenchmarkReport, competitorsUsed: string[] }
//
// One BenchmarkReport per company, updated in place on every run. Competitors with
// included_in_report === false are left out, so users can curate the comparison set.

import { BenchmarkReportSchema, SynthesizeInputSchema } from '../../lib/ai/schemas';
import { BENCHMARK_SYNTHESIS_SYSTEM_PROMPT, buildBenchmarkPrompt } from '../../lib/ai/prompts';
import type { BenchmarkReport, Competitor, ThreatLevel } from '../../lib/types';
import { hostKey } from '../../lib/url';
import { callClaudeJson } from '../utils/claudeClient';
import {
  HttpError,
  assertNotInFlight,
  authenticate,
  errorResponse,
  json,
  loadOwnedProfile,
  parseInput,
  readJsonBody,
  setProfileStatus,
} from '../utils/common';
import { normalizeReport, uniqueCompetitorKeys } from '../utils/report';

const MAX_COMPETITORS_IN_REPORT = 8;
const THREAT_RANK: Record<ThreatLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export default async function synthesizeBenchmarkReport(req: Request): Promise<Response> {
  let profileId: string | undefined;
  let started = false;
  let ctx: Awaited<ReturnType<typeof authenticate>> | undefined;
  try {
    ctx = await authenticate(req);
    const input = parseInput(SynthesizeInputSchema, await readJsonBody(req));
    const { base44 } = ctx;

    const profile = await loadOwnedProfile(ctx, input.companyProfileId);
    profileId = profile.id;
    assertNotInFlight(profile);

    const all = (await base44.entities.Competitor.filter({ company_profile_id: profile.id }, '-created_date', 200)) as Competitor[];
    const included = all
      .filter((c) => c.included_in_report !== false)
      .sort((a, b) => THREAT_RANK[a.threat_level ?? 'LOW'] - THREAT_RANK[b.threat_level ?? 'LOW'])
      .slice(0, MAX_COMPETITORS_IN_REPORT);
    if (included.length === 0) {
      throw new HttpError(400, 'NO_COMPETITORS', 'Add or enable at least one competitor before generating a report.');
    }

    await setProfileStatus(ctx, profile.id, 'SCRAPING');
    started = true;

    // Matrix keys must be unique and stable; the model is told to use exactly these names.
    const keys = uniqueCompetitorKeys(included, hostKey);

    const output = await callClaudeJson({
      system: BENCHMARK_SYNTHESIS_SYSTEM_PROMPT,
      user: buildBenchmarkPrompt({
        profile: {
          name: profile.name,
          url: profile.url,
          industry: profile.industry,
          description: profile.description,
          target_audience: profile.target_audience,
          value_propositions: profile.value_propositions,
          pricing_tiers: profile.pricing_tiers,
          raw_scraped_summary: profile.raw_scraped_summary,
        },
        competitors: included.map((c, i) => ({
          name: keys[i] as string,
          url: c.url,
          source: c.source,
          threat_level: c.threat_level,
          discovery_rationale: c.discovery_rationale,
          strengths: c.strengths,
          weaknesses: c.weaknesses,
          features: c.features,
          pricing_summary: c.pricing_summary,
        })),
      }),
      schema: BenchmarkReportSchema,
      toolName: 'submit_benchmark_report',
      toolDescription: 'Submit the complete competitive benchmark report.',
      maxTokens: 8_000,
      timeoutMs: 120_000,
    });

    const normalized = normalizeReport(output, keys);
    const fields = {
      company_profile_id: profile.id,
      overall_health_score: normalized.overall_health_score,
      market_positioning_score: normalized.market_positioning_score,
      pricing_competitiveness_score: normalized.pricing_competitiveness_score,
      feature_parity_score: normalized.feature_parity_score,
      swot: normalized.swot,
      feature_matrix: normalized.feature_matrix,
      actionable_recommendations: normalized.actionable_recommendations,
      executive_summary: normalized.executive_summary,
      last_analyzed_at: new Date().toISOString(),
    };

    const [current] = (await base44.entities.BenchmarkReport.filter({ company_profile_id: profile.id }, '-last_analyzed_at', 1)) as BenchmarkReport[];
    const report = (current
      ? await base44.entities.BenchmarkReport.update(current.id, fields)
      : await base44.entities.BenchmarkReport.create(fields)) as BenchmarkReport;

    await setProfileStatus(ctx, profile.id, 'ANALYZED');

    return json({ report, competitorsUsed: keys });
  } catch (err) {
    if (started && profileId && ctx) {
      await setProfileStatus(ctx, profileId, 'ERROR', err instanceof Error ? err.message : 'Report generation failed.');
    }
    return errorResponse(err, { profileId });
  }
}
