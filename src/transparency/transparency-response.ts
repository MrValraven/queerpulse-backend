import type {
  LegalRequestOutcome,
  LegalRequestType,
} from '../legal-requests/legal-request-vocabulary';
import { ReasonCode } from '../reports/reason-catalogue';

/**
 * The public Transparency Report's response shape, its disclosure-control
 * rules, and the public reason taxonomy it reports against.
 *
 * ## Why every field here is safe to serve to an anonymous visitor
 *
 * This module is the ONLY place in the codebase that hands moderation figures
 * to an unauthenticated caller, so the rule it lives by is stated once, here,
 * and every field is checked against it:
 *
 *   Nothing but counts, durations, and a period label ever leaves this module.
 *
 * Concretely, the report carries no user id, no member name, no handle, no
 * community id, name or slug, no report id, no free text a member or a
 * moderator wrote, and no timestamp of any individual event. There is no field
 * whose value could be a single row's content. `reasonCode`, `ModActionCode`
 * and `AppealStatus` are all closed, server-owned vocabularies, so the keys
 * below are fixed strings this file enumerates rather than anything a caller
 * supplied. Durations are summary statistics over a set, never one case's
 * elapsed time (see `MIN_SAMPLE_FOR_*` below for the sizes that guarantee it).
 *
 * ## Why counts are suppressed at all
 *
 * A count is not automatically anonymous. On a community this size, "1 outing
 * report this quarter" is, to the handful of people who were there, a specific
 * person and a specific incident. So a count that is small enough to be about
 * one identifiable person is withheld and published as "fewer than
 * `SMALL_COUNT_FLOOR`" instead of as a number.
 */

/**
 * Counts of 1 to 4 are withheld. Zero is published as zero: a zero names
 * nobody, and withholding it would make "we received no reports of this" and
 * "we received a few" indistinguishable, which reads as a cover-up rather than
 * as care.
 *
 * 5 is the floor used across official small-area statistics for the same
 * reason it works here: it is small enough that most buckets still publish a
 * real number, and large enough that a bucket cannot be read as one person's
 * case.
 */
export const SMALL_COUNT_FLOOR = 5;

/**
 * The smallest set a median may be published over. A median of 5 resolution
 * times is a property of the set, and no single case's elapsed time can be
 * recovered from it.
 */
export const MIN_SAMPLE_FOR_MEDIAN = 5;

/**
 * The smallest set a 90th percentile may be published over. The bar is higher
 * than the median's because a p90 over a handful of cases is effectively the
 * slowest single case, which is one case's elapsed time wearing a statistic's
 * clothes. At 20 the value sits between real observations with several cases
 * on either side.
 */
export const MIN_SAMPLE_FOR_P90 = 20;

/**
 * The smallest number of DECIDED appeals an overturn rate may be published
 * over. Below this a rate is noise: one decision moves it by whole percentage
 * points, and quoting it would repeat exactly the mistake this report exists to
 * correct (the Constitution used to assert "approximately 11%" with nothing
 * computing it). A period with fewer decided appeals publishes no rate and says
 * so.
 */
export const MIN_DECIDED_APPEALS_FOR_RATE = 20;

/**
 * One published figure. `value` is the exact count when it clears the floor and
 * `null` when it was withheld; `isSuppressed` says which of those a `null`
 * means, so the page can render "fewer than 5" rather than a blank.
 */
export interface PublishedCountDTO {
  value: number | null;
  isSuppressed: boolean;
}

/**
 * The public categories reports are counted under. These are deliberately
 * COARSER than the internal `ReasonCode` taxonomy: the internal vocabulary has
 * 17 codes, and 17 buckets over one quarter of a community this size would be
 * mostly ones and twos, which is both uninformative and the exact shape
 * suppression exists to prevent. Six categories keep most buckets above the
 * floor while still saying what kind of harm was reported.
 *
 * The keys are stable identifiers the frontend translates. No label text is
 * served from here.
 */
