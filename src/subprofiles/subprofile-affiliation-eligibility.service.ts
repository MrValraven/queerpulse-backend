import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { CommunityMember } from '../communities/entities/community-member.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import {
  EventLineupEntry,
  EventLineupEntryStatus,
} from '../events/entities/event-lineup-entry.entity';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { BlockFilterService } from '../social/block-filter.service';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  FlashDayEventRef,
  flashDayEventSlugOf,
  isLinkableFlashDayEvent,
  toFlashDayEventRef,
} from './flash-day-event-links';
import { AFFILIATION_TARGET_TYPES } from './subprofile-validation';

export type AffiliationTargetType = (typeof AFFILIATION_TARGET_TYPES)[number];

// One entry of `GET /subprofiles/:id/affiliation-options`: a target the
// requesting owner belongs to and could link under "Part of". Hand-mapped
// from the entity rows in `listOptions`.
export interface AffiliationOption {
  targetType: AffiliationTargetType;
  targetSlug: string;
  // `event.title` or `community.name`.
  name: string;
  // Mirrors the read side's `AffiliationView`: events resolve their cover
  // through `toImageUrl`, and communities always carry null.
  imageUrl: string | null;
  // ISO string of `event.startAt`; null for communities.
  startsAt: string | null;
}

// How many options of each target type the picker is offered.
export const MAX_AFFILIATION_OPTIONS_PER_TYPE = 100;

// The key `eligibleTargetKeys` records for "this user qualifies for this
// target". Keyed by the target's id (stable across a slug rename) and the
// qualifying user, so one batched lookup over the union of several personas'
// owners can still answer each persona separately.
export function eligibilityKey(
  targetType: AffiliationTargetType,
  targetId: string,
  userId: string,
): string {
  return `${targetType}:${targetId}:${userId}`;
}

// The per-persona check over a set built by `eligibleTargetKeys`: a link is
// allowed when ANY of the persona's owners qualifies for the target.
export function hasQualifyingOwner(
  eligibleKeys: Set<string>,
  targetType: AffiliationTargetType,
  targetId: string,
  ownerIds: readonly string[],
): boolean {
  return ownerIds.some((ownerId) =>
    eligibleKeys.has(eligibilityKey(targetType, targetId, ownerId)),
  );
}

// The distinct hosts of `eventRows`, for one batched block lookup. A hostless
// event has nobody to block, so it adds nothing.
function hostIdsOf(eventRows: Pick<Event, 'hostId'>[]): string[] {
  return [
    ...new Set(
      eventRows
        .map((event) => event.hostId)
        .filter((hostId): hostId is string => hostId !== null),
    ),
  ];
}

// "Part of" links are a persona's claim to belong somewhere, so a link may only
// be saved or shown while at least one of the persona's owners actually does:
//
//   community: a `community_members` row, any roster role.
//   event:     going. The host, a co-host, an accepted lineup entry, or an RSVP whose
//              status is `going`. Maybe, waitlisted and cancelled RSVPs do
//              not count (a host removal also lands on `cancelled`).
//
// These checks sit on top of the existence, public-visibility and block
// checks `SubprofilesService.replaceAffiliations` and
// `SubprofilePublicReadService.resolveAffiliationsFor` already apply. Every
// method is batched: a fixed number of queries however many personas, owners
// or targets are asked about.
@Injectable()
export class SubprofileAffiliationEligibilityService {
  constructor(
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(EventCohost)
    private readonly eventCohosts: Repository<EventCohost>,
    @InjectRepository(EventLineupEntry)
    private readonly eventLineupEntries: Repository<EventLineupEntry>,
    @InjectRepository(EventRsvp)
    private readonly eventRsvps: Repository<EventRsvp>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly blockFilter: BlockFilterService,
  ) {}

