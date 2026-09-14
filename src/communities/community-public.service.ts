import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { toImageUrl } from '../common/image-url';
import { PublicCommunityResponse } from './community-public-response';
import {
  CommunityUpcomingGathering,
  CommunityUpcomingGatheringsResponse,
} from './community-upcoming-gatherings-response';
import {
  CommunityInvite,
  CommunityInviteStatus,
} from './entities/community-invite.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { AccessTier, Community } from './entities/community.entity';
import { isGatedTier } from './community-gate';

/**
 * The only access tiers a signed-out teaser can ever describe. `invite` and
 * `private` are excluded structurally, not by a flag: being findable is
 * incompatible with those tiers by definition, so even a community whose
 * `is_publicly_listed` somehow got set to true while sitting on one of them
 * stays a 404 here.
 */
const PUBLICLY_TEASABLE_TIERS: readonly AccessTier[] = [
  AccessTier.Public,
  AccessTier.Request,
];

/**
 * The roster roles that pass `CommunitiesService`'s moderation/archive
 * carve-out, mirroring its own private `isStaffRole`. Duplicated here rather
 * than imported because `CommunitiesService` is a large service under
 * concurrent edit and this file must not take a dependency on it for a
 * three-value predicate. Keep the two in step.
 */
const COMMUNITY_STAFF_ROLES: readonly RosterRole[] = [
  RosterRole.Owner,
  RosterRole.CoOwner,
  RosterRole.Mod,
];

/**
 * The gathering visibility tiers a member who is NOT on this community's
 * roster may be shown (PRD-145).
 *
 * `public` and `members` are the two tiers that already appear on that
 * member's own `GET /events` browse feed
 * (`EventAudienceGateService.scopedVisibilityWhere`), so listing them under
 * the community that hosts them discloses nothing new: it re-files gatherings
 * the caller could already find.
 *
 * Every other tier is excluded, and excluded as an ALLOW-LIST rather than a
 * "not members-only" exclusion so a future tier is invisible here until
 * somebody deliberately adds it:
 *   - `community`  — members of this roster only. A prospective member is by
 *                    definition not one of them.
 *   - `invite_only`— reachable only through an invitation, never an open list.
 *   - `network` / `extended_network` — scoped to the HOST's connection graph,
 *                    which has nothing to do with this community's roster.
 */
const GATHERING_TIERS_VISIBLE_TO_NON_MEMBERS: readonly EventVisibility[] = [
  EventVisibility.Public,
  EventVisibility.Members,
];

/**
 * The `content_moderation.subject_type` values a takedown is recorded under
 * for a community and for a gathering. Both mirror the private
 * `SUBJECT_TYPE` constants on `CommunitiesService` and `EventsService`, which
 * are the writers; neither is exported, and neither of those services is a
 * dependency this file should take on for a string. Keep them in step.
 */
const COMMUNITY_SUBJECT_TYPE = 'community';
const EVENT_SUBJECT_TYPE = 'event';

/** One bounded page of `GET /communities/:slug/upcoming-gatherings`. */
const UPCOMING_GATHERINGS_PAGE_SIZE = 10;

/**
 * Hard ceiling on how deep the Events tab may page. Ten pages of gatherings is
 * already far past what any community has, and an unbounded `page` would let a
 * caller drive arbitrarily large `OFFSET`s.
 */
const UPCOMING_GATHERINGS_MAX_PAGE = 10;

