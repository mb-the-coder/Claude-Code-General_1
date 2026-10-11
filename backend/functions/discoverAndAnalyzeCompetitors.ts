// discoverAndAnalyzeCompetitors: find (AI) and/or accept (manual) competitors, profile each one
// from its live website, and upsert them into the Competitor entity.
//
// Input : { companyProfileId, manualCompetitorUrls?, manualCompetitors?, skipDiscovery? }
// Output: { competitors, failures, counts }
//
// Honesty rules: AI-suggested domains are checked against the live web. If an AI competitor's site
// cannot be read it is still kept (the model chose it deliberately) but flagged and analyzed from
// general knowledge only. A MANUAL competitor whose site cannot be read is reported as a failure
// instead of being filled in with guesses.

import {
  CompetitorAnalysisSchema,
  DiscoverInputSchema,
  DiscoveredCompetitorsSchema,
  type CompetitorAnalysis,
} from '../../lib/ai/schemas';
import {
  COMPETITOR_ANALYSIS_SYSTEM_PROMPT,
  COMPETITOR_DISCOVERY_SYSTEM_PROMPT,
  buildCompetitorAnalysisPrompt,
  buildDiscoveryPrompt,
} from '../../lib/ai/prompts';
import type { Competitor, CompetitorFailure, CompetitorSource, CompanyProfile, ThreatLevel } from '../../lib/types';
import { hostKey, nameFromUrl, normalizeUrl } from '../../lib/url';
import { ClaudeError, callClaudeJson } from '../utils/claudeClient';
import {
  HttpError,
  assertNotInFlight,
  authenticate,
  errorResponse,
  json,
  loadOwnedProfile,
  mapWithConcurrency,
  parseInput,
  readJsonBody,
  setProfileStatus,
} from '../utils/common';
import { ScrapeError, scrapeSite } from '../utils/scraper';

const MAX_TOTAL_COMPETITORS = 8;
const ANALYSIS_CONCURRENCY = 3;

interface WorkItem {
  source: CompetitorSource;
  url: string;
  nameHint?: string;
  rationale?: string;
  discoveredThreat?: ThreatLevel;
}

interface Analyzed {
  item: WorkItem;
  analysis: CompetitorAnalysis;
  scrapeNote?: string;
}

const tryNormalize = (raw: string): string | null => {
  try {
    return normalizeUrl(raw);
  } catch {
    return null;
  }
};