  // subprofileId -> every owner of that persona. The owner/co-owner gate
  // (`SubprofileMembershipService.isMember`) reads `subprofile_members`, and
  // the creator is always inserted as the first member. `Subprofile.userId`
  // is unioned in anyway, so a creator whose member row is somehow missing
  // still counts. Two queries total.
  async ownerIdsFor(subprofileIds: string[]): Promise<Map<string, string[]>> {
    const ownerIdsBySubprofileId = new Map<string, string[]>();
    const distinctSubprofileIds = [...new Set(subprofileIds)];
    if (!distinctSubprofileIds.length) {
      return ownerIdsBySubprofileId;
    }
    const [memberRows, subprofileRows] = await Promise.all([
      this.members.find({
        where: { subprofileId: In(distinctSubprofileIds) },
        select: { subprofileId: true, userId: true },
      }),
      this.subprofiles.find({
        where: { id: In(distinctSubprofileIds) },
        select: { id: true, userId: true },
      }),
    ]);

    const ownerSetBySubprofileId = new Map<string, Set<string>>();
    const addOwner = (subprofileId: string, userId: string) => {
      const ownerSet = ownerSetBySubprofileId.get(subprofileId);
      if (ownerSet) {
        ownerSet.add(userId);
      } else {
        ownerSetBySubprofileId.set(subprofileId, new Set([userId]));
      }
    };
    for (const subprofile of subprofileRows) {
      addOwner(subprofile.id, subprofile.userId);
    }
    for (const member of memberRows) {
      addOwner(member.subprofileId, member.userId);
    }
    for (const [subprofileId, ownerSet] of ownerSetBySubprofileId) {
      ownerIdsBySubprofileId.set(subprofileId, [...ownerSet]);
    }
    return ownerIdsBySubprofileId;
  }

  // Which of `ownerIds` qualify for which of the given targets, as a set of
  // `eligibilityKey`s. Hosting is read off the event rows the caller already
  // loaded; the other four signals are ONE query each (community members,
  // co-hosts, accepted lineup entries, going RSVPs), whatever the number of
  // owners or targets. Check a persona with `hasQualifyingOwner`.
  //
  // `shouldCountGoingRsvps` defaults to true, the "Part of" rule. Flash day
  // event links pass false: only hosting, co-hosting and an accepted lineup
  // entry qualify there, and the RSVP query is skipped.
  async eligibleTargetKeys(
    ownerIds: string[],
    eventRows: Pick<Event, 'id' | 'hostId'>[],
    communityIds: string[],
    options: { shouldCountGoingRsvps?: boolean } = {},
  ): Promise<Set<string>> {
    const shouldCountGoingRsvps = options.shouldCountGoingRsvps ?? true;
    const eligibleKeys = new Set<string>();
    const distinctOwnerIds = [...new Set(ownerIds)];
    if (!distinctOwnerIds.length) {
      return eligibleKeys;
    }
    const ownerIdSet = new Set(distinctOwnerIds);
    for (const event of eventRows) {
      if (event.hostId !== null && ownerIdSet.has(event.hostId)) {
        eligibleKeys.add(eligibilityKey('event', event.id, event.hostId));
      }
    }

    const eventIds = [...new Set(eventRows.map((event) => event.id))];
    const distinctCommunityIds = [...new Set(communityIds)];
    const [communityMemberRows, cohostRows, lineupRows, goingRsvpRows] =
      await Promise.all([
        distinctCommunityIds.length
          ? this.communityMembers.find({
              where: {
                communityId: In(distinctCommunityIds),
                userId: In(distinctOwnerIds),
              },
              select: { communityId: true, userId: true },
            })
          : Promise.resolve([]),
        eventIds.length
          ? this.eventCohosts.find({
              where: { eventId: In(eventIds), userId: In(distinctOwnerIds) },
              select: { eventId: true, userId: true },
            })
          : Promise.resolve([]),
        eventIds.length
          ? this.eventLineupEntries.find({
              where: {
                eventId: In(eventIds),
                userId: In(distinctOwnerIds),
                status: EventLineupEntryStatus.Accepted,
              },
              select: { eventId: true, userId: true },
            })
          : Promise.resolve([]),
        eventIds.length && shouldCountGoingRsvps
          ? this.eventRsvps.find({
              where: {
                eventId: In(eventIds),
                userId: In(distinctOwnerIds),
                status: RsvpStatus.Going,
              },
              select: { eventId: true, userId: true },
            })
          : Promise.resolve([]),
      ]);

    for (const membership of communityMemberRows) {
      eligibleKeys.add(
        eligibilityKey('community', membership.communityId, membership.userId),
      );
    }
    for (const eventRow of [...cohostRows, ...lineupRows, ...goingRsvpRows]) {
      eligibleKeys.add(
        eligibilityKey('event', eventRow.eventId, eventRow.userId),
      );
    }
    return eligibleKeys;
  }

