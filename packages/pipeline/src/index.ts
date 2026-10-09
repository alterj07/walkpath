export const PIPELINE_VERSION = '0.1.0';

export * from './schema/index.ts';
export * from './ids.ts';
export * from './links.ts';
export { API_ADAPTERS, adapterFor, limitsOf, parseOrThrow } from './adapters/index.ts';
export type { AnyAdapter, AdapterPolicy, SourceAdapter } from './adapters/index.ts';
export { greenhouseAdapter } from './adapters/greenhouse.ts';
export { leverAdapter } from './adapters/lever.ts';
export { ashbyAdapter } from './adapters/ashby.ts';
export { workableAdapter } from './adapters/workable.ts';
export { smartrecruitersAdapter, createSmartRecruitersAdapter } from './adapters/smartrecruiters.ts';
export {
  HttpClient,
  HttpError,
  BOT_USER_AGENT,
  BOT_TOKEN,
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  MAX_ATTEMPTS,
  parseRetryAfter,
} from './http/client.ts';
export type { FetchLike, HttpClientOptions, HttpRequest, HttpResponse, HttpErrorCode } from './http/client.ts';
export { HostLimiter } from './http/limiter.ts';
export type { HostLimits } from './http/limiter.ts';
export { parseRobots, isPathAllowed } from './http/robots.ts';
export type { RobotsRules } from './http/robots.ts';
export * from './state/db.ts';
export * from './crawl/diff.ts';
export * from './crawl/run.ts';
