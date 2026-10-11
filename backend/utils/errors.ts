// Error types shared by the scraper and the function plumbing. Kept in their own module so code that only
// needs to recognize a ScrapeError (common.ts) does not pull the HTML parser into functions that never scrape.

export type ScrapeErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_HOST'
  | 'DNS_FAILURE'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'BLOCKED_BY_SITE'
  | 'NOT_HTML'
  | 'TOO_MANY_REDIRECTS'
  | 'EMPTY_CONTENT';

export class ScrapeError extends Error {
  constructor(
    message: string,
    readonly code: ScrapeErrorCode,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ScrapeError';
  }
}