  // Every target `requesterId` belongs to that would also pass
  // `replaceAffiliations`' save rules, for the "Part of" picker. Only the
  // requester's own memberships and RSVPs are read: a co-owner's private
  // memberships stay theirs, and the any-owner rule at save and read keeps a
  // co-owner's existing links alive anyway. Events must be published and not
  // invite-only; communities must not be private or archived; and the host
  // or owner must not be blocked either way with `personaUserId` (the
  // persona's `userId`, the same party the save-time block check uses) or
  // with `requesterId`. A hostless event or ownerless community passes the
  // block checks, as it does at save time.
  //
  // Communities are ONE query, qualification an `EXISTS` keyed by community
  // id and user. Events are four candidate-id lookups keyed by the requester
  // (host, co-host, accepted lineup entry, going RSVP), unioned in memory,
  // then ONE events query over those ids. Every filter sits inside the final
  // queries, so the cap counts only options the picker can use. Communities
  // come alphabetically by name, then upcoming events soonest first, then
  // past events newest first.
  async listOptions(
    requesterId: string,
    personaUserId: string,
  ): Promise<AffiliationOption[]> {
    const communityQuery = this.communities
      .createQueryBuilder('community')
      .where('community.accessTier != :privateTier', {
        privateTier: AccessTier.Private,
      })
      .andWhere('community.archivedAt IS NULL')
      .andWhere(
        `EXISTS (
          SELECT 1 FROM "community_members" "requesterMembership"
          WHERE "requesterMembership"."community_id" = "community"."id"
            AND "requesterMembership"."user_id" = :requesterId
        )`,
        { requesterId },
      );
    // Raw column reference, so it must be the DB's snake_case name.
    this.blockFilter.excludeBlocked(
      communityQuery,
      personaUserId,
      '"community"."owner_id"',
    );
    this.excludeBlockedWithRequester(
      communityQuery,
      requesterId,
      personaUserId,
      '"community"."owner_id"',
    );

    const [communityRows, eventRows] = await Promise.all([
      communityQuery
        .orderBy('community.name', 'ASC')
        .take(MAX_AFFILIATION_OPTIONS_PER_TYPE)
        .getMany(),
      this.listEventOptionRows(requesterId, personaUserId),
    ]);

    const communityOptions = communityRows.map(
      (community): AffiliationOption => ({
        targetType: 'community',
        targetSlug: community.slug,
        name: community.name,
        imageUrl: null,
        startsAt: null,
      }),
    );
    const eventOptions = eventRows.map((event): AffiliationOption => ({
      targetType: 'event',
      targetSlug: event.slug,
      name: event.title,
      imageUrl: toImageUrl(event.coverImageUrl),
      startsAt: event.startAt.toISOString(),
    }));
    return [...communityOptions, ...eventOptions];
  }