export type TransparencyReasonCategory =
  | 'privacy'
  | 'harassment'
  | 'impersonation'
  | 'spam'
  | 'space_safety'
  | 'other';

/** Fixed render order, so two periods always list their categories the same
 *  way and a reader can compare them line by line. */
export const TRANSPARENCY_REASON_CATEGORIES: readonly TransparencyReasonCategory[] =
  ['privacy', 'harassment', 'impersonation', 'spam', 'space_safety', 'other'];

const CATEGORY_BY_REASON_CODE: Partial<
  Record<ReasonCode, TransparencyReasonCategory>
> = {
  outing: 'privacy',
  doxxing: 'privacy',
  harassment: 'harassment',
  hate_speech: 'harassment',
  unwanted_contact: 'harassment',
  discrimination: 'harassment',
  impersonation: 'impersonation',
  spam: 'spam',
  off_topic: 'spam',
  venue_safety: 'space_safety',
  venue_staff: 'space_safety',
  venue_accessibility: 'space_safety',
  housing_unsafe: 'space_safety',
  housing_scam: 'space_safety',
  not_affirming: 'space_safety',
  off_platform: 'other',
  other: 'other',
};

/**
 * Public category for a stored `reasonCode`. Falls through to `other` for
 * anything unmapped, which covers the system-filed listing codes
 * (`listing_dispute`, `listing_owner_notify`) and any code added later: a new
 * reason quietly joining "other" is a reporting gap to fix, and a new reason
 * crashing the public report is an outage.
 */
export function categoryForReasonCode(
  reasonCode: string,
): TransparencyReasonCategory {
  return CATEGORY_BY_REASON_CODE[reasonCode as ReasonCode] ?? 'other';
}

/** One row of a published breakdown. `key` is a stable identifier, never a
 *  label: the frontend owns every word a reader sees. */
export interface TransparencyBreakdownRowDTO<Key extends string = string> {
  key: Key;
  count: PublishedCountDTO;
}

/** The reporting period a report covers. Calendar quarters, matching the
 *  quarter the governance finances are already published on. */
export interface TransparencyPeriodDTO {
  /** e.g. "2026-Q3". Stable, sortable, and language-independent. */
  id: string;
  year: number;
  /** 1 to 4. */
  quarter: number;
  /** Inclusive start, ISO-8601 UTC. */
  startsAt: string;
  /** Exclusive end, ISO-8601 UTC. */
  endsAt: string;
  /**
   * How far the figures actually reach: `endsAt` for a finished quarter, and
   * the moment the report was generated for the quarter still running. A
   * running quarter's numbers are a partial count, and saying so is the
   * difference between a figure and a claim.
   */
  coversUntil: string;
  isComplete: boolean;
}

export interface TransparencyPeriodOptionDTO {
  selector: 'current' | 'previous';
  id: string;
  isComplete: boolean;
}