/**
 * Backs `GET /communities/:slug/public` — the signed-out teaser behind a
 * shared community link, which today is a sign-in wall with no context.
 *
 * The product decision this encodes is OWNER OPT-IN, DEFAULT OFF. Three
 * conditions must ALL hold or the endpoint 404s, and 404 (never 403) is the
 * answer in every failing case so the endpoint never confirms that a
 * non-listed community exists:
 *   1. `is_publicly_listed` is true (the owner turned it on),
 *   2. the access tier is `public` or `request`,
 *   3. the community is not archived.
 *
 * What comes back is `PublicCommunityResponse` and nothing else. Read that
 * type's comment before adding a field: the roster, the owner's identity,
 * every post, and the rules text are all excluded deliberately.
 *
 * SECOND RESPONSIBILITY (PRD-145): `listUpcomingGatherings`, backing `GET
 * /communities/:slug/upcoming-gatherings` for a SIGNED-IN member who is not
 * on the roster. Both methods answer the same question at two different
 * distances: what may somebody outside a community's roster be shown of it.
 * The signed-out teaser gets one `public` gathering; a signed-in prospective
 * member gets a bounded page of the `public` and `members` ones, because
 * those already appear on their own gatherings browse. Neither ever reaches
 * a post or a roster.
 *
 * THIRD RESPONSIBILITY: `getGateCard`, backing `GET /communities/:slug/gate`
 * for a SIGNED-IN caller who is not on the roster of a community whose tier
 * is not `public`. All three methods answer the same question at three
 * different distances: what may somebody outside a community's roster be
 * shown of it.
 */
