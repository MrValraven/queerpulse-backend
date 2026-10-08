import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import { Event, EventStatus } from '../events/entities/event.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventAudienceGateService } from '../events/event-audience-gate.service';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { isThreadPublished } from '../forum/forum-threads.service';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import {
  displayNameFor,
  FULL_MEMBER_NAMES,
  matchedChatMemberNames,
  memberNameOptionsFor,
} from '../messaging/message-response';
import { resolveMatchedChatMemberKeys } from '../messaging/matched-member-key';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import type { ResolvedMentionNameResponse } from './dto/resolved-mention-name.response';
import {
  MENTION_NAME_KINDS,
  type MentionNameKind,
} from './dto/resolve-mention-names.query';
import {
  EVENT_MODERATION_SUBJECT_TYPE,
  holdsEffectiveCommunityRole,
  isThreadOpenToEveryMember,
} from './mention-notification.service';

/**
 * Names the entities a body of text mentions, so a reader sees "Val Raven"
 * where the author typed `@val-raven`.
 *
 * Read-only and viewer-scoped. Every kind is filtered to what that viewer could
 * already reach by its own route, so this never becomes a side door onto a name
 * the platform otherwise withholds:
 *
 *  - `member`: active users only, mirroring `MemberLookup.userIdsForSlugs`
 *    (and `ProfilesService.searchMembers`), and only members the viewer could
 *    open by `GET /members/:slug`: a block either way, a member who hid their
 *    profile from the viewer, a live "Hide me for 24 hours" and a moderator
 *    takedown all leave the raw `@slug` (the gates of
 *    `ProfilesService.assertVisibleOrNotFound`, applied here as one batch).
 *    A `private` or `network` profile tier keeps its name, since that tier
 *    only chooses between the full and the limited card, and the limited card
 *    names the member. The viewer's own mention always resolves. A suspended
 *    or erased account keeps its raw `@slug`.
 *  - `community`: every tier except `private`, unless the viewer is on that
 *    private community's roster. Same predicate as `browseBaseQuery`'s
 *    `discover` filter, so a private community's existence stays unleaked.
 *  - `business`: `live` listings only; `review`/`question` are moderation
 *    states the public directory doesn't serve.
 *  - `event`: only a gathering the viewer could open by its page, under the
 *    gates of `EventsService.assertCanView`, applied here as one batch.
 *    `published` and `cancelled` only: a cancelled gathering's page stays
 *    reachable, while a draft names itself to no one. A moderator takedown
 *    names it to its organisers (host and co-hosts) alone. The audience tier
 *    (`invite_only`, `network`, `extended_network`, `community`) runs through
 *    `EventAudienceGateService.filterViewable`, so the tag of an invite-only
 *    or members-only gathering names it only to the people its page admits.
 *  - `thread`: not deleted, past the forum's publish gate
 *    (`isThreadPublished`: a scheduled thread, or one pending or refused in
 *    review, names itself to its author alone), and readable by the viewer
 *    under the same community audience the mention fan-out uses
 *    (`isThreadOpenToEveryMember`): a global or cross-posted thread, or one in
 *    a top-level live public community, is open to everyone; any other
 *    community thread names itself to that community's effective roster
 *    (`holdsEffectiveCommunityRole`), so a title written inside a gated
 *    community or a space stays gated content.
 *
 * Unresolvable refs are simply omitted: the client renders the raw
 * `sigil + slug` it already parsed, which is the pre-existing behaviour.
 *
 * PRD-423: given the id of a matched Go together chat the viewer holds a
 * seat in, that chat's members (current and former seats alike) resolve by
 * their per-chat member key (`matched-member-key.ts`) to their first names,
 * the spelling every other name inside the chat uses. A slug member mention
 * resolves to nothing there, so the chat answers no question about a slug.
 */
