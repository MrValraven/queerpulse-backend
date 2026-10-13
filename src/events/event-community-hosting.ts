import { AccessTier } from '../communities/entities/community.entity';
import { EventCommunityStatus } from './entities/event-community.entity';

/** Pending and accepted guests together, per gathering (spec decision 6). */
export const MAX_GUEST_COMMUNITIES = 5;

/**
 * The accepted status as a SQL literal. An enum value only, so inlining it
 * is safe, and it keeps every caller's bound parameters unchanged (the feed
 * specs pin the exact parameter objects of their predicates).
 */
export const ACCEPTED_GUEST_STATUS_SQL = `'${EventCommunityStatus.Accepted}'`;

/**
 * SQL for "this gathering has an ACCEPTED guest row matching
 * `conditionSql`". `eventIdSql` is the outer query's event id column as a
 * quoted reference (`"e"."id"`, `"gathering"."id"`); `guestAlias` must be
 * unique inside the statement; `conditionSql` may read
 * `"<guestAlias>"."community_id"`. Every argument is spliced verbatim into
 * raw SQL, so each one must be a literal reference written in code.
 */
export function acceptedGuestExistsSql(
  eventIdSql: string,
  guestAlias: string,
  conditionSql: string,
): string {
  return `EXISTS (
    SELECT 1 FROM "event_communities" "${guestAlias}"
    WHERE "${guestAlias}"."event_id" = ${eventIdSql}
      AND "${guestAlias}"."status" = ${ACCEPTED_GUEST_STATUS_SQL}
      AND ${conditionSql}
  )`;
}

export type GatheringHostedAs = 'lead' | 'guest';

/** The lead community a guest gathering names: "With {name}". */
export interface LeadCommunityRef {
  slug: string;
  name: string;
}

/** What a community's upcoming-gathering row carries about who hosts it. */
export interface CommunityHostingFields {
  hostedAs: GatheringHostedAs;
  /** Set only on a guest row whose lead the viewer may see. */
  leadCommunity: LeadCommunityRef | null;
}

/**
 * The hosting fields of one gathering listed under `listedCommunityId`.
 * `visibleLeadRef` is the lead as the viewer may see it: null when the lead
 * is withheld (see `isPrivateCommunityWithheld`).
 */
export function toCommunityHostingFields(
  eventLeadCommunityId: string | null,
  listedCommunityId: string,
  visibleLeadRef: LeadCommunityRef | null,
): CommunityHostingFields {
  if (eventLeadCommunityId === listedCommunityId) {
    return { hostedAs: 'lead', leadCommunity: null };
  }
  return {
    hostedAs: 'guest',
    leadCommunity: visibleLeadRef
      ? { slug: visibleLeadRef.slug, name: visibleLeadRef.name }
      : null,
  };
}

/**
 * The private-community naming rule `EventsService.isHostingCommunityWithheld`
 * applies to the lead, stated once for every community a gathering names:
 * a `private` community is withheld from a viewer who is neither one of the
 * gathering's organisers nor on that community's roster.
 */
export function isPrivateCommunityWithheld(input: {
  accessTier: AccessTier;
  isOrganizer: boolean;
  isOnRoster: boolean;
}): boolean {
  return (
    input.accessTier === AccessTier.Private &&
    !input.isOrganizer &&
    !input.isOnRoster
  );
}