  // The flash day event picker (`GET /subprofiles/:id/flash-day-event-options`).
  // An unlinked persona gets no event links, so it gets no options and no
  // query runs. Otherwise the requester's own events, with the order, cap and
  // block checks of the "Part of" picker, narrowed to the flash day rule:
  // hosting, co-hosting or an accepted lineup entry, on a published event
  // whose visibility is `public`.
  async listFlashDayEventOptions(
    requesterId: string,
    persona: Pick<Subprofile, 'userId' | 'linkVisibility'>,
  ): Promise<FlashDayEventRef[]> {
    if (persona.linkVisibility === SubprofileLinkVisibility.Unlinked) {
      return [];
    }
    const eventRows = await this.listEventOptionRows(
      requesterId,
      persona.userId,
      { shouldCountGoingRsvps: false, shouldRequirePublicVisibility: true },
    );
    return eventRows.map((event) => toFlashDayEventRef(event));
  }

  // The save-time check for `flash_days` event links: which of `eventSlugs`
  // this persona may link. A slug passes when its event exists, is published
  // and `public`, its host is clear of a block either way with the persona's
  // `userId`, and at least one persona owner hosts, co-hosts or plays it as
  // an accepted lineup act. One events query, one block lookup, then the
  // owner and eligibility lookups, however many slugs are asked about.
  // Linked status is the caller's check.
  async eligibleFlashDayEventSlugs(
    persona: Pick<Subprofile, 'id' | 'userId'>,
    eventSlugs: string[],
  ): Promise<Set<string>> {
    const eligibleSlugs = new Set<string>();
    const distinctSlugs = [
      ...new Set(
        eventSlugs
          .map((eventSlug) => eventSlug.trim())
          .filter((eventSlug) => eventSlug.length > 0),
      ),
    ];
    if (!distinctSlugs.length) {
      return eligibleSlugs;
    }
    const eventRows = await this.events.find({
      where: { slug: In(distinctSlugs) },
      select: {
        id: true,
        slug: true,
        hostId: true,
        status: true,
        visibility: true,
      },
    });
    const linkableRows = eventRows.filter((event) =>
      isLinkableFlashDayEvent(event),
    );
    if (!linkableRows.length) {
      return eligibleSlugs;
    }

    const blockedHostIds = await this.blockFilter.blockedUserIds(
      persona.userId,
      hostIdsOf(linkableRows),
    );
    const unblockedRows = linkableRows.filter(
      (event) => event.hostId === null || !blockedHostIds.has(event.hostId),
    );
    if (!unblockedRows.length) {
      return eligibleSlugs;
    }

    const ownerIdsBySubprofileId = await this.ownerIdsFor([persona.id]);
    const ownerIds = ownerIdsBySubprofileId.get(persona.id) ?? [];
    const eligibleKeys = await this.eligibleTargetKeys(
      ownerIds,
      unblockedRows,
      [],
      { shouldCountGoingRsvps: false },
    );
    for (const event of unblockedRows) {
      if (hasQualifyingOwner(eligibleKeys, 'event', event.id, ownerIds)) {
        eligibleSlugs.add(event.slug);
      }
    }
    return eligibleSlugs;
  }

