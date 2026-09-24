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
import { EventLineupEntry } from '../events/entities/event-lineup-entry.entity';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Subprofile } from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
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

// "Part of" links are a persona's claim to belong somewhere, so a link may only
// be saved or shown while at least one of the persona's owners actually does:
//
//   community: a `community_members` row, any roster role.
//   event:     going. The host, a co-host, a lineup entry, or an RSVP whose
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
  // co-hosts, lineup entries, going RSVPs), whatever the number of owners or
  // targets. Check a persona with `hasQualifyingOwner`.
  async eligibleTargetKeys(
    ownerIds: string[],
    eventRows: Pick<Event, 'id' | 'hostId'>[],
    communityIds: string[],
  ): Promise<Set<string>> {
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
              where: { eventId: In(eventIds), userId: In(distinctOwnerIds) },
              select: { eventId: true, userId: true },
            })
          : Promise.resolve([]),
        eventIds.length
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
  // (host, co-host, lineup entry, going RSVP), unioned in memory, then ONE
  // events query over those ids. Every filter sits inside the final queries,
  // so the cap counts only options the picker can use. Communities come
  // alphabetically by name, then upcoming events soonest first, then past
  // events newest first.
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

  // The event half of `listOptions`. Every candidate lookup is keyed by the
  // requester: `events.host_id`, `event_cohosts.user_id` and
  // `event_rsvps.user_id` are indexed, and `event_lineup_entries` has no
  // `user_id` index but is a small table. The ids are unioned in memory, then
  // ONE events query applies the status, visibility and block filters, the
  // ordering and the cap.
  private async listEventOptionRows(
    requesterId: string,
    personaUserId: string,
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
          where: { userId: requesterId },
          select: { eventId: true },
        }),
        this.eventRsvps.find({
          where: { userId: requesterId, status: RsvpStatus.Going },
          select: { eventId: true },
        }),
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
      })
      .andWhere('event.visibility != :inviteOnly', {
        inviteOnly: EventVisibility.InviteOnly,
      });
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
