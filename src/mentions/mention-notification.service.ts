import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { extractMentions } from '../common/mentions';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { isGatedTier } from '../communities/community-gate';
import { COMMUNITY_MODERATION_SUBJECT_TYPE } from '../communities/community-read-gate';
import { isCommunityStaffRole } from '../communities/community-staff-access';
import { resolveEffectiveRole } from '../communities/subcommunity-rules';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Listing } from '../listings/entities/listing.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { seatExcludedFromMailboxPredicate } from '../messaging/mailbox-seats';
import {
  isMatchedChatMemberKey,
  resolveMatchedChatMemberKeys,
} from '../messaging/matched-member-key';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';

type EntityKind = 'member' | 'community' | 'business' | 'event' | 'thread';

// One entity bucket of a mention fan-out: who a single `@`, `c/`, `b/`, `e/`
// or `t/` reference would notify.
interface MentionGroup {
  kind: EntityKind;
  ref: string;
  recipients: string[];
}

// `forum_thread.review_state` value a reviewer approved. NULL (never
// submitted) is the other visible state.
const REVIEW_STATE_APPROVED = 'approved';

// Platform staff: the roles the forum lets past a thread's publish gate and
// community gate (`getBySlug` with `includeUnpublished` and
// `bypassCommunityAccess`). The same pair `isModeratorRole` checks in
// `forum-threads.service.ts`, restated here for the module-cycle reason
// `threadPassesPublishGate` documents below.
const PLATFORM_STAFF_ROLES = [UserRole.Moderator, UserRole.Admin];

/**
 * The forum's member-facing publish gate for one loaded thread: published at
 * or before now, and either never submitted for review or approved.
 *
 * A hand mirror of `isThreadPublished` in `forum-threads.service.ts`. That
 * file imports `MentionNotificationService`, so importing it back here closes
 * a module cycle: whichever of the two loads first sees the other half-built,
 * and `ForumThreadsService`'s decorator metadata can then record an undefined
 * constructor parameter, which fails Nest's dependency resolution at boot.
 * `mention-notification.source-audience.spec.ts` pins this mirror to the real
 * function case by case, so the two cannot drift silently.
 */
export function threadPassesPublishGate(
  thread: Pick<ForumThread, 'publishedAt' | 'reviewState'>,
): boolean {
  const reviewState = thread.reviewState ?? null;
  return (
    thread.publishedAt.getTime() <= Date.now() &&
    (reviewState === null || reviewState === REVIEW_STATE_APPROVED)
  );
}

/**
 * Can every signed-in member read this forum thread, whatever their roster
 * standing? The forum's own ENG-418 answer (`isThreadForumWide`): a thread in
 * no community, a cross-posted thread (PRD-407, the author carried it to the
 * whole forum), or a thread in a top-level, live, `public` community. A space
 * never counts, even a public one, and neither does an archived community:
 * their threads reach a reader through that reader's standing in them.
 *
 * `community` is the thread's own community row. A global or cross-posted
 * thread answers true without one, so callers pass `undefined` to ask that
 * cheaper question before loading it. For any other community thread,
 * `undefined` (not loaded, or not found) answers false, the privacy-safe
 * reading.
 */
export function isThreadOpenToEveryMember(
  thread: Pick<ForumThread, 'communityId' | 'crossPosted'>,
  community:
    Pick<Community, 'accessTier' | 'parentId' | 'archivedAt'> | undefined,
): boolean {
  if (thread.communityId === null || thread.crossPosted) return true;
  if (!community) return false;
  return (
    !isGatedTier(community.accessTier) &&
    !community.parentId &&
    !community.archivedAt
  );
}

/**
 * Does this member hold a role that opens a gated community's interior? The
 * communities module's own effective-role rule (`resolveEffectiveRole`): at
 * top level, any roster row; inside a space, a space roster row that still
 * sits under a parent roster row, or staff standing in the parent. Exactly the
 * readers the forum's `isCommunityHiddenFrom` and a community board's
 * `assertViewable` admit past a gated tier.
 */
export function holdsEffectiveCommunityRole(
  community: Pick<Community, 'id' | 'parentId'>,
  roleByCommunityId: ReadonlyMap<string, RosterRole>,
): boolean {
  if (!community.parentId) return roleByCommunityId.has(community.id);
  return (
    resolveEffectiveRole({
      isSpace: true,
      ownRole: roleByCommunityId.get(community.id) ?? null,
      parentRole: roleByCommunityId.get(community.parentId) ?? null,
    }) !== null
  );
}