  // The read-time resolution of `flash_days` event links, owner and public
  // views alike: item id -> the linked event's public fields. The save rules
  // apply again (a linked persona, a published `public` event, a host clear
  // of a block with the persona's `userId`, a qualifying owner) plus a block
  // check between the host and the viewer. An item whose link fails any rule
  // has no entry, so the caller can drop its slug from the DTO.
  //
  // Batched over every persona and item: one events query, one viewer block
  // lookup, one block lookup per distinct persona creator, one owner lookup
  // and one eligibility lookup.
  async resolveFlashDayEvents(
    viewerId: string,
    personas: Pick<Subprofile, 'id' | 'userId' | 'linkVisibility'>[],
    items: Pick<
      SubprofileItem,
      'id' | 'subprofileId' | 'section' | 'structured'
    >[],
  ): Promise<Map<string, FlashDayEventRef>> {
    const linkedEventByItemId = new Map<string, FlashDayEventRef>();
    const linkedPersonaById = new Map(
      personas
        .filter(
          (persona) =>
            persona.linkVisibility !== SubprofileLinkVisibility.Unlinked,
        )
        .map((persona) => [persona.id, persona]),
    );

    const candidateLinks: {
      itemId: string;
      persona: Pick<Subprofile, 'id' | 'userId'>;
      eventSlug: string;
    }[] = [];
    for (const item of items) {
      if (item.section !== SubprofileSection.FlashDays) {
        continue;
      }
      const persona = linkedPersonaById.get(item.subprofileId);
      const eventSlug = flashDayEventSlugOf(item.structured);
      if (persona && eventSlug) {
        candidateLinks.push({ itemId: item.id, persona, eventSlug });
      }
    }
    if (!candidateLinks.length) {
      return linkedEventByItemId;
    }

    const eventRows = await this.events.find({
      where: {
        slug: In([...new Set(candidateLinks.map((link) => link.eventSlug))]),
      },
      select: {
        id: true,
        slug: true,
        title: true,
        startAt: true,
        endAt: true,
        venue: true,
        neighbourhood: true,
        isOnline: true,
        coverImageUrl: true,
        hostId: true,
        status: true,
        visibility: true,
      },
    });
    const linkableRows = eventRows.filter((event) =>
      isLinkableFlashDayEvent(event),
    );
    if (!linkableRows.length) {
      return linkedEventByItemId;
    }
    const linkableEventBySlug = new Map(
      linkableRows.map((event) => [event.slug, event]),
    );

    const hostIds = hostIdsOf(linkableRows);
    const creatorIds = [
      ...new Set(candidateLinks.map((link) => link.persona.userId)),
    ];
    const subprofileIds = [
      ...new Set(candidateLinks.map((link) => link.persona.id)),
    ];
    const [
      viewerBlockedHostIds,
      creatorBlockedHostIdSets,
      ownerIdsBySubprofileId,
    ] = await Promise.all([
      this.blockFilter.blockedUserIds(viewerId, hostIds),
      Promise.all(
        creatorIds.map((creatorId) =>
          this.blockFilter.blockedUserIds(creatorId, hostIds),
        ),
      ),
      this.ownerIdsFor(subprofileIds),
    ]);
    const blockedHostIdsByCreatorId = new Map(
      creatorIds.map((creatorId, creatorIndex) => [
        creatorId,
        creatorBlockedHostIdSets[creatorIndex],
      ]),
    );
    const eligibleKeys = await this.eligibleTargetKeys(
      [...new Set([...ownerIdsBySubprofileId.values()].flat())],
      linkableRows,
      [],
      { shouldCountGoingRsvps: false },
    );

    for (const link of candidateLinks) {
      const event = linkableEventBySlug.get(link.eventSlug);
      if (!event) {
        continue;
      }
      const isHostBlocked =
        event.hostId !== null &&
        (viewerBlockedHostIds.has(event.hostId) ||
          (blockedHostIdsByCreatorId
            .get(link.persona.userId)
            ?.has(event.hostId) ??
            false));
      if (
        isHostBlocked ||
        !hasQualifyingOwner(
          eligibleKeys,
          'event',
          event.id,
          ownerIdsBySubprofileId.get(link.persona.id) ?? [],
        )
      ) {
        continue;
      }
      linkedEventByItemId.set(link.itemId, toFlashDayEventRef(event));
    }
    return linkedEventByItemId;
  }

