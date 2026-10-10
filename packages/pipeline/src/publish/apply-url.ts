import { isAllowedApplyHost, validateApplyUrl } from '../links.ts';
import type { Ats } from '../schema/common.ts';
import { GREENHOUSE_POLICY } from '../adapters/greenhouse.ts';
import { LEVER_POLICY } from '../adapters/lever.ts';
import { ASHBY_POLICY } from '../adapters/ashby.ts';
import { WORKABLE_POLICY } from '../adapters/workable.ts';
import { SMARTRECRUITERS_POLICY } from '../adapters/smartrecruiters.ts';

/**
 * Apply-link resolution (plan section 11.3). The Apply button is the whole attack
 * surface, so a URL is published only when it is https, not a shortener or IP
 * literal, carries no credentials, and sits on a host the ATS adapter vouches for
 * or on the company's own registered domain. Anything else is downgraded to the
 * employer's careers page and flagged for review.
 */

/** Sentinel in an ATS host list meaning "any https host" (human-curated sources only). */
export const ANY_HOST = '*';

/** Longest apply URL we publish; anything longer is almost certainly junk or an attack. */
export const APPLY_URL_MAX_LENGTH = 2048;

/**
 * Legitimate hosts per ATS; unknown sources get only the company domain. Each entry
 * comes from its adapter's policy so there is one source of truth per ATS.
 * TODO(workday): replace the hard-coded wildcards with WORKDAY_POLICY.allowedHosts once
 * the Workday adapter lands; same for recruitee/breezy if those adapters are written.
 */
export const ATS_APPLY_HOSTS: Readonly<Partial<Record<Ats, readonly string[]>>> = {
  greenhouse: GREENHOUSE_POLICY.allowedHosts,
  lever: LEVER_POLICY.allowedHosts,
  ashby: ASHBY_POLICY.allowedHosts,
  workable: WORKABLE_POLICY.allowedHosts,
  smartrecruiters: SMARTRECRUITERS_POLICY.allowedHosts,
  workday: ['*.myworkdayjobs.com', '*.myworkdaysite.com'],
  recruitee: ['*.recruitee.com'],
  breezy: ['*.breezy.hr'],
  // Curated list rows point at whatever board the employer uses; the list maintainers reviewed them.
  simplify: [ANY_HOST],
};

export interface ResolveApplyUrlInput {
  applyUrl: string;
  hostedUrl?: string | null | undefined;
  ats: Ats;
  companyDomain?: string | null | undefined;
  careersUrl?: string | null | undefined;
}

export interface ResolvedApplyUrl {
  /** Always https, or '' when nothing usable exists. */
  apply_url: string;
  /** True when the button must say "Apply on the company's careers page". */
  apply_url_downgraded: boolean;
  /** Why the original apply URL was not used; absent when it was. */
  flagged_reason?: string;
}

function acceptable(raw: string | null | undefined, atsHosts: readonly string[], companyDomain: string | null | undefined): { url: string } | { reason: string } {
  if (!raw || raw.trim() === '') return { reason: 'missing' };
  if (raw.length > APPLY_URL_MAX_LENGTH) return { reason: 'too_long' };
  const anyHost = atsHosts.includes(ANY_HOST);
  const v = validateApplyUrl(raw, { atsHosts: anyHost ? [] : atsHosts });
  if (!v.ok) return { reason: v.reason };
  // An http URL is published as https; the weekly link check catches hosts that do not answer on 443.
  if (!anyHost && !isAllowedApplyHost(v.url, { atsHosts, companyDomain })) return { reason: 'off_host' };
  return { url: v.url };
}

/** Pick the safest publishable link: apply URL, else hosted URL, else the registry careers URL. */
export function resolveApplyUrl(input: ResolveApplyUrlInput): ResolvedApplyUrl {
  const atsHosts = ATS_APPLY_HOSTS[input.ats] ?? [];
  const domain = input.companyDomain?.trim() || null;

  const primary = acceptable(input.applyUrl, atsHosts, domain);
  if ('url' in primary) return { apply_url: primary.url, apply_url_downgraded: false };

  const hosted = acceptable(input.hostedUrl, atsHosts, domain);
  if ('url' in hosted) {
    return { apply_url: hosted.url, apply_url_downgraded: false, flagged_reason: `apply_url:${primary.reason}` };
  }

  // The careers URL comes from the registry (reviewed by a maintainer); it only needs to be a sane https URL.
  const careers =
    input.careersUrl && input.careersUrl.length <= APPLY_URL_MAX_LENGTH ? validateApplyUrl(input.careersUrl) : null;
  if (careers?.ok) {
    return { apply_url: careers.url, apply_url_downgraded: true, flagged_reason: `apply_url:${primary.reason}` };
  }
  return { apply_url: '', apply_url_downgraded: true, flagged_reason: `apply_url:${primary.reason};careers_url:unusable` };
}
