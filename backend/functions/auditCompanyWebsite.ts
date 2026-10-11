// auditCompanyWebsite: scrape a company's public site and create / refresh its CompanyProfile.
//
// Input : { url: string, name?: string, industry?: string }
// Output: { profile: CompanyProfile, scrape: { finalUrl, pagesFetched, warnings } }
// Status: CompanyProfile.status is SCRAPING while running and IDLE when the profile is ready.

import { AuditInputSchema, CompanyExtractionSchema, type CompanyExtraction } from '../../lib/ai/schemas';
import { PROFILE_EXTRACTION_SYSTEM_PROMPT, buildProfileExtractionPrompt } from '../../lib/ai/prompts';
import type { CompanyProfile, PricingTier } from '../../lib/types';
import { hostKey, nameFromUrl } from '../../lib/url';
import { ClaudeError, callClaudeJson } from '../utils/claudeClient';
import {
  HttpError,
  assertNotInFlight,
  authenticate,
  errorResponse,
  json,
  parseInput,
  readJsonBody,
  setProfileStatus,
} from '../utils/common';
import { assertPublicHttpUrl, scrapeSite, type ScrapedPage } from '../utils/scraper';

/** "Acme Flow | Workflow automation" -> "Acme Flow". Falls back to the domain name. */
export function deriveCompanyName(page: ScrapedPage, url: string): string {
  const siteName = page.openGraph['og:site_name'];
  if (siteName && siteName.length <= 60) return siteName;
  const first = page.title.split(/\s[|–—-]\s|:\s/)[0]?.trim();
  if (first && first.length >= 2 && first.length <= 40) return first;
  return nameFromUrl(url);
}

/** Used when the AI step is unavailable: a profile built only from what the page itself says. */
function heuristicExtraction(page: ScrapedPage, industry?: string): CompanyExtraction {
  return {
    industry: industry ?? '',
    description: page.metaDescription || page.openGraph['og:description'] || '',
    target_audience: '',
    value_propositions: [...page.headings.h1, ...page.headings.h2].slice(0, 5),
    pricing_tiers: [],
  };
}

function toPricingTiers(extraction: CompanyExtraction): PricingTier[] {
  return extraction.pricing_tiers
    .filter((t) => t.tierName)
    .map((t) => ({
      tierName: t.tierName,
      ...(t.price ? { price: t.price } : {}),
      ...(t.billingPeriod ? { billingPeriod: t.billingPeriod } : {}),
      ...(t.featuresSummary ? { featuresSummary: t.featuresSummary } : {}),
    }));
}

export default async function auditCompanyWebsite(req: Request): Promise<Response> {
  let profileId: string | undefined;
  let ctx: Awaited<ReturnType<typeof authenticate>> | undefined;
  try {
    ctx = await authenticate(req);
    const input = parseInput(AuditInputSchema, await readJsonBody(req));
    const { base44, user } = ctx;

    // Reject private / unresolvable targets BEFORE writing anything, so typos leave no junk records.
    await assertPublicHttpUrl(input.url);

    // Re-auditing the same domain refreshes the existing profile instead of creating a duplicate.
    const mine = (await base44.entities.CompanyProfile.filter({ created_by_id: user.id }, '-created_date', 200)) as CompanyProfile[];
    const existing = mine.find((p) => hostKey(p.url) === hostKey(input.url));
    if (existing) assertNotInFlight(existing);

    const profile = existing
      ? ((await base44.entities.CompanyProfile.update(existing.id, {
          url: input.url,
          status: 'SCRAPING',
          last_error: '',
          ...(input.name ? { name: input.name } : {}),
          ...(input.industry ? { industry: input.industry } : {}),
        })) as CompanyProfile)
      : ((await base44.entities.CompanyProfile.create({
          name: input.name ?? nameFromUrl(input.url),
          url: input.url,
          ...(input.industry ? { industry: input.industry } : {}),
          status: 'SCRAPING',
        })) as CompanyProfile);
    profileId = profile.id;

    const scrape = await scrapeSite(input.url);
    const warnings = [...scrape.warnings];

    let extraction: CompanyExtraction;
    try {
      extraction = await callClaudeJson({
        system: PROFILE_EXTRACTION_SYSTEM_PROMPT,
        user: buildProfileExtractionPrompt({
          url: scrape.page.finalUrl,
          name: input.name,
          industry: input.industry,
          scrapedSummary: scrape.summary,
        }),
        schema: CompanyExtractionSchema,
        toolName: 'submit_company_profile',
        toolDescription: 'Submit the structured company profile extracted from the website evidence.',
        maxTokens: 2_000,
      });
    } catch (err) {
      // A missing API key is a setup problem every later step would hit too: fail now with a clear message.
      if (err instanceof ClaudeError && err.code === 'NO_API_KEY') throw err;
      console.error('[auditCompanyWebsite] AI extraction failed, using page metadata only:', err instanceof Error ? err.message : String(err));
      warnings.push('AI_EXTRACTION_FAILED');
      extraction = heuristicExtraction(scrape.page, input.industry);
    }

    const updated = (await base44.entities.CompanyProfile.update(profile.id, {
      name: input.name ?? (existing?.name || deriveCompanyName(scrape.page, scrape.page.finalUrl)),
      industry: input.industry || extraction.industry || existing?.industry || '',
      description: extraction.description,
      target_audience: extraction.target_audience,
      value_propositions: extraction.value_propositions,
      pricing_tiers: toPricingTiers(extraction),
      raw_scraped_summary: scrape.summary,
      status: 'IDLE',
      last_error: '',
    })) as CompanyProfile;

    return json({
      profile: updated,
      scrape: { finalUrl: scrape.page.finalUrl, pagesFetched: scrape.pagesFetched, warnings },
    });
  } catch (err) {
    // Leave the record in a recoverable ERROR state (unless another run owns it).
    if (profileId && ctx && !(err instanceof HttpError && err.code === 'ALREADY_RUNNING')) {
      await setProfileStatus(ctx, profileId, 'ERROR', err instanceof Error ? err.message : 'Audit failed.');
    }
    return errorResponse(err, { profileId });
  }
}