export interface TransparencyReportDTO {
  period: TransparencyPeriodDTO;
  /** The periods this endpoint will serve, so the page's period switcher never
   *  hardcodes a quarter. */
  availablePeriods: TransparencyPeriodOptionDTO[];
  generatedAt: string;
  /** Published so the page can state the suppression rule in the reader's own
   *  language without duplicating the number. */
  smallCountFloor: number;
  reports: {
    /** Reports members filed during the period. */
    received: PublishedCountDTO;
    /** Reports closed out during the period. Deliberately a different set from
     *  `received`: a report filed in March and answered in April belongs to
     *  March's received count and April's resolved count. */
    resolved: PublishedCountDTO;
    byCategory: TransparencyBreakdownRowDTO<TransparencyReasonCategory>[];
    /** Hours from filing to resolution, over the reports resolved in the
     *  period. Null when the set was too small to summarise (see
     *  `MIN_SAMPLE_FOR_MEDIAN` / `MIN_SAMPLE_FOR_P90`). */
    medianHoursToResolution: number | null;
    p90HoursToResolution: number | null;
  };
  actions: {
    /** Moderator actions recorded in the period, by action type. No total is
     *  published for this breakdown (see `suppressBreakdown`). */
    byType: TransparencyBreakdownRowDTO[];
    /**
     * Permanent account removals. The same rows as the `ban` bucket above,
     * surfaced separately because it is the figure a reader looks for, and
     * carrying the SAME suppressed value so the two can never disagree or be
     * played off each other.
     */
    accountsRemoved: PublishedCountDTO;
  };
  appeals: {
    /** Appeals filed during the period. Outcomes below are attributed to the
     *  period an appeal was FILED in, so the three outcome buckets always sum
     *  to this. */
    filed: PublishedCountDTO;
    byOutcome: TransparencyBreakdownRowDTO<
      'upheld' | 'overturned' | 'awaiting'
    >[];
    /**
     * Overturned as a percentage of decided appeals, or null when the period
     * cannot support a rate honestly. Null is a real answer here and the page
     * says so rather than filling the gap.
     */
    overturnRatePercent: number | null;
  };
  communities: {
    /** Communities frozen at least once during the period, counted once each
     *  however many times they were frozen. */
    frozen: PublishedCountDTO;
  };
  /**
   * Demands from courts, police forces, ministries and other arms of a state
   * (PRD-32). Counted off `legal_requests`, the register an admin writes at
   * `/admin/legal-requests`.
   *
   * This section is ALWAYS present, and an empty register publishes an explicit
   * zero. "How often were we asked to hand over member data" is the line a
   * queer community reads first, and a section that appeared only once there
   * was something to report would make its own absence the answer. A reader has
   * to be able to tell "nobody has ever asked" from "we are not saying", so
   * `received` is `{ value: 0, isSuppressed: false }` on an empty quarter and
   * `hasEverReceivedRequest` says whether the register has ever held a live
   * record at all.
   *
   * A failed count is never dressed as a zero: the service lets a query error
   * reject the whole report rather than substituting 0, so an outage surfaces
   * as an error and never as a published "we were never asked".
   */
  legalRequests: TransparencyLegalRequestsDTO;
}

/**
 * The published aggregate over the legal-request register. Counts and sums
 * only: no requesting body, no jurisdiction, no internal note, no reason a
 * record was struck, no data-category list, no date, and no per-request row of
 * any kind. There is no field here whose value could be one demand's content.
 *
 * ## Gag orders are counted
 *
 * A demand QueerPulse is legally barred from describing is still one more
 * demand that arrived, and it is counted in `received`, in both breakdowns and
 * in both account sums exactly like any other. Counting is not describing, and
 * this report never itemises anything anyway, so a gagged request and an
 * ordinary one are published identically. Nothing here marks which is which.
 *
 * ## Voided records are excluded and disclosed
 *
 * A record struck from the register (`POST /admin/legal-requests/:id/void`)
 * drops out of `received`, both breakdowns and both account sums, and is
 * counted in `recordsVoided` instead. Emptying the register is therefore itself
 * a published number rather than a quiet subtraction.
 *
 * Every count on this section runs through the SAME small-count suppression as
 * the rest of the report (`suppressCount` / `suppressBreakdown`,
 * `SMALL_COUNT_FLOOR`). A demand naming two accounts is two identifiable people
 * to anybody who knows the room, so the floor applies here for the same reason
 * it applies to an outing report, and zero is published as zero here for the
 * same reason too.
 */