export default async function discoverAndAnalyzeCompetitors(req: Request): Promise<Response> {
  let profileId: string | undefined;
  let previous: CompanyProfile | undefined;
  let started = false; // true once we have marked the profile SCRAPING and therefore own its status
  let manualOnly = false;
  let ctx: Awaited<ReturnType<typeof authenticate>> | undefined;
  try {
    ctx = await authenticate(req);
    const input = parseInput(DiscoverInputSchema, await readJsonBody(req));
    const { base44 } = ctx;
    manualOnly = input.skipDiscovery;

    const profile = await loadOwnedProfile(ctx, input.companyProfileId);
    profileId = profile.id;
    previous = profile;
    assertNotInFlight(profile);

    const targetHost = hostKey(profile.url);

    // Manual competitors: merge both input shapes, drop the target itself and duplicates.
    const manualSeen = new Set<string>([targetHost]);
    const manual: WorkItem[] = [];
    const rawManual = [...(input.manualCompetitors ?? []), ...(input.manualCompetitorUrls ?? []).map((url) => ({ url, name: undefined }))];
    for (const m of rawManual) {
      const key = hostKey(m.url);
      if (manualSeen.has(key)) continue;
      manualSeen.add(key);
      manual.push({ source: 'MANUAL_INPUT', url: m.url, nameHint: m.name });
    }
    if (input.skipDiscovery && manual.length === 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Enter a competitor website that is different from your own.');
    }

    await setProfileStatus(ctx, profile.id, 'SCRAPING');
    started = true;

    // ---- Stage 1: AI discovery -------------------------------------------------------------
    const discovered: WorkItem[] = [];
    if (!input.skipDiscovery) {
      const room = Math.max(0, MAX_TOTAL_COMPETITORS - manual.length);
      const wanted = Math.min(5, room);
      if (wanted > 0) {
        const result = await callClaudeJson({
          system: COMPETITOR_DISCOVERY_SYSTEM_PROMPT,
          user: buildDiscoveryPrompt({
            profile: {
              name: profile.name,
              url: profile.url,
              industry: profile.industry,
              description: profile.description,
              target_audience: profile.target_audience,
              value_propositions: profile.value_propositions,
              pricing_summary: (profile.pricing_tiers ?? []).map((t) => `${t.tierName} ${t.price ?? ''}`.trim()).join(', '),
              raw_scraped_summary: profile.raw_scraped_summary,
            },
            excludedHosts: [...manualSeen],
            desiredCount: wanted,
          }),
          schema: DiscoveredCompetitorsSchema,
          toolName: 'submit_competitors',
          toolDescription: 'Submit the list of real competitors of the target company.',
          maxTokens: 2_500,
        });

        const seen = new Set(manualSeen);
        for (const c of result.competitors) {
          const url = tryNormalize(c.url);
          if (!url) continue;
          const key = hostKey(url);
          if (seen.has(key)) continue; // the model must not return the target or a duplicate
          seen.add(key);
          discovered.push({
            source: 'AI_DISCOVERED',
            url,
            nameHint: c.name,
            rationale: c.positioning_rationale,
            discoveredThreat: c.threat_level,
          });
          if (discovered.length >= wanted) break;
        }
      }
      if (discovered.length === 0 && manual.length === 0) {
        throw new HttpError(502, 'NO_COMPETITORS_FOUND', 'No usable competitors were found for this company. Try adding one manually.', true);
      }
    }

    // ---- Stage 2: scrape + analyze each competitor ------------------------------------------
    const work: WorkItem[] = [...manual, ...discovered];
    const failures: CompetitorFailure[] = [];

    const analyzed = (
      await mapWithConcurrency(work, ANALYSIS_CONCURRENCY, async (item): Promise<Analyzed | null> => {
        const label = item.nameHint ?? nameFromUrl(item.url);
        let summary: string | null = null;
        let scrapeNote: string | undefined;
        try {
          summary = (await scrapeSite(item.url, { maxSummaryChars: 10_000, timeoutMs: 9_000 })).summary;
        } catch (err) {
          if (!(err instanceof ScrapeError)) throw err;
          if (item.source === 'MANUAL_INPUT') {
            failures.push({ name: label, url: item.url, reason: err.message });
            return null;
          }
          scrapeNote = 'Site could not be read, so this profile relies on general knowledge.';
        }

        try {
          const analysis = await callClaudeJson({
            system: COMPETITOR_ANALYSIS_SYSTEM_PROMPT,
            user: buildCompetitorAnalysisPrompt({
              target: { name: profile.name, industry: profile.industry, description: profile.description },
              competitor: { name: item.nameHint, url: item.url, rationale: item.rationale },
              scrapedSummary: summary,
            }),
            schema: CompetitorAnalysisSchema,
            toolName: 'submit_competitor_profile',
            toolDescription: 'Submit the structured profile of this competitor.',
            maxTokens: 2_500,
          });
          return { item, analysis, scrapeNote };
        } catch (err) {
          if (err instanceof ClaudeError && err.code === 'NO_API_KEY') throw err;
          failures.push({ name: label, url: item.url, reason: err instanceof Error ? err.message : 'Analysis failed.' });
          return null;
        }
      })
    ).filter((a): a is Analyzed => a !== null);

    if (analyzed.length === 0) {
      const detail = failures[0]?.reason ? ` (${failures[0].reason})` : '';
      throw new HttpError(502, 'NO_COMPETITORS_ANALYZED', `None of the competitors could be analyzed${detail}`, true);
    }

    // ---- Stage 3: upsert ---------------------------------------------------------------------
    const existing = (await base44.entities.Competitor.filter({ company_profile_id: profile.id }, '-created_date', 200)) as Competitor[];
    const byHost = new Map(existing.map((c) => [hostKey(c.url), c]));
    let created = 0;
    let updated = 0;

    const saved = await mapWithConcurrency(analyzed, ANALYSIS_CONCURRENCY, async ({ item, analysis, scrapeNote }) => {
      const prior = byHost.get(hostKey(item.url));
      const rationale = [item.rationale ?? (item.source === 'MANUAL_INPUT' ? 'Added manually.' : ''), scrapeNote].filter(Boolean).join(' ');
      const fields = {
        name: item.nameHint?.trim() || analysis.name || prior?.name || nameFromUrl(item.url),
        url: item.url,
        discovery_rationale: rationale,
        threat_level: item.source === 'AI_DISCOVERED' ? (item.discoveredThreat ?? analysis.threat_level) : analysis.threat_level,
        strengths: analysis.strengths,
        weaknesses: analysis.weaknesses,
        features: analysis.features,
        pricing_summary: analysis.pricing_summary,
      };
      if (prior) {
        updated++;
        // A competitor the user added by hand stays manual even if the AI later suggests it too.
        const source: CompetitorSource = prior.source === 'MANUAL_INPUT' ? 'MANUAL_INPUT' : item.source;
        return (await base44.entities.Competitor.update(prior.id, { ...fields, source })) as Competitor;
      }
      created++;
      return (await base44.entities.Competitor.create({
        ...fields,
        company_profile_id: profile.id,
        source: item.source,
        included_in_report: true,
      })) as Competitor;
    });

    await setProfileStatus(ctx, profile.id, 'IDLE');

    return json({
      competitors: saved,
      failures,
      counts: {
        aiDiscovered: analyzed.filter((a) => a.item.source === 'AI_DISCOVERED').length,
        manual: analyzed.filter((a) => a.item.source === 'MANUAL_INPUT').length,
        created,
        updated,
      },
    });
  } catch (err) {
    if (started && profileId && ctx) {
      const message = err instanceof Error ? err.message : 'Competitor analysis failed.';
      if (manualOnly) {
        // Adding one competitor by hand must not break an otherwise healthy company profile.
        await setProfileStatus(ctx, profileId, previous?.status === 'ERROR' ? 'ERROR' : previous?.status === 'ANALYZED' ? 'ANALYZED' : 'IDLE', previous?.last_error ?? '');
      } else {
        await setProfileStatus(ctx, profileId, 'ERROR', message);
      }
    }
    return errorResponse(err, { profileId });
  }
}