@Injectable()
export class MentionNameResolveService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    private readonly blockFilter: BlockFilterService,
    private readonly hiddenFrom: HiddenFromService,
    private readonly contentModeration: ContentModerationService,
    // Read-only: whether the viewer co-hosts a taken-down gathering, the one
    // organiser the event row alone cannot name.
    @InjectRepository(EventCohost)
    private readonly eventCohosts: Repository<EventCohost>,
    // Provided by `MentionsModule` itself (see its providers), so no import
    // of `EventsModule` and no module cycle.
    private readonly eventAudience: EventAudienceGateService,
  ) {}

  async resolve(
    viewerId: string,
    refs: string[],
    conversationId?: string,
  ): Promise<ResolvedMentionNameResponse[]> {
    const slugsByKind = groupSlugsByKind(refs);
    const memberSlugs = this.kindSlugs(slugsByKind, 'member');
    // PRD-423: read only when a member is mentioned at all. Read first: a
    // viewer seated in a matched Go together chat resolves member mentions
    // by per-chat key alone, and no slug lookup runs for them at all, so the
    // chat can never be used to test a guessed slug against its roster.
    const matchedChatUserIds =
      conversationId && memberSlugs.length
        ? await this.matchedChatUserIds(viewerId, conversationId)
        : new Set<string>();
    const isMatchedChatViewer = matchedChatUserIds.size > 0;

    // Five independent reads of the same committed snapshot: they go out
    // together in parallel. Each is skipped entirely when the text
    // mentioned nothing of that kind.
    const [memberRows, communityRows, listingRows, eventRows, threadRows] =
      await Promise.all([
        this.findBySlugs(isMatchedChatViewer ? [] : memberSlugs, (slugs) =>
          this.visibleMemberProfiles(viewerId, slugs),
        ),
        this.findBySlugs(this.kindSlugs(slugsByKind, 'community'), (slugs) =>
          this.communities.find({ where: { slug: In(slugs) } }),
        ),
        this.findBySlugs(this.kindSlugs(slugsByKind, 'business'), (slugs) =>
          this.listings.find({
            where: { slug: In(slugs), status: ListingStatus.Live },
          }),
        ),
        this.findBySlugs(this.kindSlugs(slugsByKind, 'event'), (slugs) =>
          this.viewableEvents(viewerId, slugs),
        ),
        this.findBySlugs(this.kindSlugs(slugsByKind, 'thread'), (slugs) =>
          this.threads.find({
            where: { slug: In(slugs), deletedAt: IsNull() },
          }),
        ),
      ]);

    // The forum's publish gate first, since it needs nothing but the row: a
    // scheduled thread, or one pending or refused in review, names itself to
    // its own author alone, exactly as `assertVisibleOr404` opens it.
    const publishedThreadRows = threadRows.filter(
      (thread) => isThreadPublished(thread) || thread.authorId === viewerId,
    );
    // A thread's community gate needs its community's tier, which the thread
    // row only points at by id, so those communities are read in this second
    // step, after the thread rows are in. A thread open to every member
    // without a community row (global, or cross-posted) reads none.
    const threadCommunityIds = publishedThreadRows
      .filter((thread) => !isThreadOpenToEveryMember(thread, undefined))
      .map((thread) => thread.communityId)
      .filter((id): id is string => id !== null);
    const threadCommunities = threadCommunityIds.length
      ? await this.communities.find({ where: { id: In(threadCommunityIds) } })
      : [];
    const communityById = new Map(
      [...communityRows, ...threadCommunities].map((community) => [
        community.id,
        community,
      ]),
    );
    // One roster lookup for both gates. A space's parent rides along, since a
    // space seat counts only under a parent seat and parent staff read every
    // space (`holdsEffectiveCommunityRole`).
    const threadParentIds = threadCommunities
      .map((community) => community.parentId)
      .filter((id): id is string => !!id);
    const viewerRoleByCommunityId = await this.rosterRolesOf(viewerId, [
      ...new Set([...communityById.keys(), ...threadParentIds]),
    ]);

    const named: ResolvedMentionNameResponse[] = [];
    // PRD-423 (opaque member keys): a member picked from a matched chat's `@`
    // picker is stored as their per-chat key. Resolved among that chat's own
    // seats alone, and only for a viewer who holds one, to the first name.
    if (conversationId && isMatchedChatViewer) {
      named.push(
        ...(await this.namedMatchedChatMemberKeys(
          conversationId,
          matchedChatUserIds,
          memberSlugs,
        )),
      );
    }
    // Only ever read outside a matched chat the viewer sits in (see above),
    // so every slug mention here spells the full name.
    for (const profile of memberRows) {
      const name = displayNameFor(profile, FULL_MEMBER_NAMES);
      if (name) named.push({ kind: 'member', slug: profile.slug, name });
    }
    for (const community of communityRows) {
      // Browse-visibility: every tier but `private`, plus a private community
      // the viewer is actually in.
      const isVisible =
        community.accessTier !== AccessTier.Private ||
        viewerRoleByCommunityId.has(community.id);
      if (isVisible && community.name) {
        named.push({
          kind: 'community',
          slug: community.slug,
          name: community.name,
        });
      }
    }
    for (const listing of listingRows) {
      if (listing.name) {
        named.push({
          kind: 'business',
          slug: listing.slug,
          name: listing.name,
        });
      }
    }
    for (const event of eventRows) {
      if (event.title) {
        named.push({ kind: 'event', slug: event.slug, name: event.title });
      }
    }
    for (const thread of publishedThreadRows) {
      if (!thread.title) continue;
      const community =
        thread.communityId !== null
          ? communityById.get(thread.communityId)
          : undefined;
      // Gated-content rule, stricter than the community's own name gate: a
      // title written inside a gated community or a space reaches its
      // effective roster only, unless its author cross-posted it. An
      // unresolvable community fails CLOSED (`isThreadOpenToEveryMember`
      // answers false and there is no roster to hold a seat in), since
      // nothing here is time-critical and the safe answer is to leave the raw
      // `t/slug` standing.
      const isVisible =
        isThreadOpenToEveryMember(thread, community) ||
        (!!community &&
          holdsEffectiveCommunityRole(community, viewerRoleByCommunityId));
      if (!isVisible) continue;
      named.push({ kind: 'thread', slug: thread.slug, name: thread.title });
    }
    return named;
  }

  /**
   * The active members behind `slugs` whom `viewerId` could open by slug:
   * blocks either way, a hide from the viewer, a live "Hide me for 24 hours"
   * and a moderator takedown each drop the member. The gates are the ones
   * `ProfilesService.applyMemberVisibilityGates` and `excludeTakenDownMembers`
   * apply, through the same services, so a name never reaches a viewer the
   * profile itself is withheld from. Two reads for the whole batch, plus the
   * takedown lookup; the viewer's own profile rides a second parallel read
   * and skips every gate, as the owner does on their own profile.
   */
  private async visibleMemberProfiles(
    viewerId: string,
    slugs: string[],
  ): Promise<Profile[]> {
    const gatedQuery = this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .where('p.slug IN (:...slugs)', { slugs })
      .andWhere('p.user_id <> :mentionViewerId', {
        mentionViewerId: viewerId,
      })
      .andWhere('(p.hidden_until IS NULL OR p.hidden_until <= now())');
    this.blockFilter.excludeBlocked(gatedQuery, viewerId, '"p"."user_id"');
    this.hiddenFrom.excludeHiddenFrom(gatedQuery, viewerId, '"p"."user_id"');
    const [otherProfiles, ownProfiles] = await Promise.all([
      gatedQuery.getMany(),
      this.profiles.find({ where: { userId: viewerId, slug: In(slugs) } }),
    ]);
    const takedownStates = otherProfiles.length
      ? await this.contentModeration.statesForAnyType(
          [MEMBER_SUBJECT_TYPE],
          otherProfiles.flatMap((profile) => [profile.slug, profile.userId]),
        )
      : new Map<string, { hidden: boolean; removed: boolean }>();
    const isTakenDown = (profile: Profile): boolean =>
      [profile.slug, profile.userId].some((subjectId) => {
        const state = takedownStates.get(subjectId);
        return !!state && (state.hidden || state.removed);
      });
    return [
      ...otherProfiles.filter((profile) => !isTakenDown(profile)),
      ...ownProfiles,
    ];
  }

  /**
   * The published or cancelled gatherings behind `slugs` that `viewerId`
   * could open by their page: the gates of `EventsService.assertCanView`,
   * applied to the whole batch. A moderator takedown keeps a gathering for
   * its organisers alone, and the audience tier goes through
   * `EventAudienceGateService.filterViewable` (organisers pass every tier
   * there). One event read, then the tier filter and the takedown lookup in
   * parallel, plus one co-host read only when a viewable gathering the
   * viewer does not host was taken down.
   */
  private async viewableEvents(
    viewerId: string,
    slugs: string[],
  ): Promise<Event[]> {
    const eventRows = await this.events.find({
      where: {
        slug: In(slugs),
        status: In([EventStatus.Published, EventStatus.Cancelled]),
      },
    });
    if (!eventRows.length) return [];
    const [audienceEvents, takedownStates] = await Promise.all([
      this.eventAudience.filterViewable(eventRows, viewerId),
      this.contentModeration.statesForAnyType(
        [EVENT_MODERATION_SUBJECT_TYPE],
        eventRows.map((event) => event.id),
      ),
    ]);
    const isTakenDown = (event: Event): boolean => {
      const state = takedownStates.get(event.id);
      return !!state && (state.hidden || state.removed);
    };
    const takenDownEventIdsToCheck = audienceEvents
      .filter((event) => isTakenDown(event) && event.hostId !== viewerId)
      .map((event) => event.id);
    const cohostRows = takenDownEventIdsToCheck.length
      ? await this.eventCohosts.find({
          where: { userId: viewerId, eventId: In(takenDownEventIdsToCheck) },
          select: { eventId: true },
        })
      : [];
    const cohostedEventIds = new Set(cohostRows.map((row) => row.eventId));
    return audienceEvents.filter(
      (event) =>
        !isTakenDown(event) ||
        event.hostId === viewerId ||
        cohostedEventIds.has(event.id),
    );
  }

  /**
   * PRD-423: the user ids of every seat in `conversationId` when it is a
   * matched Go together chat AND `viewerId` holds a seat in it (a former
   * member still reads its history, so a left seat counts). Empty otherwise,
   * so a caller naming a conversation they are not in learns nothing.
   */
  private async matchedChatUserIds(
    viewerId: string,
    conversationId: string,
  ): Promise<Set<string>> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
      select: { id: true, isGoTogetherChat: true, eventMatchGroupId: true },
    });
    if (!memberNameOptionsFor(conversation).isMatchedGroup) return new Set();
    const seats = await this.participants.find({
      where: { conversationId },
      select: { userId: true },
    });
    const seatUserIds = new Set(seats.map((seat) => seat.userId));
    return seatUserIds.has(viewerId) ? seatUserIds : new Set();
  }

  /**
   * PRD-423 (opaque member keys): the first names behind the member keys
   * among `memberRefs`, resolved against `seatUserIds` (the matched chat's
   * seats, already gated on the viewer holding one). Active accounts only,
   * the same rule a slug mention follows; a key naming nobody in the chat is
   * omitted and keeps its raw text.
   */
  private async namedMatchedChatMemberKeys(
    conversationId: string,
    seatUserIds: ReadonlySet<string>,
    memberRefs: string[],
  ): Promise<ResolvedMentionNameResponse[]> {
    const userIdByKey = resolveMatchedChatMemberKeys(
      conversationId,
      seatUserIds,
      memberRefs,
    );
    if (!userIdByKey.size) return [];
    const profiles = await this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .where('p.user_id IN (:...userIds)', {
        userIds: [...new Set(userIdByKey.values())],
      })
      .getMany();
    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    const named: ResolvedMentionNameResponse[] = [];
    for (const [memberKey, userId] of userIdByKey) {
      const profile = profileByUserId.get(userId);
      const name = profile
        ? displayNameFor(profile, matchedChatMemberNames(conversationId))
        : '';
      if (name) named.push({ kind: 'member', slug: memberKey, name });
    }
    return named;
  }

  /** Skips the read entirely when nothing of that kind was mentioned. */
  private async findBySlugs<T>(
    slugs: string[],
    read: (slugs: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    return slugs.length ? read(slugs) : [];
  }

  private kindSlugs(
    slugsByKind: Map<MentionNameKind, string[]>,
    kind: MentionNameKind,
  ): string[] {
    return slugsByKind.get(kind) ?? [];
  }

  /** The viewer's roster role in each of `communityIds` they hold a row in. */
  private async rosterRolesOf(
    viewerId: string,
    communityIds: string[],
  ): Promise<Map<string, RosterRole>> {
    if (!communityIds.length) return new Map();
    const memberships = await this.communityMembers.find({
      where: { userId: viewerId, communityId: In(communityIds) },
      select: { communityId: true, role: true },
    });
    return new Map(
      memberships.map((membership) => [
        membership.communityId,
        membership.role,
      ]),
    );
  }
}

/** The `content_moderation` subject type a member takedown is filed under
 *  (`ProfilesService.MEMBER_SUBJECT_TYPE`). */
const MEMBER_SUBJECT_TYPE = 'member';

/** `["member:ana", "member:bo", "event:pride"]` -> `{member: [ana, bo], …}`,
 *  de-duplicated. The query DTO has already rejected any ref that isn't a known
 *  `kind:slug`, so the split below cannot produce an unknown kind. */
function groupSlugsByKind(refs: string[]): Map<MentionNameKind, string[]> {
  const slugsByKind = new Map<MentionNameKind, string[]>();
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const separatorIndex = ref.indexOf(':');
    const kind = ref.slice(0, separatorIndex) as MentionNameKind;
    const slug = ref.slice(separatorIndex + 1);
    if (!MENTION_NAME_KINDS.includes(kind) || !slug) continue;
    const slugs = slugsByKind.get(kind) ?? [];
    slugs.push(slug);
    slugsByKind.set(kind, slugs);
  }
  return slugsByKind;
}