@Injectable()
export class CommunityPublicService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    // The private tier's one exception, read by `getGateCard` alone: a standing
    // invitation is what lets somebody off a private community's roster learn
    // it is there. `listUpcomingGatherings` deliberately does NOT pass that
    // option, so its gate stays exactly as narrow as it is today.
    @InjectRepository(CommunityInvite)
    private readonly invites: Repository<CommunityInvite>,
    // PRD-145: the prospective-member gatherings list applies the same
    // moderator-takedown gate `CommunitiesService.getBySlug` applies, so a
    // hidden or removed community stays a 404 there too.
    private readonly contentModeration: ContentModerationService,
  ) {}

  async getPublicTeaser(slug: string): Promise<PublicCommunityResponse> {
    // One indexed lookup on the unique slug, with all three gates in the
    // WHERE clause so a community that fails any of them is simply not found.
    const community = await this.communities.findOne({
      where: {
        slug,
        isPubliclyListed: true,
        archivedAt: IsNull(),
      },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    // The tier gate is applied here rather than inlined above only because
    // TypeORM's `In` on an enum column reads worse than the explicit check;
    // the effect is identical, and the answer is the same 404.
    if (!PUBLICLY_TEASABLE_TIERS.includes(community.accessTier)) {
      throw new NotFoundException('Community not found');
    }

    const { memberCount, nextGathering } = await this.loadCardFacts(community);
    return this.toPublicCard(community, memberCount, nextGathering);
  }

  /**
   * `GET /communities/:slug/gate`: what a SIGNED-IN member of the platform
   * sees when they open a community they are not on the roster of and whose
   * tier is not `public`.
   *
   * The third distance in this file, and the reason all three live together.
   * The anonymous teaser answers "what may the internet see of a community its
   * owner listed publicly". `listUpcomingGatherings` answers "which of a
   * community's gatherings may a prospective member see". This answers "what
   * may somebody the community has not let in see of it at all", and the
   * answer is deliberately the same closed field list as the teaser's: one
   * definition of what an outsider may see, guarded by one `DO NOT WIDEN`
   * block.
   *
   * Two differences from the teaser, both because the caller is signed in:
   * `is_publicly_listed` is not required (that flag governs reach outside the
   * platform, and this card never leaves it), and every tier can appear (the
   * tier is the thing the card exists to explain).
   *
   * A roster member who calls this gets the card rather than a refusal. It
   * discloses nothing to somebody already inside, and refusing them would be a
   * second membership rule to keep in step with `getBySlug`'s.
   */
  async getGateCard(
    slug: string,
    viewerId: string,
  ): Promise<PublicCommunityResponse> {
    const { community } = await this.assertCommunityVisible(slug, viewerId, {
      allowPendingInvite: true,
    });
    const { memberCount, nextGathering } = await this.loadCardFacts(community);
    return this.toPublicCard(community, memberCount, nextGathering);
  }

  /**
   * `GET /communities/:slug/upcoming-gatherings` — PRD-145, the Events tab a
   * PROSPECTIVE member sees.
   *
   * The bug this closes: `GET /communities/:slug/pulse` is roster-only, so a
   * signed-in member looking at a public community they have not joined was
   * told "No upcoming gatherings" whatever the calendar actually held.
   * Gatherings are the strongest reason to join a community, and the people
   * being shown an empty tab were exactly the people the community wants.
   *
   * THREE GATES, in this order.
   *
   * 1. MAY THIS CALLER SEE THE COMMUNITY AT ALL. `assertCommunityVisible`
   *    reproduces the three gates `CommunitiesService.getBySlug` applies, and
   *    answers 404 in every failing case so existence is never leaked: a
   *    `private` community stays invisible to anyone off its roster, a
   *    moderator takedown and an archived community stay visible only to that
   *    community's own staff.
   * 2. IS THIS CALLER A NON-MEMBER OF A GATED TIER. A non-member of anything
   *    but `public` gets the gate card instead of this tab; see below.
   * 3. WHICH OF ITS GATHERINGS MAY THEY SEE. Published, still upcoming, not
   *    under a takedown, and in one of
   *    `GATHERING_TIERS_VISIBLE_TO_NON_MEMBERS` — the same two tiers the
   *    caller's own `GET /events` browse already shows them. A members-only
   *    (`community`) gathering never appears here.
   *
   * Cost is three queries flat regardless of page size: the community, the
   * page of gatherings, and ONE grouped RSVP tally across that whole page.
   * Ordering is soonest first with `id` as the tiebreak, so a page boundary
   * between two gatherings sharing a start time is stable.
   */
  async listUpcomingGatherings(
    slug: string,
    viewerId: string,
    requestedPage: number,
  ): Promise<CommunityUpcomingGatheringsResponse> {
    const { community, role } = await this.assertCommunityVisible(
      slug,
      viewerId,
    );

    // A non-member of a gated tier no longer has an Events tab to fill: they
    // get the gate card, whose `nextGathering` is public-visibility only. This
    // lane exists for a prospective member of a `public` community, and
    // serving anybody else the `members`-visibility calendar of a community
    // that has not let them in was a leak. 404 rather than 403, matching this
    // method's never-403 posture, and reading the role
    // `assertCommunityVisible` already resolved so the method still costs
    // three queries flat.
    if (isGatedTier(community.accessTier) && !role) {
      throw new NotFoundException('Community not found');
    }

    const page = Math.min(
      Math.max(Math.trunc(requestedPage) || 1, 1),
      UPCOMING_GATHERINGS_MAX_PAGE,
    );
    const now = new Date();
    // One extra row is fetched purely to answer `hasMore` without a second
    // COUNT over the same predicate; it is sliced off before mapping.
    const rows = await this.events
      .createQueryBuilder('gathering')
      .where('gathering.communityId = :communityId', {
        communityId: community.id,
      })
      .andWhere('gathering.status = :publishedStatus', {
        publishedStatus: EventStatus.Published,
      })
      // A gathering that is UNDERWAY is still upcoming, matching browse's
      // 'upcoming' predicate in `EventsService.list`, the member lane in
      // `EventsService.listUpcomingByCommunity`, and `nextGathering` above.
      // Without it a prospective member lost an overnight party at 23:00 and
      // lost a three-day festival on its second and third days, while a member
      // reading the same community still saw both. The whole disjunct is
      // parenthesised so it stays ONE conjunct: an unparenthesised `OR` here
      // would bind loosely enough to widen the visibility and takedown filters
      // beside it. `end_at IS NOT NULL` is stated even though SQL never
      // matches NULL against `>=`, because it says out loud that a gathering
      // with no stated end is over once it has started.
      .andWhere(
        '(gathering.start_at >= :now OR (gathering.end_at IS NOT NULL AND gathering.end_at >= :now))',
        { now },
      )
      .andWhere('gathering.visibility IN (:...visibleTiers)', {
        visibleTiers: [...GATHERING_TIERS_VISIBLE_TO_NON_MEMBERS],
      })
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "content_moderation" "cm"
          WHERE "cm"."subject_type" = :eventSubjectType
            AND "cm"."subject_id" = gathering.id::text
            AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
        )`,
        { eventSubjectType: EVENT_SUBJECT_TYPE },
      )
      .orderBy('gathering.startAt', 'ASC')
      // The tiebreak. Two gatherings starting at the same minute is ordinary
      // (a double bill, a series occurrence), and without this the page
      // boundary between them could repeat or drop one.
      .addOrderBy('gathering.id', 'ASC')
      // `.offset()/.limit()` rather than `.skip()/.take()`: there is no join
      // here, so the distinct-id pagination pass buys nothing and the plain
      // OFFSET/LIMIT is what the ordering above is written against.
      .offset((page - 1) * UPCOMING_GATHERINGS_PAGE_SIZE)
      .limit(UPCOMING_GATHERINGS_PAGE_SIZE + 1)
      .getMany();

    const hasMore = rows.length > UPCOMING_GATHERINGS_PAGE_SIZE;
    const gatherings = hasMore
      ? rows.slice(0, UPCOMING_GATHERINGS_PAGE_SIZE)
      : rows;
    const goingCounts = await this.goingCountsFor(gatherings);

    return {
      items: gatherings.map((gathering) =>
        this.toUpcomingGathering(gathering, goingCounts),
      ),
      page,
      hasMore,
    };
  }

  /**
   * Resolves a community by slug for a SIGNED-IN caller and answers 404
   * unless they are allowed to know it exists. The three gates are
   * `CommunitiesService.getBySlug`'s, in its order and with its 404-never-403
   * posture, so a second weaker copy of that rule cannot drift into being:
   * private tier without a roster role, a moderator takedown, and an archived
   * community, the last two forgiven only for that community's own staff.
   */
  private async assertCommunityVisible(
    slug: string,
    viewerId: string,
    // `allowPendingInvite` opens the private-tier branch below to the holder
    // of a standing invitation, which is the carve-out
    // `CommunitiesService.getBySlug` already makes. Off by default, so a
    // caller has to ask for it: `getGateCard` does, and
    // `listUpcomingGatherings` must not.
    options: { allowPendingInvite?: boolean } = {},
    // Returns the caller's roster role alongside the community because it
    // already loaded it to answer the gates below. `listUpcomingGatherings`
    // reads it for its own tier gate, and without this it would run a second
    // identical `members.findOne` on a method that advertises three queries
    // flat.
  ): Promise<{ community: Community; role: RosterRole | null }> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const membership = await this.members.findOne({
      where: { communityId: community.id, userId: viewerId },
    });
    const role = membership?.role ?? null;
    if (community.accessTier === AccessTier.Private && !role) {
      const hasPendingInvite =
        options.allowPendingInvite === true &&
        (await this.invites.exists({
          where: {
            communityId: community.id,
            invitedUserId: viewerId,
            status: CommunityInviteStatus.Pending,
          },
        }));
      if (!hasPendingInvite) {
        throw new NotFoundException('Community not found');
      }
    }
    const isCommunityStaff =
      role !== null && COMMUNITY_STAFF_ROLES.includes(role);
    const moderation = await this.contentModeration.stateFor(
      COMMUNITY_SUBJECT_TYPE,
      community.slug,
    );
    if ((moderation.hidden || moderation.removed) && !isCommunityStaff) {
      throw new NotFoundException('Community not found');
    }
    if (community.archivedAt != null && !isCommunityStaff) {
      throw new NotFoundException('Community not found');
    }
    return { community, role };
  }

  /**
   * The two facts a card carries beyond the community row itself: how many
   * people are on the roster (a COUNT, never who) and the next PUBLIC
   * gathering. Run together, so a card costs three queries flat including the
   * community lookup.
   *
   * PUBLIC visibility only, and written as an equality on `public` rather than
   * as an exclusion list, so a future visibility tier cannot quietly widen
   * what a card discloses. A `members`, `community`, `network` or
   * `invite_only` gathering is not something an outsider may learn exists.
   */
  private async loadCardFacts(community: Community): Promise<{
    memberCount: number;
    nextGathering: Event | null;
  }> {
    const now = new Date();
    const nextGatheringScope = {
      communityId: community.id,
      status: EventStatus.Published,
      visibility: EventVisibility.Public,
    };
    const [memberCount, nextGathering] = await Promise.all([
      this.members.count({ where: { communityId: community.id } }),
      this.events.findOne({
        // A gathering that is UNDERWAY is still the next one, matching
        // browse's 'upcoming' predicate in `EventsService.list`. Find-options
        // cannot write that disjunct inline, so it is two arms of an OR that
        // BOTH carry the whole scope above: the arms differ only in which
        // timestamp they test, so neither can admit anything the other would
        // refuse. `endAt: MoreThanOrEqual(now)` carries the
        // `end_at IS NOT NULL` half for free, since SQL never matches NULL
        // against `>=`. `ORDER BY start_at ASC` then puts a gathering that is
        // already running ahead of one that has yet to begin, which is the
        // order a visitor wants.
        where: [
          { ...nextGatheringScope, startAt: MoreThanOrEqual(now) },
          { ...nextGatheringScope, endAt: MoreThanOrEqual(now) },
        ],
        order: { startAt: 'ASC' },
        select: {
          id: true,
          slug: true,
          title: true,
          startAt: true,
          // Carried because a gathering that is UNDERWAY can win this query,
          // so a start instant in the past is a correct answer and the end is
          // what makes it legible. See `PublicCommunityGathering.endAt`.
          endAt: true,
          isOnline: true,
        },
      }),
    ]);
    return { memberCount, nextGathering };
  }

  /**
   * The ONE place a community becomes a `PublicCommunityResponse`. Both doors
   * that serve that type go through here (the anonymous teaser and the
   * signed-in gate card), so a field cannot reach one outsider without
   * reaching the other, and the type's `DO NOT WIDEN` block governs a single
   * mapper rather than two literals that drift.
   */
  private toPublicCard(
    community: Community,
    memberCount: number,
    nextGathering: Event | null,
  ): PublicCommunityResponse {
    return {
      slug: community.slug,
      name: community.name,
      tagline: community.tagline,
      purpose: community.purpose,
      type: community.type,
      accessTier: community.accessTier,
      tags: community.tags ?? [],
      city: community.city,
      area: community.area,
      isOnline: community.isOnline,
      languages: community.languages ?? [],
      memberCount,
      avatarImageUrl: toImageUrl(community.avatarImageUrl),
      coverImageUrl: toImageUrl(community.coverImageUrl),
      nextGathering: nextGathering
        ? {
            slug: nextGathering.slug,
            title: nextGathering.title,
            startAt: nextGathering.startAt,
            endAt: nextGathering.endAt,
            isOnline: nextGathering.isOnline,
          }
        : null,
    };
  }

  /**
   * ONE grouped tally of 'going' RSVPs across a whole page of gatherings,
   * keyed by event id. Never a query per gathering, and never run at all when
   * every host on the page has turned `showAttendeeCount` off.
   */
  private async goingCountsFor(
    gatherings: Event[],
  ): Promise<Map<string, number>> {
    const countedIds = gatherings
      .filter((gathering) => gathering.showAttendeeCount)
      .map((gathering) => gathering.id);
    if (!countedIds.length) return new Map();

    const goingRows = await this.events.manager
      .createQueryBuilder(EventRsvp, 'rsvp')
      .select('rsvp.event_id', 'eventId')
      .addSelect('COUNT(*)', 'count')
      .where('rsvp.event_id IN (:...countedIds)', { countedIds })
      .andWhere('rsvp.status = :goingStatus', { goingStatus: RsvpStatus.Going })
      .groupBy('rsvp.event_id')
      .getRawMany<{ eventId: string; count: string }>();
    return new Map(goingRows.map((row) => [row.eventId, Number(row.count)]));
  }

  /**
   * Maps one gathering to the closed `CommunityUpcomingGathering` shape. Read
   * that type's comment before adding a field: `address` and `arrivalNotes`
   * are absent on purpose, and `goingCount` is null whenever the host chose
   * not to publish it.
   */
  private toUpcomingGathering(
    gathering: Event,
    goingCounts: Map<string, number>,
  ): CommunityUpcomingGathering {
    return {
      slug: gathering.slug,
      title: gathering.title,
      startAt: gathering.startAt,
      endAt: gathering.endAt,
      isOnline: gathering.isOnline,
      venue: gathering.venue,
      neighbourhood: gathering.neighbourhood,
      eventType: gathering.eventType,
      cost: gathering.cost,
      coverImageUrl: toImageUrl(gathering.coverImageUrl),
      goingCount: gathering.showAttendeeCount
        ? (goingCounts.get(gathering.id) ?? 0)
        : null,
    };
  }
}