  // The event half of `listOptions`. Every candidate lookup is keyed by the
  // requester: `events.host_id`, `event_cohosts.user_id` and
  // `event_rsvps.user_id` are indexed, and `event_lineup_entries` has no
  // `user_id` index but is a small table. The ids are unioned in memory, then
  // ONE events query applies the status, visibility and block filters, the
  // ordering and the cap.
  //
  // The defaults are the "Part of" picker. The flash day picker passes
  // `shouldCountGoingRsvps: false`, which skips the RSVP lookup, and
  // `shouldRequirePublicVisibility: true`, which keeps `public` events only.
  private async listEventOptionRows(
    requesterId: string,
    personaUserId: string,
    options: {
      shouldCountGoingRsvps: boolean;
      shouldRequirePublicVisibility: boolean;
    } = { shouldCountGoingRsvps: true, shouldRequirePublicVisibility: false },
  ): Promise<Event[]> {
    const [hostedEventRows, cohostRows, lineupRows, goingRsvpRows] =
      await Promise.all([
        this.events.find({
          where: { hostId: requesterId },
          select: { id: true },
        }),
        this.eventCohosts.find({
          where: { userId: requesterId },
          select: { eventId: true },
        }),
        this.eventLineupEntries.find({
          where: {
            userId: requesterId,
            status: EventLineupEntryStatus.Accepted,
          },
          select: { eventId: true },
        }),
        options.shouldCountGoingRsvps
          ? this.eventRsvps.find({
              where: { userId: requesterId, status: RsvpStatus.Going },
              select: { eventId: true },
            })
          : Promise.resolve([]),
      ]);
    const candidateEventIds = [
      ...new Set([
        ...hostedEventRows.map((event) => event.id),
        ...[...cohostRows, ...lineupRows, ...goingRsvpRows].map(
          (eventRow) => eventRow.eventId,
        ),
      ]),
    ];
    if (!candidateEventIds.length) {
      return [];
    }

    const eventQuery = this.events
      .createQueryBuilder('event')
      .where('event.id IN (:...candidateEventIds)', { candidateEventIds })
      .andWhere('event.status = :published', {
        published: EventStatus.Published,
      });
    if (options.shouldRequirePublicVisibility) {
      eventQuery.andWhere('event.visibility = :public', {
        public: EventVisibility.Public,
      });
    } else {
      eventQuery.andWhere('event.visibility != :inviteOnly', {
        inviteOnly: EventVisibility.InviteOnly,
      });
    }
    this.blockFilter.excludeBlocked(
      eventQuery,
      personaUserId,
      '"event"."host_id"',
    );
    this.excludeBlockedWithRequester(
      eventQuery,
      requesterId,
      personaUserId,
      '"event"."host_id"',
    );
    // Upcoming events first (false sorts before true), soonest first, then
    // past events newest first. `now()` is fixed for the whole statement, so
    // the two groups split cleanly.
    return eventQuery
      .orderBy('("event"."start_at" < now())', 'ASC')
      .addOrderBy(
        'CASE WHEN "event"."start_at" >= now() THEN "event"."start_at" END',
        'ASC',
      )
      .addOrderBy('"event"."start_at"', 'DESC')
      .take(MAX_AFFILIATION_OPTIONS_PER_TYPE)
      .getMany();
  }

  // `BlockFilterService.excludeBlocked` binds a fixed parameter name, so it
  // runs once per query builder and there covers `personaUserId`. This adds
  // the same either-way `NOT EXISTS` against the requester under its own
  // parameter name. It is skipped when the requester is the persona's
  // `userId`, whose check is already in place. A null owner column passes,
  // as it does in `excludeBlocked`.
  private excludeBlockedWithRequester<Entity extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<Entity>,
    requesterId: string,
    personaUserId: string,
    ownerIdColumn: string,
  ): void {
    if (requesterId === personaUserId) {
      return;
    }
    queryBuilder.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "blocks" "requesterBlock"
        WHERE ("requesterBlock"."blocker_id" = :requesterBlockUserId AND "requesterBlock"."blocked_id" = ${ownerIdColumn})
           OR ("requesterBlock"."blocked_id" = :requesterBlockUserId AND "requesterBlock"."blocker_id" = ${ownerIdColumn})
      )`,
      { requesterBlockUserId: requesterId },
    );
  }
}