export interface TransparencyLegalRequestsDTO {
  /**
   * Whether the register has EVER held a live record, over all time rather
   * than this period. Publishing it as a plain boolean is the point of the
   * disclosure: "we have never been asked" is a sentence a platform can only
   * say if it is tracked, and a quarter of zeroes on a young register cannot
   * say it on its own. False plus a zero `received` is the strongest statement
   * this report makes.
   */
  hasEverReceivedRequest: boolean;
  /** Demands received inside the period, by the day they reached QueerPulse. */
  received: PublishedCountDTO;
  /** Breakdown of `received` by the kind of instrument that arrived. Every
   *  type is listed even at zero, so the table's shape is never itself a
   *  signal. */
  byType: TransparencyBreakdownRowDTO<LegalRequestType>[];
  /** Breakdown of `received` by what QueerPulse did about it. `pending` is one
   *  of the buckets: a demand still being answered is reported as one. */
  byOutcome: TransparencyBreakdownRowDTO<LegalRequestOutcome>[];
  /** Member accounts named across the period's demands, summed. Zero is
   *  ordinary: a takedown demand about one post names no account. */
  accountsAffected: PublishedCountDTO;
  /**
   * How many of those accounts were told, summed. Recorded by the team from
   * what they actually did. Nothing in this register sends anything, and
   * QueerPulse sends no email at any point.
   */
  accountsNotified: PublishedCountDTO;
  /**
   * Records recorded as arriving in this period that have since been struck
   * from the register, and are therefore in none of the figures above. Sliced
   * on the same receipt date as everything else on this section, so
   * `received` plus `recordsVoided` is every row the register holds for the
   * window.
   */
  recordsVoided: PublishedCountDTO;
}

/** Suppress one standalone count. */
export function suppressCount(count: number): PublishedCountDTO {
  if (count === 0) return { value: 0, isSuppressed: false };
  if (count < SMALL_COUNT_FLOOR) return { value: null, isSuppressed: true };
  return { value: count, isSuppressed: false };
}

/**
 * Suppress a whole breakdown, including against arithmetic.
 *
 * Withholding one bucket is not enough on its own. If a reader is also given
 * the group's total (and `reports.received` / `appeals.filed` are exactly
 * that), then total minus every published bucket recovers the single withheld
 * one exactly, and the suppression was decorative. So when exactly one bucket
 * would be withheld, the smallest positive bucket left is withheld with it:
 * the subtraction then yields the SUM of two hidden buckets and neither can be
 * read out of it.
 *
 * The rule is applied to every breakdown, including ones this report publishes
 * no total for. A uniform rule is one a reader can check, and it means adding
 * a total to a breakdown later cannot silently re-open the hole.
 *
 * Zero buckets are published as zero and are never chosen as the second
 * withheld bucket: hiding a zero conceals nothing and costs a real number.
 *
 * When no second bucket exists (one positive bucket, everything else zero) the
 * group total is itself below the floor and is withheld by `suppressCount`, so
 * there is nothing to subtract from.
 */
export function suppressBreakdown<Key extends string>(
  entries: readonly { key: Key; count: number }[],
): TransparencyBreakdownRowDTO<Key>[] {
  const published = entries.map((entry) => ({
    key: entry.key,
    rawCount: entry.count,
    count: suppressCount(entry.count),
  }));

  const suppressedEntries = published.filter(
    (entry) => entry.count.isSuppressed,
  );
  if (suppressedEntries.length !== 1) {
    return published.map((entry) => ({ key: entry.key, count: entry.count }));
  }

  let smallestRemaining: (typeof published)[number] | null = null;
  for (const entry of published) {
    if (entry.count.isSuppressed || entry.rawCount === 0) continue;
    if (
      smallestRemaining === null ||
      entry.rawCount < smallestRemaining.rawCount
    ) {
      smallestRemaining = entry;
    }
  }
  if (smallestRemaining !== null) {
    smallestRemaining.count = { value: null, isSuppressed: true };
  }

  return published.map((entry) => ({ key: entry.key, count: entry.count }));
}

/** Round an hour figure to one decimal place, or pass null through. */
export function roundHours(hours: number | null): number | null {
  return hours === null ? null : Math.round(hours * 10) / 10;
}