/**
 * The role this member effectively holds in `community`, or null for none.
 * The same rule `holdsEffectiveCommunityRole` answers yes or no to: at top
 * level, their own roster role; inside a space, `resolveEffectiveRole` over
 * the space seat and the parent seat, so parent staff count as space staff.
 */
export function effectiveCommunityRole(
  community: Pick<Community, 'id' | 'parentId'>,
  roleByCommunityId: ReadonlyMap<string, RosterRole>,
): RosterRole | null {
  if (!community.parentId) return roleByCommunityId.get(community.id) ?? null;
  return resolveEffectiveRole({
    isSpace: true,
    ownRole: roleByCommunityId.get(community.id) ?? null,
    parentRole: roleByCommunityId.get(community.parentId) ?? null,
  });
}

@Injectable()
export class MentionNotificationService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
    @InjectRepository(ConversationParticipant)
    private readonly conversationParticipants: Repository<ConversationParticipant>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly blockFilter: BlockFilterService,
    private readonly contentModeration: ContentModerationService,
  ) {}

  /**
   * Best-effort mention fan-out across every entity kind. One notification per
   * recipient per post — member > community > business > event > thread
   * priority, author always dropped. Never throws: a mention side effect must
   * not fail a write.
   *
   * Returns the set of `userId`s an actual notification row was created for
   * (accumulated from `NotificationsService.createForRecipients`'s own
   * post-filter return), so a caller that's about to fire a *different*
   * notification for the same event — e.g. `ForumPostsService.reply`'s
   * reply-to-parent-author notification — can skip a recipient who already
   * got one here, instead of double-notifying them. Declared outside the
   * `try` so a mid-loop failure still returns whatever was actually notified
   * before the error, rather than silently discarding it.
   *
   * `excludeUserIds` (PRD-221): additional ids to drop, same treatment as the
   * author — never a recipient, and never counted in `notifiedUserIds`.
   * `MessagesService.sendMessage` passes a 1:1 DM's own counterpart here,
   * since mentioning the one person a direct message could possibly be to is
   * always the same fact the message's own delivery already told them; a
   * GROUP mention passes none (see that call site's own comment for why the
   * two cases differ). Default `[]` — every other `notify()` caller
   * (community posts, forum threads) is unaffected.
   */
  async notify(
    body: string,
    authorUserId: string,
    payloadBase: Record<string, unknown>,
    excludeUserIds: string[] = [],
  ): Promise<Set<string>> {
    const notifiedUserIds = new Set<string>();
    try {
      const mentions = extractMentions(body);
      const groups: MentionGroup[] = [];

      if (mentions.members.length) {
        // PRD-423: a matched Go together chat mentions its members by key
        // alone. A slug typed there notifies nobody, so a guessed slug can
        // never be tested against the chat's roster.
        const isGoTogetherMessage =
          payloadBase.source === 'message' &&
          payloadBase.isGoTogetherChat === true;
        const bySlug = isGoTogetherMessage
          ? new Map<string, string>()
          : await new MemberLookup(this.profiles).userIdsForSlugs(
              mentions.members,
            );
        // Source restriction (community roster, forum thread audience or
        // conversation participants) runs once over every group below, in
        // `restrictGroupsToSource`.
        for (const [slug, userId] of bySlug) {
          groups.push({ kind: 'member', ref: slug, recipients: [userId] });
        }
        // PRD-423 (opaque member keys): in a matched Go together chat the
        // `@` picker stores a member's per-chat key, resolved here among the
        // chat's own seats. The source restriction below still holds every
        // recipient to the chat's current participants.
        for (const [
          memberKey,
          userId,
        ] of await this.matchedChatMemberKeyUserIds(
          payloadBase,
          mentions.members,
        )) {
          groups.push({
            kind: 'member',
            ref: memberKey,
            recipients: [userId],
          });
        }
      }
      if (mentions.communities.length) {
        const communityRows = await this.communities.find({
          where: { slug: In(mentions.communities) },
        });
        const communityBySlug = new Map(
          communityRows.map((community) => [community.slug, community]),
        );
        const staffRows = communityRows.length
          ? await this.members.find({
              where: {
                communityId: In(communityRows.map((community) => community.id)),
                role: In([RosterRole.Owner, RosterRole.Mod]),
              },
            })
          : [];
        const staffByCommunityId = new Map<string, string[]>();
        for (const staff of staffRows) {
          const userIds = staffByCommunityId.get(staff.communityId) ?? [];
          userIds.push(staff.userId);
          staffByCommunityId.set(staff.communityId, userIds);
        }
        // Iterate in mention order (not DB order) so cross-mention priority
        // stays deterministic.
        for (const slug of mentions.communities) {
          const community = communityBySlug.get(slug);
          if (!community) continue;
          // `ownerId` is null while the community is temporarily ownerless
          // (owner account erased, pending mod-promotion/reassignment) — the
          // mod recipients from `staffByCommunityId` still carry the group.
          const recipients = Array.from(
            new Set(
              [
                community.ownerId,
                ...(staffByCommunityId.get(community.id) ?? []),
              ].filter((userId): userId is string => userId !== null),
            ),
          );
          groups.push({ kind: 'community', ref: slug, recipients });
        }
      }
      if (mentions.businesses.length) {
        const listingRows = await this.listings.find({
          where: { slug: In(mentions.businesses) },
        });
        const ownerBySlug = new Map(
          listingRows.map((listing) => [listing.slug, listing.ownerId]),
        );
        for (const slug of mentions.businesses) {
          // `undefined` = no such listing; `null` = its owner erased their
          // account (`SetNullContentAuthorFksOnUserErasure1794610000000`).
          // Either way there is nobody to notify about the mention.
          const ownerId = ownerBySlug.get(slug);
          if (ownerId === undefined || ownerId === null) continue;
          groups.push({ kind: 'business', ref: slug, recipients: [ownerId] });
        }
      }
      if (mentions.events.length) {
        const eventRows = await this.events.find({
          where: { slug: In(mentions.events) },
        });
        const hostBySlug = new Map(
          eventRows.map((event) => [event.slug, event.hostId]),
        );
        for (const slug of mentions.events) {
          const hostId = hostBySlug.get(slug);
          if (hostId === undefined || hostId === null) continue;
          groups.push({ kind: 'event', ref: slug, recipients: [hostId] });
        }
      }
      if (mentions.threads.length) {
        const threadRows = await this.threads.find({
          where: { slug: In(mentions.threads) },
        });
        const authorBySlug = new Map(
          threadRows.map((thread) => [thread.slug, thread.authorId]),
        );
        for (const slug of mentions.threads) {
          const authorId = authorBySlug.get(slug);
          if (authorId === undefined || authorId === null) continue;
          groups.push({ kind: 'thread', ref: slug, recipients: [authorId] });
        }
      }

      // ENG-400: filtered BEFORE the priority claim below, so a recipient
      // dropped from one group can still be reached through a later group the
      // source allows them in.
      const allowedGroups = await this.restrictGroupsToSource(
        payloadBase,
        groups,
      );

      // One notification per recipient per post: the first (highest-priority)
      // group that names a user wins; the author is never notified, and
      // neither is anyone in `excludeUserIds` (PRD-221's DM-counterpart case).
      const claimed = new Set<string>([authorUserId, ...excludeUserIds]);
      for (const group of allowedGroups) {
        const recipients = group.recipients.filter(
          (userId) => !!userId && !claimed.has(userId),
        );
        if (!recipients.length) continue;
        recipients.forEach((userId) => claimed.add(userId));
        const notified = await this.notifications.createForRecipients(
          recipients,
          NotificationType.Mention,
          { ...payloadBase, entityKind: group.kind, entityRef: group.ref },
          authorUserId,
        );
        notified.forEach((userId) => notifiedUserIds.add(userId));
      }
    } catch {
      // Intentionally ignored — mention notifications are best-effort.
    }
    return notifiedUserIds;
  }

  /**
   * Best-effort "someone replied to your comment" notification, fired when a
   * forum reply nests under another post (`ForumPost.parentPostId`).
   *
   * Uses its own `NotificationType.ForumReply` — distinct from `Mention` —
   * so the parent author reads "replied to your comment" rather than
   * "mentioned you in a discussion". Carries the same payload shape `notify()`
   * writes for a forum `@mention` (`actorId`/`source`/`threadSlug`/`postId`/
   * `excerpt`), plus `parentPostId`; `ACTOR_PAYLOAD_KEY` resolves `actorId` for
   * this type the same way it does for `Mention`.
   *
   * Skips self-replies (replying to your own comment) and — mirroring
   * `notify()` — never throws: a failure to enqueue this notification must
   * not fail the reply it's attached to.
   *
   * Held to the same source audience as a mention (`recipientsAllowedForSource`),
   * since the row carries the same `excerpt`: a parent author who has since
   * lost read access to the thread (left its gated community, blocked with
   * its author, or it went back into review) is told nothing.
   */
  async notifyParentReply(
    parentAuthorUserId: string,
    replyAuthorUserId: string,
    payloadBase: Record<string, unknown>,
  ): Promise<void> {
    if (parentAuthorUserId === replyAuthorUserId) {
      return;
    }
    try {
      if (!(await this.isAllowedForSource(payloadBase, parentAuthorUserId))) {
        return;
      }
      await this.notifications.create(
        parentAuthorUserId,
        NotificationType.ForumReply,
        payloadBase,
        replyAuthorUserId,
      );
    } catch {
      // Intentionally ignored — best-effort, same as `notify()` above.
    }
  }

  /**
   * Best-effort "someone replied to your thread" notification, for a *top-level*
   * forum reply (no `parentPostId`) — the thread's original author. Distinct
   * from `notifyParentReply` (a reply nested under a specific comment) and from
   * `Mention` (an `@`-tag). Skips self-replies and never throws.
   *
   * The caller passes the set of user ids `notify()` already created a mention
   * for so a thread author who was also `@`-mentioned in the same reply isn't
   * notified twice — mirrors `ForumPostsService.reply`'s parent-reply guard.
   *
   * Held to the thread's audience like `notifyParentReply`. A caller that has
   * already narrowed its recipients with `forumThreadAudience` (the follower
   * fan-out, up to 500 ids in one batched read) passes
   * `isAudienceChecked: true` so the per-recipient read is not repeated.
   */
  async notifyThreadReply(
    threadAuthorUserId: string,
    replyAuthorUserId: string,
    payloadBase: Record<string, unknown>,
    options: { isAudienceChecked?: boolean } = {},
  ): Promise<void> {
    if (threadAuthorUserId === replyAuthorUserId) {
      return;
    }
    try {
      if (
        !options.isAudienceChecked &&
        !(await this.isAllowedForSource(payloadBase, threadAuthorUserId))
      ) {
        return;
      }
      await this.notifications.create(
        threadAuthorUserId,
        NotificationType.ForumThreadReply,
        payloadBase,
        replyAuthorUserId,
      );
    } catch {
      // Intentionally ignored — best-effort, same as `notify()` above.
    }
  }

  /**
   * Best-effort "someone replied to your post" notification for a community
   * post's author, fired on every community reply (nested or flat). Distinct
   * from `Mention`; skips self-replies and never throws. Same de-dupe contract
   * as `notifyThreadReply` — the caller drops an author already `@`-mentioned.
   * Held to the board's audience like `notifyParentReply`: a post author who
   * left a gated community is told nothing about replies written after, and
   * one who is not its staff hears nothing from a community a moderator took
   * down.
   */
  async notifyPostReply(
    postAuthorUserId: string,
    replyAuthorUserId: string,
    payloadBase: Record<string, unknown>,
  ): Promise<void> {
    if (postAuthorUserId === replyAuthorUserId) {
      return;
    }
    try {
      if (!(await this.isAllowedForSource(payloadBase, postAuthorUserId))) {
        return;
      }
      await this.notifications.create(
        postAuthorUserId,
        NotificationType.CommunityReply,
        payloadBase,
        replyAuthorUserId,
      );
    } catch {
      // Intentionally ignored — best-effort, same as `notify()` above.
    }
  }

  /**
   * Who of `candidateUserIds` may be told about activity in the forum thread
   * `threadSlug`: the same audience a forum mention is held to
   * (`forumThreadReaders`). One batched read for the whole set, for a caller
   * fanning one reply out to many recipients (`ForumPostsService`'s follower
   * notifications). Never throws: a failed read answers the empty set, so a
   * fan-out that cannot state its audience notifies nobody.
   */
  async forumThreadAudience(
    threadSlug: string,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    if (!candidateUserIds.length) {
      return new Set();
    }
    try {
      return await this.forumThreadReaders(threadSlug, candidateUserIds);
    } catch {
      return new Set();
    }
  }

  /**
   * Can this one recipient read the place `payloadBase` names? The
   * single-recipient form of `recipientsAllowedForSource`, for the reply
   * notifications above. Callers run it inside their own `try`, so a failed
   * read skips the notification.
   */
  private async isAllowedForSource(
    payloadBase: Record<string, unknown>,
    recipientUserId: string,
  ): Promise<boolean> {
    const allowedUserIds = await this.recipientsAllowedForSource(payloadBase, [
      recipientUserId,
    ]);
    return allowedUserIds.has(recipientUserId);
  }

  /**
   * ENG-400: `groups` with every group's recipients narrowed to
   * `recipientsAllowedForSource`, whatever the entity kind.
   *
   * Every bucket is held to the source's readers because every bucket
   * receives the same 140-char `excerpt` a member mention carries: the
   * community owner and mods behind `c/slug`, the host behind `e/slug`, the
   * listing owner behind `b/slug` and the thread author behind `t/slug` would
   * otherwise read words written inside a DM, a gated community or a gated
   * forum thread they have no seat in. The mention still renders as a link
   * where it was written; it notifies only people who can open that place.
   * A source everyone can read (a public community, a forum-wide thread, a
   * global post) lets every candidate through, so this costs those sources
   * nothing.
   *
   * One `recipientsAllowedForSource` call covers every recipient of every
   * group, so each source's audience is read once per fan-out.
   */
  private async restrictGroupsToSource(
    payloadBase: Record<string, unknown>,
    groups: MentionGroup[],
  ): Promise<MentionGroup[]> {
    const candidateUserIds = Array.from(
      new Set(
        groups
          .flatMap((group) => group.recipients)
          .filter((userId) => !!userId),
      ),
    );
    if (!candidateUserIds.length) {
      return groups;
    }
    const allowedUserIds = await this.recipientsAllowedForSource(
      payloadBase,
      candidateUserIds,
    );
    return groups.map((group) => ({
      ...group,
      recipients: group.recipients.filter((userId) =>
        allowedUserIds.has(userId),
      ),
    }));
  }

  /**
   * PRD-423 (opaque member keys): the user behind each per-chat member key
   * among `mentionRefs`, for a mention written inside a matched Go together
   * chat (`payloadBase.isGoTogetherChat`, set by `MessagesService` on such a
   * send). Every seat of the conversation is a candidate; the source
   * restriction narrows that to its current participants afterwards. Empty
   * for any other source, so a key-shaped ref elsewhere names nobody.
   */
  private async matchedChatMemberKeyUserIds(
    payloadBase: Record<string, unknown>,
    mentionRefs: string[],
  ): Promise<Map<string, string>> {
    const conversationId = payloadBase.conversationId;
    if (
      payloadBase.source !== 'message' ||
      payloadBase.isGoTogetherChat !== true ||
      typeof conversationId !== 'string' ||
      !conversationId ||
      !mentionRefs.some((ref) => isMatchedChatMemberKey(ref))
    ) {
      return new Map();
    }
    const seats = await this.conversationParticipants.find({
      where: { conversationId },
      select: { userId: true },
    });
    return resolveMatchedChatMemberKeys(
      conversationId,
      seats.map((seat) => seat.userId),
      mentionRefs,
    );
  }

  /**
   * The subset of `candidateUserIds` allowed to receive a mention, given where
   * it was written (`payloadBase.source` plus `communitySlug`, `threadSlug`
   * or `conversationId`). Each source is held to its own read gate:
   *
   * - `community`: a gated tier (request/invite/private) or an archived
   *   community admits its effective roster alone (`communityPostReaders`),
   *   because a mention `excerpt` carries gated-space content a non-member
   *   must never see (finding H3). A community a moderator hid or removed
   *   admits its effective staff alone (owner, co-owner, mod), whatever its
   *   tier, since its board 404s for everyone else. A live public community,
   *   or a global post with no community, lets every candidate through.
   * - `forum`: the thread's own publish gate, community audience and author
   *   blocks (`forumThreadReaders`). A scheduled or unreviewed thread reaches
   *   its author and platform staff alone; a gated community thread reaches
   *   its effective roster and platform staff unless its author cross-posted
   *   it; anyone blocked either way with the thread author is dropped.
   * - `message`: the conversation's current participants (below).
   * - Any other source: nobody. Only a `community` payload with no
   *   `communitySlug` (a global post) stays open to every candidate.
   *
   * A `message` source (a mention written inside a DM or group thread) is
   * restricted to that conversation's own participants, for every entity
   * kind. A DM is the most private space on the platform, so mentioning a
   * handle or an entity whose people are outside the conversation must notify
   * nobody: the notification alone would disclose that a private conversation
   * exists and names them, and the row persists a 140-char `excerpt` of
   * someone else's private message. This one FAILS CLOSED, unlike the
   * community branch below: an unresolvable conversation drops the mention.
   *
   * The community branch fails open on an unresolvable community slug: the
   * fan-out runs synchronously right after the post/reply is saved, so the
   * source community is present in practice; a miss means a data race we
   * can't classify, and dropping a public-community notification on that
   * basis would be worse than the (vanishingly rare) edge it guards. The
   * takedown read is the exception: a slug recorded as hidden or removed
   * admits nobody when its row is gone, and a failed read of that state
   * throws to the caller, which drops the notification. The
   * forum branch fails closed on an unresolvable thread, as the resolver
   * does: a thread carries its own publish gate, so a thread nobody can load
   * is a thread nobody can be shown to read.
   */
  private async recipientsAllowedForSource(
    payloadBase: Record<string, unknown>,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    if (!candidateUserIds.length) {
      return new Set();
    }
    const source = payloadBase.source;
    if (source === 'message') {
      const conversationId = payloadBase.conversationId;
      if (typeof conversationId !== 'string' || !conversationId) {
        return new Set();
      }
      // ENG-236: a member who left or was removed keeps their `leftAt`
      // watermark, but a mention posted after that must never reach them:
      // their read ceiling stops at `leftAt`, so a mention row/push carrying
      // an excerpt of a message they can't even see would leak talk about
      // them after their own exit onto their lock screen.
      const participants = await this.conversationParticipants.find({
        where: {
          conversationId,
          userId: In(candidateUserIds),
          leftAt: IsNull(),
        },
        select: { userId: true },
      });
      const participantUserIds = new Set(
        participants.map((participant) => participant.userId),
      );
      if (!participantUserIds.size) {
        return participantUserIds;
      }
      return this.dropExcludedMailboxSeats(conversationId, participantUserIds);
    }
    if (source === 'forum') {
      return this.forumThreadReaders(payloadBase.threadSlug, candidateUserIds);
    }
    if (source !== 'community') {
      // A source this check does not know has no audience it can state, so
      // it notifies nobody. A new caller adds its own branch above, with the
      // read gate of the place it writes into.
      return new Set();
    }
    const communitySlug = payloadBase.communitySlug;
    if (typeof communitySlug !== 'string' || !communitySlug) {
      // A global post (the flat feed) belongs to no community, and every
      // member reads it.
      return new Set(candidateUserIds);
    }
    return this.communityPostReaders(communitySlug, candidateUserIds);
  }

  /**
   * Who of `candidateUserIds` can read a post or reply on `communitySlug`'s
   * board. Mirrors the board's own gate (`CommunityPostsService.assertViewable`
   * with `assertCommunityInteriorReadable`'s takedown and archive closures):
   * a community a moderator hid or removed opens its interior to its
   * effective staff alone, a gated tier or an archived community opens it to
   * its effective roster alone, and a live public community opens it to
   * everyone. Fails open on an unresolvable slug unless that slug is taken
   * down; see `recipientsAllowedForSource`.
   *
   * The takedown state is read on every call, one query beside the
   * community's own. A read that throws propagates, so each caller's own
   * `try` drops the notification (fails closed).
   */
  private async communityPostReaders(
    communitySlug: string,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    const [community, moderation] = await Promise.all([
      this.communities.findOne({ where: { slug: communitySlug } }),
      this.contentModeration.stateFor(
        COMMUNITY_MODERATION_SUBJECT_TYPE,
        communitySlug,
      ),
    ]);
    if (moderation.hidden || moderation.removed) {
      return community
        ? this.effectiveStaffOf(community, candidateUserIds)
        : new Set();
    }
    if (
      !community ||
      (community.accessTier === AccessTier.Public && !community.archivedAt)
    ) {
      return new Set(candidateUserIds);
    }
    return this.effectiveRosterOf(community, candidateUserIds);
  }

  /**
   * Who of `candidateUserIds` can read the forum thread `threadSlug`, by the
   * forum's own gates. The forum's `assertVisibleOr404` runs publish, then
   * block, then community; this runs publish, then community, then block,
   * which admits the same readers since every gate only removes candidates:
   *
   * 1. The publish gate (`threadPassesPublishGate`). A scheduled thread, or
   *    one pending or refused in review, is readable by its author and
   *    platform staff alone, so a reply written in it notifies nobody else.
   * 2. The community audience (`isThreadOpenToEveryMember`). A thread in no
   *    community, a cross-posted one, or one in a top-level live public
   *    community reaches every member; any other community thread reaches
   *    that community's effective roster.
   * 3. The author block. Anyone blocked either way with the thread's author
   *    is dropped (`BlockFilterService.blockedUserIds`), platform staff
   *    included: the forum 404s the thread for that pair with no staff
   *    bypass. An erased author (ENG-494) blocks nobody.
   *
   * Platform staff (`PLATFORM_STAFF_ROLES`) pass gates 1 and 2, as they do
   * through `getBySlug`, which lets them read an unpublished thread and a
   * gated community's thread with no seat in it.
   *
   * Two queries for any candidate count (thread, then its community), plus
   * one roster read when the community is gated, one role read only when a
   * gate would otherwise drop somebody, and one block read when the thread
   * has an author and anybody is left.
   */
  private async forumThreadReaders(
    threadSlug: unknown,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    if (typeof threadSlug !== 'string' || !threadSlug) {
      return new Set();
    }
    const thread = await this.threads.findOne({
      where: { slug: threadSlug, deletedAt: IsNull() },
      select: {
        id: true,
        authorId: true,
        communityId: true,
        crossPosted: true,
        publishedAt: true,
        reviewState: true,
      },
    });
    if (!thread) {
      return new Set();
    }
    const gateReaders = await this.forumThreadGateReaders(
      thread,
      candidateUserIds,
    );
    if (!gateReaders.size || thread.authorId === null) {
      return gateReaders;
    }
    const blockedUserIds = await this.blockFilter.blockedUserIds(
      thread.authorId,
      [...gateReaders],
    );
    if (!blockedUserIds.size) {
      return gateReaders;
    }
    return new Set(
      [...gateReaders].filter((userId) => !blockedUserIds.has(userId)),
    );
  }

  /**
   * Gates 1 and 2 of `forumThreadReaders` for one loaded thread, with the
   * platform staff bypass. The staff role read covers every candidate at
   * once and runs at most one time, the first time a gate would drop
   * somebody.
   */
  private async forumThreadGateReaders(
    thread: Pick<
      ForumThread,
      'authorId' | 'communityId' | 'crossPosted' | 'publishedAt' | 'reviewState'
    >,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    let platformStaffUserIds: Set<string> | undefined;
    const loadPlatformStaff = async (): Promise<Set<string>> => {
      platformStaffUserIds ??= await this.platformStaffAmong(candidateUserIds);
      return platformStaffUserIds;
    };

    let publishGateReaders = candidateUserIds;
    if (!threadPassesPublishGate(thread)) {
      const hasNonAuthorCandidate = candidateUserIds.some(
        (userId) => userId !== thread.authorId,
      );
      const staffUserIds = hasNonAuthorCandidate
        ? await loadPlatformStaff()
        : new Set<string>();
      publishGateReaders = candidateUserIds.filter(
        (userId) => userId === thread.authorId || staffUserIds.has(userId),
      );
    }
    if (!publishGateReaders.length) {
      return new Set();
    }
    // A thread in no community, or a cross-posted one, needs no community
    // row to answer; the call below reads one only for the rest.
    if (isThreadOpenToEveryMember(thread, undefined)) {
      return new Set(publishGateReaders);
    }
    const community = thread.communityId
      ? await this.communities.findOne({ where: { id: thread.communityId } })
      : null;
    if (!community) {
      return new Set();
    }
    if (isThreadOpenToEveryMember(thread, community)) {
      return new Set(publishGateReaders);
    }
    const rosterReaders = await this.effectiveRosterOf(
      community,
      publishGateReaders,
    );
    if (rosterReaders.size === publishGateReaders.length) {
      return rosterReaders;
    }
    const staffUserIds = await loadPlatformStaff();
    return new Set(
      publishGateReaders.filter(
        (userId) => rosterReaders.has(userId) || staffUserIds.has(userId),
      ),
    );
  }

  /**
   * The subset of `candidateUserIds` whose account holds a platform staff
   * role (`PLATFORM_STAFF_ROLES`). One read for the whole set.
   */
  private async platformStaffAmong(
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    const staffRows = await this.users.find({
      where: { id: In(candidateUserIds), role: In(PLATFORM_STAFF_ROLES) },
      select: { id: true },
    });
    return new Set(staffRows.map((staffRow) => staffRow.id));
  }

  /**
   * The subset of `candidateUserIds` holding an effective role in `community`
   * (`holdsEffectiveCommunityRole`). One roster read for the whole set: the
   * community's own rows, plus the parent's rows when it is a space, since a
   * space seat counts only under a parent seat and parent staff read every
   * space with no space seat.
   */
  private async effectiveRosterOf(
    community: Pick<Community, 'id' | 'parentId'>,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    const rolesByUserId = await this.rosterRolesByUserId(
      community,
      candidateUserIds,
    );
    return new Set(
      candidateUserIds.filter((userId) => {
        const roleByCommunityId = rolesByUserId.get(userId);
        return (
          !!roleByCommunityId &&
          holdsEffectiveCommunityRole(community, roleByCommunityId)
        );
      }),
    );
  }

  /**
   * The subset of `candidateUserIds` whose effective role in `community`
   * (`effectiveCommunityRole`) is a staff role: owner, co-owner or mod, own
   * or inherited from parent staff on a space. The readers
   * `assertCommunityInteriorReadable` keeps on a taken-down community. The
   * same single roster read as `effectiveRosterOf`.
   */
  private async effectiveStaffOf(
    community: Pick<Community, 'id' | 'parentId'>,
    candidateUserIds: string[],
  ): Promise<Set<string>> {
    const rolesByUserId = await this.rosterRolesByUserId(
      community,
      candidateUserIds,
    );
    return new Set(
      candidateUserIds.filter((userId) => {
        const roleByCommunityId = rolesByUserId.get(userId);
        if (!roleByCommunityId) return false;
        const effectiveRole = effectiveCommunityRole(
          community,
          roleByCommunityId,
        );
        return effectiveRole !== null && isCommunityStaffRole(effectiveRole);
      }),
    );
  }

  /**
   * Each candidate's roster roles keyed by community id, from one read: the
   * community's own rows, plus the parent's rows when it is a space. A
   * candidate with no row in either is absent.
   */
  private async rosterRolesByUserId(
    community: Pick<Community, 'id' | 'parentId'>,
    candidateUserIds: string[],
  ): Promise<Map<string, Map<string, RosterRole>>> {
    const parentId = community.parentId ?? null;
    const memberships = await this.members.find({
      where: {
        communityId: parentId ? In([community.id, parentId]) : community.id,
        userId: In(candidateUserIds),
      },
      select: { userId: true, communityId: true, role: true },
    });
    const rolesByUserId = new Map<string, Map<string, RosterRole>>();
    for (const membership of memberships) {
      const roleByCommunityId =
        rolesByUserId.get(membership.userId) ?? new Map<string, RosterRole>();
      roleByCommunityId.set(membership.communityId, membership.role);
      rolesByUserId.set(membership.userId, roleByCommunityId);
    }
    return rolesByUserId;
  }

  /**
   * Task 13f: `candidateUserIds` with every staff seat the asymmetric block
   * rule (`mailbox-seats.ts`) evicts from `conversationId` removed. A `@`
   * mention written inside a mailbox thread still resolves a colleague's own
   * personal handle to their live participant row, so without this a staff
   * member blocked either way with the thread's customer kept receiving a
   * mention notification (and its excerpt of the customer's thread) after
   * every other surface had already stopped showing them that thread. A
   * person block never excludes the customer's own row, so under it the
   * customer and every unblocked colleague pass through unchanged. Reuses
   * the exact SQL predicate every other read composes, keeping the rule in
   * that one place. Task 14a: that predicate also carries the
   * departed-staff rule, which the `leftAt: IsNull()` filter above already
   * applies to this path. Task 14: read through
   * `seatExcludedFromMailboxPredicate`, which also drops the customer and
   * every staff member of a thread whose customer blocked the business, so
   * the function is named for seats of either side.
   */
  private async dropExcludedMailboxSeats(
    conversationId: string,
    candidateUserIds: ReadonlySet<string>,
  ): Promise<Set<string>> {
    const excludedRows = await this.conversationParticipants
      .createQueryBuilder('participant')
      .select('participant.user_id', 'userId')
      .where('participant.conversation_id = :conversationId', {
        conversationId,
      })
      .andWhere('participant.user_id IN (:...candidateUserIds)', {
        candidateUserIds: [...candidateUserIds],
      })
      .andWhere(
        seatExcludedFromMailboxPredicate(
          'participant.conversation_id',
          'participant.user_id',
        ),
      )
      .getRawMany<{ userId: string }>();
    const excludedUserIds = new Set(excludedRows.map((row) => row.userId));
    if (!excludedUserIds.size) {
      return new Set(candidateUserIds);
    }
    return new Set(
      [...candidateUserIds].filter((userId) => !excludedUserIds.has(userId)),
    );
  }
}
