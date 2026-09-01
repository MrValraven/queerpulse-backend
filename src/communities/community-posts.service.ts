import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import {
  COMMUNITY_POST_CREATED,
  CommunityPostCreatedEvent,
} from './community.events';
import { Event } from '../events/entities/event.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { StorageService } from '../storage/storage.service';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup, MemberRef } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  PAGE_SIZE,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  CommunityReportDTO,
  toCommunityReportDTO,
} from './community-report-response';
import {
  CommunityPostDTO,
  CommunityPostHistoryResponse,
  CommunityReplyDTO,
  CommunityReplyHistoryResponse,
  ReactionAggregate,
  toCommunityPost,
  toCommunityPostHistoryEntry,
  toCommunityReply,
  toCommunityReplyHistoryEntry,
} from './community-response';
import {
  CommunityMember,
  CommunityNotificationLevel,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostEdit } from './entities/community-post-edit.entity';
import {
  CommunityPostReaction,
  ReactionKey,
} from './entities/community-post-reaction.entity';
import { CommunityPostReplyEdit } from './entities/community-post-reply-edit.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost, PostKind } from './entities/community-post.entity';
import { AccessTier, Community } from './entities/community.entity';

export interface CreatePostInput {
  body: string;
  image?: string | null;
  kind?: PostKind;
}

/**
 * Roster-wide post notifications are a fan-out, so they are written in
 * batches: one `createForRecipients` call per chunk of recipients rather than
 * one insert per member. 500 is the chunk size (each chunk is a single
 * multi-row INSERT plus the two batched preference/block filters
 * `createForRecipients` already runs), and 5000 is the hard ceiling on how
 * many members one post may page in a single request. A roster larger than
 * the ceiling gets its first 5000 members in `joined_at` order notified and
 * the rest skipped: the alternative is an unbounded write on the request path,
 * and the fan-out is explicitly best-effort. Raise the ceiling only by moving
 * this off the request path entirely (a queue or a scheduled sweep).
 */
const POST_NOTIFY_CHUNK_SIZE = 500;
const POST_NOTIFY_MAX_RECIPIENTS = 5000;

/**
 * Which members hear about a post at all, by their own per-community
 * `notificationLevel`. `mentions` and `muted` are absent on purpose: a member
 * on `mentions` is still reached through `MentionNotificationService` (that
 * path is untouched by this fan-out), and `muted` means nothing from this
 * community.
 */
const LEVELS_WANTING_EVERY_POST: readonly CommunityNotificationLevel[] = [
  CommunityNotificationLevel.All,
];
const LEVELS_WANTING_ANNOUNCEMENTS: readonly CommunityNotificationLevel[] = [
  CommunityNotificationLevel.All,
  CommunityNotificationLevel.Announcements,
];

/** Input for the flat `POST /community-posts` alias (see `createFlatPost`). */
export interface CreateFlatPostInput {
  body: string;
  communitySlug?: string;
}

// `pinned` is deliberately the only field that maps to a moderator-only
// check (see `updatePost`) — `body`/`kind` stay author-only, per the spec's
// `PATCH posts/:id | author; pin ⇒ mod` guard column.
export type UpdatePostInput = Partial<CreatePostInput> & {
  pinned?: boolean;
};

/** Input for the flat `PATCH /community-posts/:id` alias — author-only,
 * body/kind/image only. Deliberately omits `pinned`: pinning has no meaning
 * without a community to pin *within* (see `CommunityPostsController`'s flat
 * routes doc comment). */
export type UpdateFlatPostInput = Partial<CreatePostInput>;

@Injectable()
export class CommunityPostsService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReaction)
    private readonly reactions: Repository<CommunityPostReaction>,
    @InjectRepository(CommunityPostReply)
    private readonly replies: Repository<CommunityPostReply>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly blockFilter: BlockFilterService,
    @InjectRepository(CommunityPostEdit)
    private readonly postEdits: Repository<CommunityPostEdit>,
    @InjectRepository(CommunityPostReplyEdit)
    private readonly replyEdits: Repository<CommunityPostReplyEdit>,
    // Read-only, for `listCommunityReports`'s owner/mod queue. Same
    // cross-module `forFeature` reuse `CommunityAutoFreezeService` already
    // does with this entity in this same module (`Report` is registered once
    // in `CommunitiesModule`, shared by both providers).
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    // Read-only, for the `event_photo` arm of that same queue (TS-13). A photo
    // report reaches a community moderator only through
    // `listCommunityReports`, and the row carries the caption, the uploader
    // and the album's own timestamp. `EventPhoto` is registered once in
    // `CommunitiesModule`, the same cross-module `forFeature` reuse `Report`
    // and `Event` already have there; `EventsModule` provides services and
    // never repositories.
    @InjectRepository(EventPhoto)
    private readonly eventPhotos: Repository<EventPhoto>,
    // Read-only, and only for the title a photo report's excerpt names its
    // gathering by.
    @InjectRepository(Event) private readonly events: Repository<Event>,
    private readonly mentions: MentionNotificationService,
    // Roster-wide fan-out on post creation (see `notifyRosterOfPost`). Batched
    // through `createForRecipients`, the same path
    // `CommunitiesService.notifyRosterArchived` uses.
    private readonly notifications: NotificationsService,
    private readonly contentModeration: ContentModerationService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private readonly logger = new Logger(CommunityPostsService.name);

  // A community post/reply can be taken down under either taxonomy code
  // (`post` / `reply`), keyed by the row's uuid — reads check both.
  private static readonly SUBJECT_TYPES = ['post', 'reply'];

  // The takedown codes the community moderation queue has to check, which is
  // the post/reply pair plus `event_photo` (TS-13). Kept apart from
  // `SUBJECT_TYPES` above so the post/reply FEEDS never widen: only the queue
  // ever holds a photo id, and every id in all three tables is a uuid from a
  // disjoint space, so the wider list can never let one table's takedown
  // answer for another's row.
  private static readonly REPORT_SUBJECT_TYPES = [
    'post',
    'reply',
    'event_photo',
  ];

  // Owner/co-owner/mod see moderated content (flagged); ordinary
  // members/non-members do not receive hidden content. `co_owner` is a role
  // the owner handed owner-level powers to inside the community (see
  // `RosterRole.CoOwner`), so every staff check in this file treats it exactly
  // as it treats `owner`.
  private static isStaffRole(viewerRole: RosterRole | null): boolean {
    return (
      viewerRole === RosterRole.Owner ||
      viewerRole === RosterRole.CoOwner ||
      viewerRole === RosterRole.Mod
    );
  }

  private static readonly VISIBLE: ContentModerationState = {
    hidden: false,
    removed: false,
  };

  /**
   * The "role" a flat (`/community-posts*`) mutation echo passes into
   * `buildPostDTO`/`mapReply` for its own acting author. A flat/global post
   * has no roster to hold a real `RosterRole` in, so this is a sentinel, not
   * a claim about community membership: it exists only so
   * `toCommunityPost`/`toCommunityReply`'s `isMember` gate doesn't blank out
   * `canEdit`/`canDelete`/`canRestore`/`canViewHistory` for the very author
   * who just performed the action (already verified via `assertAuthorOnly`
   * before any of these are called). `isOwnerOrMod(Member)` is false, so no
   * moderator-only capability can leak through this substitute — a non-author
   * viewer of the same DTO still gets `canManage: false` regardless, since
   * that additionally requires `isAuthor`.
   */
  private static readonly FLAT_VIEWER_ROLE = RosterRole.Member;

  async listPosts(
    slug: string,
    viewerId: string,
    page?: number,
    searchTerm?: string,
  ): Promise<Paginated<CommunityPostDTO>> {
    const community = await this.loadCommunityOr404(slug);
    await this.assertViewable(community, viewerId);
    const normalizedPage = normalizePage(page);

    const qb = this.posts
      .createQueryBuilder('p')
      .where('p.community_id = :communityId', { communityId: community.id })
      .orderBy('p.pinned', 'DESC')
      .addOrderBy('p.created_at', 'DESC');
    // Case-insensitive body search, ANDed into the same query as every other
    // filter below so `paginate`'s LIMIT/OFFSET and its `total` both count
    // only matching posts. A community's own posts were unsearchable until
    // now: global search matches communities themselves and never their
    // contents, so "what did we decide about X" had no answer past the point
    // where scrolling stopped being practical.
    const trimmedSearchTerm = searchTerm?.trim();
    if (trimmedSearchTerm) {
      qb.andWhere('p.body ILIKE :searchPattern', {
        searchPattern: `%${escapeLikeTerm(trimmedSearchTerm)}%`,
      });
    }
    // Blocked-either-way and muted authors' posts are excluded in-query, so
    // `paginate`'s LIMIT/OFFSET and its `total` both count only visible posts.
    // Filtering the fetched rows instead would under-fill every page *and*
    // report a `total` the caller can never page through.
    this.blockFilter.excludeHidden(qb, viewerId, '"p"."author_id"');

    const viewerRole = await this.viewerRoleIn(community.id, viewerId);
    // Moderator-hidden posts leave the query for a non-staff viewer, for the
    // same reason the block filter above does. `toPostDTOs` used to drop them
    // in Node AFTER `paginate` had already counted them into `total` and spent
    // page slots on them, so a page could come back short (or empty) while
    // `total` insisted there was content — infinite scroll and the counters
    // both broke after a moderation sweep (BE-COM-12). Replies have used the
    // in-query filter all along (see `listReplies`).
    if (!CommunityPostsService.isStaffRole(viewerRole)) {
      this.contentModeration.excludeHidden(
        qb,
        CommunityPostsService.SUBJECT_TYPES,
        '"p"."id"',
      );
    }
    return paginate(qb, normalizedPage, (rows) =>
      this.toPostDTOs(rows, viewerId, viewerRole),
    );
  }

  /**
   * `GET /communities/:slug/posts/:id` — one post, for its permalink page
   * (SOC-02). Before this the only way to read a post was to page through
   * `listPosts` until it appeared, so a "someone replied to your post"
   * notification could only ever land on the top of a timeline.
   *
   * Every gate `listPosts` applies to the same row is applied here, so a
   * permalink can never show what the timeline withholds:
   *
   * - a PRIVATE community is a 404 to a non-member (`assertViewable`), the
   *   same not-found the timeline gives, so holding a post id proves nothing;
   * - a blocked-either-way or muted author's post is a 404, matching the
   *   in-query `blockFilter.excludeHidden` the timeline runs;
   * - a moderator-hidden post is a 404 for a non-staff viewer, because
   *   `toPostDTOs` drops it and leaves the array empty. Owner/co-owner/mod
   *   still read it, exactly as they still see it in the timeline.
   *
   * A non-member of a PUBLIC/request/invite community reads the post the same
   * way they read the timeline: the DTO's own `canEdit`/`canDelete` flags stay
   * false, so the page renders it without write affordances.
   */
  async getPost(
    slug: string,
    postId: string,
    viewerId: string,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    await this.assertViewable(community, viewerId);
    const post = await this.loadPostOr404(community.id, postId);
    if (post.authorId) {
      const hiddenAuthorIds = await this.blockFilter.hiddenUserIds(viewerId, [
        post.authorId,
      ]);
      if (hiddenAuthorIds.has(post.authorId)) {
        throw new NotFoundException('Post not found');
      }
    }
    const viewerRole = await this.viewerRoleIn(community.id, viewerId);
    const [dto] = await this.toPostDTOs([post], viewerId, viewerRole);
    if (!dto) {
      // `toPostDTOs` withheld it: moderator-hidden, and this viewer is not
      // staff. Same answer as a post that never existed.
      throw new NotFoundException('Post not found');
    }
    return dto;
  }

  async createPost(
    slug: string,
    authorId: string,
    dto: CreatePostInput,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const membership = await this.assertMember(community.id, authorId);
    this.assertNotFrozen(community, membership);
    CommunityPostsService.assertKindAllowed(dto.kind, membership.role);

    const kind = dto.kind ?? PostKind.Post;
    const isAnnouncement = kind === PostKind.Announcement;

    const saved = await this.posts.save(
      this.posts.create({
        communityId: community.id,
        authorId,
        body: dto.body,
        image: dto.image ?? null,
        kind,
        // An announcement is auto-pinned. Only an owner/co-owner/mod can
        // publish one (`assertKindAllowed` above), so this is the same staff
        // authority the manual pin in `updatePost` requires, applied at the
        // moment the announcement is made rather than as a second step the
        // author has to remember. Unpinning it later is the ordinary
        // staff-only `PATCH ... { pinned: false }`.
        pinned: isAnnouncement,
      }),
    );
    await this.notifyRosterOfPost(community, saved, authorId, isAnnouncement);
    await this.mentions.notify(dto.body, authorId, {
      actorId: authorId,
      source: 'community',
      communitySlug: slug,
      postId: saved.id,
      excerpt: dto.body.slice(0, 140),
    });
    // Record the post as public profile activity — but only for PUBLIC
    // communities; the listener drops request/invite/private ones (the
    // `accessTier` is carried so that gate happens off the platform's own
    // visibility model, not a guess). Fire-and-forget: a listener failure must
    // never affect posting.
    this.eventEmitter.emit(COMMUNITY_POST_CREATED, {
      authorId,
      communitySlug: slug,
      communityName: community.name,
      accessTier: community.accessTier,
      postId: saved.id,
      excerpt: dto.body.slice(0, 80),
    } satisfies CommunityPostCreatedEvent);
    return this.buildPostDTO(saved, authorId, membership.role);
  }

  async updatePost(
    slug: string,
    postId: string,
    actorId: string,
    dto: UpdatePostInput,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, actorId);

    if (dto.pinned !== undefined) {
      if (!CommunityPostsService.isStaffRole(membership.role)) {
        throw new ForbiddenException('Only a moderator can pin a post');
      }
      post.pinned = dto.pinned;
    }
    // An author must not be able to post a plain `post` and then PATCH it into
    // an `announcement` — see `assertKindAllowed` (BE-COM-16).
    CommunityPostsService.assertKindAllowed(dto.kind, membership.role);

    const saved = await this.applyPostFieldEdit(post, actorId, dto);
    return this.buildPostDTO(saved, actorId, membership.role);
  }

  /**
   * `PATCH /community-posts/:id` — the flat alias's own update: author-only,
   * body/kind/image only (see `UpdateFlatPostInput`'s doc comment for why
   * `pinned` isn't part of this shape). Shares `applyPostFieldEdit` with the
   * nested route above; the only difference is there's no community/pin
   * authorization step here — `applyPostFieldEdit` itself enforces the
   * author-only check on any actual field change.
   */
  async updateFlatPost(
    postId: string,
    actorId: string,
    dto: UpdateFlatPostInput,
  ): Promise<CommunityPostDTO> {
    const post = await this.loadPostByIdOr404(postId);
    // Same announcement gate as the nested route (BE-COM-16). A GLOBAL post
    // (`communityId: null`) has no community to speak for, so there is no
    // staff voice to impersonate and `viewerRoleIn` is not consulted.
    if (dto.kind !== undefined && post.communityId) {
      CommunityPostsService.assertKindAllowed(
        dto.kind,
        await this.viewerRoleIn(post.communityId, actorId),
      );
    }
    const saved = await this.applyPostFieldEdit(post, actorId, dto);
    return this.buildPostDTO(
      saved,
      actorId,
      CommunityPostsService.FLAT_VIEWER_ROLE,
    );
  }

  // DELETE /communities/:slug/posts/:id — soft tombstone. Author or owner/mod.
  async deletePost(
    slug: string,
    postId: string,
    actorId: string,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(post.authorId, membership);

    return this.tombstonePost(post, actorId, membership.role);
  }

  // DELETE /community-posts/:id — the flat alias's own delete: author-only
  // (no owner/mod concept without a community). Shares `tombstonePost` with
  // the nested route above.
  async deleteFlatPost(
    postId: string,
    actorId: string,
  ): Promise<CommunityPostDTO> {
    const post = await this.loadPostByIdOr404(postId);
    this.assertAuthorOnly(post.authorId, actorId);
    return this.tombstonePost(
      post,
      actorId,
      CommunityPostsService.FLAT_VIEWER_ROLE,
    );
  }

  // POST /communities/:slug/posts/:id/restore — clear the tombstone. Only the
  // actor who set it, or a community owner/mod (see `assertCanRestore`).
  async restorePost(
    slug: string,
    postId: string,
    actorId: string,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(post.authorId, membership);
    this.assertCanRestore(post.deletedById, actorId, membership.role);

    return this.restorePostCore(post, actorId, membership.role);
  }

  // POST /community-posts/:id/restore — the flat alias's own restore.
  //
  // This used to be `assertAuthorOnly` against a post loaded WITHOUT its
  // community, which made it the bypass for the nested route's moderation:
  // a community mod tombstoned a post through `/communities/:slug/posts/:id`
  // and its author cleared the tombstone here, roster unread (BE-COM-01). The
  // post's community is now resolved so the SAME `assertCanRestore` rule
  // applies on both routes — a moderator tombstone needs a moderator to lift.
  // A global post (`communityId: null`) has no roster, so the actor's role is
  // null and only "you set this tombstone" can authorize.
  async restoreFlatPost(
    postId: string,
    actorId: string,
  ): Promise<CommunityPostDTO> {
    const post = await this.loadPostByIdOr404(postId);
    const viewerRole = post.communityId
      ? await this.viewerRoleIn(post.communityId, actorId)
      : null;
    if (!CommunityPostsService.isStaffRole(viewerRole)) {
      this.assertAuthorOnly(post.authorId, actorId);
    }
    this.assertCanRestore(post.deletedById, actorId, viewerRole);
    return this.restorePostCore(
      post,
      actorId,
      viewerRole ?? CommunityPostsService.FLAT_VIEWER_ROLE,
    );
  }

  // GET /communities/:slug/posts/:id/history — revisions, newest-first.
  async listPostHistory(
    slug: string,
    postId: string,
    actorId: string,
  ): Promise<CommunityPostHistoryResponse> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(post.authorId, membership);

    return this.postHistoryCore(post.id);
  }

  // GET /community-posts/:id/history — the flat alias's own history: a flat
  // post has no owner/mod either, so this is restricted to the author, unlike
  // the nested route's author-or-owner/mod. Shares `postHistoryCore`.
  async listFlatPostHistory(
    postId: string,
    actorId: string,
  ): Promise<CommunityPostHistoryResponse> {
    const post = await this.loadPostByIdOr404(postId);
    this.assertAuthorOnly(post.authorId, actorId);
    return this.postHistoryCore(post.id);
  }

  // PATCH /communities/:slug/posts/:id/replies/:replyId — author-only text
  // edit. Snapshots the pre-edit text to `community_post_reply_edit`, stamps
  // editedAt.
  async updateReply(
    slug: string,
    postId: string,
    replyId: string,
    actorId: string,
    text: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const membership = await this.assertMember(community.id, actorId);

    const saved = await this.applyReplyTextEdit(reply, actorId, text);
    return this.mapReply(saved, actorId, membership.role);
  }

  // PATCH /community-posts/:id/replies/:replyId — the flat alias's own reply
  // edit: author-only (same as the nested route — edit was already
  // author-only there too), just without the community-membership check.
  // Shares `applyReplyTextEdit`.
  async updateFlatReply(
    postId: string,
    replyId: string,
    actorId: string,
    text: string,
  ): Promise<CommunityReplyDTO> {
    const post = await this.loadPostByIdOr404(postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const saved = await this.applyReplyTextEdit(reply, actorId, text);
    return this.mapReply(
      saved,
      actorId,
      CommunityPostsService.FLAT_VIEWER_ROLE,
    );
  }

  // DELETE /communities/:slug/posts/:id/replies/:replyId — soft tombstone.
  async deleteReply(
    slug: string,
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(reply.authorId, membership);

    return this.tombstoneReply(reply, actorId, membership.role);
  }

  // DELETE /community-posts/:id/replies/:replyId — the flat alias's own
  // reply delete: author-only. Shares `tombstoneReply`.
  async deleteFlatReply(
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyDTO> {
    const post = await this.loadPostByIdOr404(postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    this.assertAuthorOnly(reply.authorId, actorId);
    return this.tombstoneReply(
      reply,
      actorId,
      CommunityPostsService.FLAT_VIEWER_ROLE,
    );
  }

  // POST /communities/:slug/posts/:id/replies/:replyId/restore — clear
  // tombstone.
  async restoreReply(
    slug: string,
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(reply.authorId, membership);
    this.assertCanRestore(reply.deletedById, actorId, membership.role);

    return this.restoreReplyCore(reply, actorId, membership.role);
  }

  // POST /community-posts/:id/replies/:replyId/restore — the flat alias's own
  // reply restore. Same community resolution + `assertCanRestore` rule as
  // `restoreFlatPost` above, for the same reason (BE-COM-01).
  async restoreFlatReply(
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyDTO> {
    const post = await this.loadPostByIdOr404(postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const viewerRole = post.communityId
      ? await this.viewerRoleIn(post.communityId, actorId)
      : null;
    if (!CommunityPostsService.isStaffRole(viewerRole)) {
      this.assertAuthorOnly(reply.authorId, actorId);
    }
    this.assertCanRestore(reply.deletedById, actorId, viewerRole);
    return this.restoreReplyCore(
      reply,
      actorId,
      viewerRole ?? CommunityPostsService.FLAT_VIEWER_ROLE,
    );
  }

  // GET /communities/:slug/posts/:id/replies/:replyId/history —
  // newest-first.
  async listReplyHistory(
    slug: string,
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyHistoryResponse> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(reply.authorId, membership);

    return this.replyHistoryCore(replyId);
  }

  // GET /community-posts/:id/replies/:replyId/history — the flat alias's own
  // reply history: author-only (no owner/mod concept without a community).
  // Shares `replyHistoryCore`.
  async listFlatReplyHistory(
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyHistoryResponse> {
    const post = await this.loadPostByIdOr404(postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    this.assertAuthorOnly(reply.authorId, actorId);
    return this.replyHistoryCore(replyId);
  }

  // GET /communities/:slug/reports — owner/mod-only queue of OPEN reports
  // whose subject resolves to a post or reply IN THIS COMMUNITY, or (TS-13) to
  // a photograph in the album of a gathering this community hosts. Resolution
  // mirrors `CommunityAutoFreezeService.resolveCommunity` and
  // `admin-communities/community-report-scope.ts`'s aggregation shape,
  // narrowed from admin-wide to one community and from totals to the actual
  // rows a moderator queue needs.
  //
  // THE READ HAS TO MATCH THE WRITE, EXACTLY. `ModerationService
  // .communityIdForReportSubject` decides which reports a community moderator
  // may action, and it answers for three subject types: `post`, `reply` and
  // `event_photo`. This predicate is the only permitted read that hands a
  // community moderator a report id, so anything that resolver attributes to
  // this community and this query does not is a report they may act on and
  // cannot find, and anything this query shows and that resolver does not
  // attribute here is a report they can see and will be refused. Change the
  // two together or neither.
  //
  // Each row carries the content it is about (excerpt, author, thread id where
  // there is one, moderation state) so a moderator reads what they are being
  // asked to judge before acting on it. Resolving that stays batched: whatever
  // the page size, this runs a fixed number of queries (reports, posts,
  // replies, photos, then authors, moderation states and the photos'
  // gatherings) rather than one lookup per report.
  //
  // The route lives on `CommunitiesController` (`GET /communities/:slug/reports`),
  // because a route's path is controller-prefix + method path and this
  // service's own `CommunityPostsController` is mounted at `/community-posts`.
  async listCommunityReports(
    slug: string,
    actorId: string,
  ): Promise<CommunityReportDTO[]> {
    const community = await this.loadCommunityOr404(slug);
    const membership = await this.assertMember(community.id, actorId);
    if (!CommunityPostsService.isStaffRole(membership.role)) {
      throw new ForbiddenException(
        'Only a community owner/mod can view its reports',
      );
    }

    // Joined, not an `IN (...)` list. This used to load every post id AND
    // every reply id of the community into Node and bind them as one
    // parameter list, which Postgres rejects past 65535 parameters — the same
    // failure `AdminCommunitiesService.loadReportScope` documents and was
    // rewritten to avoid (BE-COM-13). The uuid side is cast to text because
    // `reports.subject_id` is a varchar that carries slugs as well as uuids,
    // so casting IT to uuid would throw on a non-uuid row.
    const rows = await this.reports
      .createQueryBuilder('report')
      .where('report.status = :open', { open: ReportStatus.Open })
      .andWhere(
        `(
          (report.subject_type = :postType AND EXISTS (
            SELECT 1 FROM "community_posts" "__scoped_post"
            WHERE "__scoped_post"."id"::text = report.subject_id
              AND "__scoped_post"."community_id" = :communityId
          ))
          OR (report.subject_type = :replyType AND EXISTS (
            SELECT 1 FROM "community_post_replies" "__scoped_reply"
            JOIN "community_posts" "__scoped_reply_post"
              ON "__scoped_reply_post"."id" = "__scoped_reply"."post_id"
            WHERE "__scoped_reply"."id"::text = report.subject_id
              AND "__scoped_reply_post"."community_id" = :communityId
          ))
          OR (report.subject_type = :eventPhotoType AND EXISTS (
            SELECT 1 FROM "event_photos" "__scoped_photo"
            JOIN "events" "__scoped_photo_event"
              ON "__scoped_photo_event"."id" = "__scoped_photo"."event_id"
            WHERE "__scoped_photo"."id"::text = report.subject_id
              AND "__scoped_photo_event"."community_id" = :communityId
          ))
        )`,
        {
          postType: ReportSubjectType.Post,
          replyType: ReportSubjectType.Reply,
          // TS-13. The community has to be the GATHERING's own
          // (`events.community_id`), never one inferred from the uploader's
          // memberships, which would hand a photo report to a room that had
          // nothing to do with the event. The join to `events` is INNER and
          // the comparison is an equality, so a gathering that belongs to no
          // community (`community_id IS NULL`) matches nothing and its photos
          // stay platform-only. The failure this rules out is a photo with no
          // community turning up in EVERY community's queue at once.
          eventPhotoType: ReportSubjectType.EventPhoto,
          communityId: community.id,
        },
      )
      .orderBy('report.created_at', 'DESC')
      .take(DEFAULT_LIST_LIMIT)
      .getMany();

    return this.attachReportedContent(rows);
  }

  /**
   * Resolves a page of community reports to their content in a fixed number
   * of queries and maps the DTOs.
   *
   * The subject ids arriving here already passed the scoping predicate above,
   * so every one of them is a real uuid of a post or reply inside this
   * community, or of a photo in one of its gatherings' albums. The loads are
   * still unconditional `find`s on those ids: a row can be tombstoned or
   * moderation-hidden and must still reach the moderator, which is the whole
   * point of the queue. A row that has since disappeared entirely resolves to
   * `content: null` and the report itself is still listed.
   *
   * `event_photos` has no soft-delete column, so a photo the uploader or an
   * organizer took down is simply absent here and its report reads as
   * `content: null`, the same "the row it pointed at is gone" case a
   * hard-deleted post would produce.
   */
  private async attachReportedContent(
    rows: Report[],
  ): Promise<CommunityReportDTO[]> {
    if (!rows.length) return [];

    const postIds = [
      ...new Set(
        rows
          .filter((report) => report.subjectType === ReportSubjectType.Post)
          .map((report) => report.subjectId),
      ),
    ];
    const replyIds = [
      ...new Set(
        rows
          .filter((report) => report.subjectType === ReportSubjectType.Reply)
          .map((report) => report.subjectId),
      ),
    ];
    const photoIds = [
      ...new Set(
        rows
          .filter(
            (report) => report.subjectType === ReportSubjectType.EventPhoto,
          )
          .map((report) => report.subjectId),
      ),
    ];

    const [postRows, replyRows, photoRows] = await Promise.all([
      postIds.length
        ? this.posts.find({ where: { id: In(postIds) } })
        : Promise.resolve([]),
      replyIds.length
        ? this.replies.find({ where: { id: In(replyIds) } })
        : Promise.resolve([]),
      photoIds.length
        ? this.eventPhotos.find({ where: { id: In(photoIds) } })
        : Promise.resolve([]),
    ]);

    const postsById = new Map(postRows.map((post) => [post.id, post]));
    const repliesById = new Map(replyRows.map((reply) => [reply.id, reply]));
    const photosById = new Map(photoRows.map((photo) => [photo.id, photo]));

    // The gatherings ride in this second batch rather than a third round trip:
    // they depend only on the photo rows, which are already in hand, and the
    // authors/states lookups below do not depend on them.
    const gatheringIds = [...new Set(photoRows.map((photo) => photo.eventId))];
    const [authors, states, gatheringRows] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([
        ...new Set(
          nonNullIds([
            ...postRows.map((post) => post.authorId),
            ...replyRows.map((reply) => reply.authorId),
            // A photo's "author" is its uploader, `ON DELETE SET NULL`, so an
            // erased uploader drops out here exactly like an erased post
            // author does.
            ...photoRows.map((photo) => photo.uploaderId),
          ]),
        ),
      ]),
      this.reportModerationStatesFor(postIds, replyIds, photoIds),
      gatheringIds.length
        ? this.events.find({
            where: { id: In(gatheringIds) },
            select: { id: true, title: true, slug: true },
          })
        : Promise.resolve([]),
    ]);
    const gatheringsById = new Map(
      gatheringRows.map((gathering) => [gathering.id, gathering]),
    );

    const now = new Date();
    return rows.map((report) => {
      // Keyed by the report's OWN subject type: a post, a reply and a photo
      // are all addressed by uuid, so looking a subject id up in every map
      // would let one table answer for another.
      const isReply = report.subjectType === ReportSubjectType.Reply;
      const isPhoto = report.subjectType === ReportSubjectType.EventPhoto;
      const post =
        isReply || isPhoto ? null : (postsById.get(report.subjectId) ?? null);
      const reply = isReply
        ? (repliesById.get(report.subjectId) ?? null)
        : null;
      const photo = isPhoto ? (photosById.get(report.subjectId) ?? null) : null;
      const authorId = isPhoto
        ? (photo?.uploaderId ?? null)
        : isReply
          ? (reply?.authorId ?? null)
          : (post?.authorId ?? null);
      return toCommunityReportDTO(
        report,
        {
          post,
          reply,
          photo,
          gathering: photo ? (gatheringsById.get(photo.eventId) ?? null) : null,
          author: authorRefOf(authors, authorId),
          moderation:
            states.get(report.subjectId) ?? CommunityPostsService.VISIBLE,
        },
        now,
      );
    });
  }

  // Resolve a single reply's author and map it (with the actor's role) so the
  // returned DTO's flags are correct for the actor.
  private async mapReply(
    reply: CommunityPostReply,
    viewerId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityReplyDTO> {
    const [authors, states] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(
        reply.authorId ? [reply.authorId] : [],
      ),
      this.contentModeration.statesForAnyType(
        CommunityPostsService.SUBJECT_TYPES,
        [reply.id],
      ),
    ]);
    return toCommunityReply(
      reply,
      authorRefOf(authors, reply.authorId),
      viewerId,
      viewerRole,
      states.get(reply.id) ?? CommunityPostsService.VISIBLE,
    );
  }

  async addReaction(
    slug: string,
    postId: string,
    userId: string,
    key: ReactionKey,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, userId);
    this.assertNotFrozen(community, membership);

    // Idempotent per (post,user,key): `ON CONFLICT DO NOTHING` absorbs a
    // re-react (or a race between two concurrent ones) without a pre-check +
    // 23505 — mirrors `EventsService.addCohost`'s insert idiom.
    await this.reactions
      .createQueryBuilder()
      .insert()
      .into(CommunityPostReaction)
      .values({ postId: post.id, userId, key })
      .orIgnore()
      .execute();

    return this.buildPostDTO(post, userId, membership.role);
  }

  async removeReaction(
    slug: string,
    postId: string,
    userId: string,
    key: ReactionKey,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, userId);

    await this.reactions.delete({ postId: post.id, userId, key });

    return this.buildPostDTO(post, userId, membership.role);
  }

  async addReply(
    slug: string,
    postId: string,
    userId: string,
    text: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, userId);
    this.assertNotFrozen(community, membership);

    const saved = await this.replies.save(
      this.replies.create({ postId: post.id, authorId: userId, text }),
    );
    const replyPayload = {
      actorId: userId,
      source: 'community',
      communitySlug: slug,
      postId: post.id,
      replyId: saved.id,
      excerpt: text.slice(0, 140),
    };
    const mentioned = await this.mentions.notify(text, userId, replyPayload);
    // Tell the post's author their post got a reply — unless the reply already
    // `@mentioned` them (they'd then get one notification, not two), or the
    // post's author account was erased (`post.authorId` null — no one to tell).
    if (post.authorId && !mentioned.has(post.authorId)) {
      await this.mentions.notifyPostReply(post.authorId, userId, replyPayload);
    }
    const authors = await new MemberLookup(this.profiles).byUserIds([userId]);
    return toCommunityReply(
      saved,
      authors.get(userId) ?? null,
      userId,
      membership.role,
    );
  }

  // GET /communities/:slug/posts/:id/replies?page= — every reply beyond the
  // bounded preview a post already embeds (`toPostDTOs`/`buildPostDTO` cap the
  // preview at `PAGE_SIZE`, oldest-first). `page=1` here is deliberately the
  // SAME window as that preview (same `PAGE_SIZE`, same `created_at ASC, id
  // ASC` order), so a "load more" click just requests `page=2` onward — no
  // separate cursor to keep in sync between the embedded preview and this
  // endpoint. Offset pagination (not keyset) is the right fit: this is a
  // single post's own reply thread, browsed forward-only and rarely deep —
  // see `nestjs-and-queries.md`'s keyset-vs-offset guidance.
  async listReplies(
    slug: string,
    postId: string,
    viewerId: string,
    page?: number,
  ): Promise<Paginated<CommunityReplyDTO>> {
    const community = await this.loadCommunityOr404(slug);
    // A private community's replies are 404 to a non-member, exactly like
    // `listPosts` above — `viewerRoleIn` below returns null for a non-member
    // rather than throwing, so without this an ex-member (or any member of
    // another community) who still holds a post id could read the whole
    // private thread. Mirrors the sibling read's gate.
    await this.assertViewable(community, viewerId);
    const post = await this.loadPostOr404(community.id, postId);
    const viewerRole = await this.viewerRoleIn(community.id, viewerId);
    const viewerIsStaff = CommunityPostsService.isStaffRole(viewerRole);
    const normalizedPage = normalizePage(page);

    const qb = this.replies
      .createQueryBuilder('r')
      .where('r.post_id = :postId', { postId: post.id })
      .orderBy('r.created_at', 'ASC')
      .addOrderBy('r.id', 'ASC');
    // In-query (not post-query) so a page of `PAGE_SIZE` replies comes back
    // full instead of silently short — mirrors `listPosts`'s own use of
    // `excludeHidden` for exactly this reason.
    this.blockFilter.excludeHidden(qb, viewerId, '"r"."author_id"');
    // Same reasoning for moderator takedowns, and it matters MORE here than
    // for block/mute: this is OFFSET pagination, so filtering hidden replies
    // out AFTER the fixed-size fetch (as this used to) doesn't just under-fill
    // page N — page N+1's offset is computed from the RAW row order, so the
    // reply just past the hidden one would never be served on ANY page. A
    // staff viewer (owner/mod) still sees hidden-but-not-removed replies, so
    // this is skipped for them, mirroring `isStaffRole` everywhere else here.
    if (!viewerIsStaff) {
      this.contentModeration.excludeHidden(
        qb,
        CommunityPostsService.SUBJECT_TYPES,
        '"r"."id"',
      );
    }

    return paginate(qb, normalizedPage, async (rows) => {
      if (!rows.length) return [];
      // No post-fetch moderation filter here anymore — `excludeHidden` above
      // already means every fetched row is one this viewer may see, so
      // `total`/the page's offset math stay correct across pages.
      const states = await this.moderationStatesFor(
        [],
        rows.map((row) => row.id),
      );
      const authors = await new MemberLookup(this.profiles).byUserIds(
        nonNullIds(rows.map((row) => row.authorId)),
      );
      return rows.map((row) =>
        toCommunityReply(
          row,
          authorRefOf(authors, row.authorId),
          viewerId,
          viewerRole,
          states.get(row.id) ?? CommunityPostsService.VISIBLE,
        ),
      );
    });
  }

  // --- flat aliases (`POST /community-posts*` — see `CommunityPostsController`) ---
  //
  // These reuse the same `community_posts`/`community_post_reactions`/
  // `community_post_replies` store as the nested `/communities/:slug/posts*`
  // routes above, just addressed by post id instead of (slug, id). A post
  // created without a `communitySlug` gets `communityId: null` — a "global"
  // post, per `CommunityPost.communityId`'s doc comment.

  /**
   * `POST /community-posts` — create a post, optionally inside a community.
   * With `communitySlug`, this is exactly `createPost` (same 404-on-unknown-
   * slug + roster-member-only checks). Without one, it's a global post any
   * active member may create (guarded only by `ActiveMemberGuard` at the
   * controller) — there's no community roster to be a member of.
   */
  async createFlatPost(
    authorId: string,
    dto: CreateFlatPostInput,
  ): Promise<{ id: string }> {
    let communityId: string | null = null;
    if (dto.communitySlug) {
      const community = await this.loadCommunityOr404(dto.communitySlug);
      const membership = await this.assertMember(community.id, authorId);
      // Same archive/freeze gate as `createPost`'s slug-scoped path — see
      // `assertFlatWriteAllowed` (the community is already resolved here, so
      // the two checks are applied directly rather than re-resolving it).
      this.assertNotArchived(community);
      this.assertNotFrozen(community, membership);
      communityId = community.id;
    }

    const saved = await this.posts.save(
      this.posts.create({
        communityId,
        authorId,
        body: dto.body,
        image: null,
        kind: PostKind.Post,
        pinned: false,
      }),
    );
    await this.mentions.notify(dto.body, authorId, {
      actorId: authorId,
      source: 'community',
      postId: saved.id,
      communitySlug: dto.communitySlug,
      excerpt: dto.body.slice(0, 140),
    });
    return { id: saved.id };
  }

  /**
   * `POST /community-posts/:id/like` — idempotent like/unlike toggle over the
   * reserved `ReactionKey.Like` key (same `orIgnore` insert / `delete` idiom
   * as `addReaction`/`removeReaction`). For a community-scoped post, only a
   * roster member may like it (mirrors the nested reaction routes); a global
   * post (`communityId: null`) has no roster, so any active member may.
   */
  async likeFlatPost(
    postId: string,
    userId: string,
    liked: boolean,
  ): Promise<{ liked: boolean; likeCount: number }> {
    const post = await this.loadPostByIdOr404(postId);
    if (liked) {
      // Adding a reaction is new activity, so it takes the full archive +
      // freeze gate (BE-COM-02).
      await this.assertFlatWriteAllowed(post.communityId, userId);
    } else if (post.communityId) {
      // Taking your OWN reaction back is not new activity — the slug-scoped
      // `removeReaction` has never been freeze-gated either, so this stays a
      // plain roster check rather than trapping a like inside a freeze.
      await this.assertMember(post.communityId, userId);
    }

    if (liked) {
      await this.reactions
        .createQueryBuilder()
        .insert()
        .into(CommunityPostReaction)
        .values({ postId: post.id, userId, key: ReactionKey.Like })
        .orIgnore()
        .execute();
    } else {
      await this.reactions.delete({
        postId: post.id,
        userId,
        key: ReactionKey.Like,
      });
    }

    const likeCount = await this.reactions.count({
      where: { postId: post.id, key: ReactionKey.Like },
    });
    return { liked, likeCount };
  }

  /**
   * `POST /community-posts/:id/replies` — reply to a post by id (same
   * membership rule as `likeFlatPost` above; reuses the same
   * `community_post_replies` insert as `addReply`).
   */
  async addFlatReply(
    postId: string,
    userId: string,
    text: string,
  ): Promise<{ id: string }> {
    const post = await this.loadPostByIdOr404(postId);
    const gate = await this.assertFlatWriteAllowed(post.communityId, userId);

    const saved = await this.replies.save(
      this.replies.create({ postId: post.id, authorId: userId, text }),
    );
    const community = gate?.community ?? null;
    const replyPayload = {
      actorId: userId,
      source: 'community',
      postId: post.id,
      replyId: saved.id,
      ...(community ? { communitySlug: community.slug } : {}),
      excerpt: text.slice(0, 140),
    };
    const mentioned = await this.mentions.notify(text, userId, replyPayload);
    // A `null` post.authorId (erased author) has no one to notify — see the
    // same guard in `addReply` above.
    if (post.authorId && !mentioned.has(post.authorId)) {
      await this.mentions.notifyPostReply(post.authorId, userId, replyPayload);
    }
    return { id: saved.id };
  }

  // --- internals ---

  private async loadCommunityOr404(slug: string): Promise<Community> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  private async loadPostOr404(
    communityId: string,
    postId: string,
  ): Promise<CommunityPost> {
    const post = await this.posts.findOne({
      where: { id: postId, communityId },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  // Used by the flat by-id aliases above, which have no `slug` to scope the
  // lookup with (a global post has no community at all).
  private async loadPostByIdOr404(postId: string): Promise<CommunityPost> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  private async loadReplyOr404(
    postId: string,
    replyId: string,
  ): Promise<CommunityPostReply> {
    const reply = await this.replies.findOne({
      where: { id: replyId, postId },
    });
    if (!reply) {
      throw new NotFoundException('Reply not found');
    }
    return reply;
  }

  /**
   * Diffs and persists a post's mutable `body`/`kind`/`image` (plus whatever
   * the caller already set directly on `post` before calling this — e.g.
   * `pinned`, for the nested route only), in one transaction alongside its
   * edit-history snapshot when the body actually changes. Shared by
   * `updatePost` (nested, community-scoped) and `updateFlatPost` (flat,
   * author-only) — the only difference between those two callers is what's
   * authorized BEFORE reaching here (pin-authorization for the nested route;
   * nothing extra for the flat one) and which fields the caller's DTO even
   * offers (`UpdateFlatPostInput` has no `pinned`). The author-only check for
   * an actual body/kind/image change is enforced HERE, identically for both
   * callers, since editing was already author-only even on the nested route.
   */
  private async applyPostFieldEdit(
    post: CommunityPost,
    actorId: string,
    dto: Pick<UpdatePostInput, 'body' | 'kind' | 'image'>,
  ): Promise<CommunityPost> {
    // Built if the body actually changes, then persisted alongside the post in
    // one transaction below — never as a separate write, or a failure would
    // record a "previous body" for an edit that never landed (phantom revision).
    let pendingEdit: CommunityPostEdit | null = null;
    // Captured only when the image is genuinely swapped/cleared, so the object
    // the post USED to reference can be deleted after the write commits.
    let replacedImage: string | null = null;
    if (
      dto.body !== undefined ||
      dto.kind !== undefined ||
      dto.image !== undefined
    ) {
      if (post.deletedAt) {
        throw new NotFoundException('Post not found');
      }
      if (post.authorId !== actorId) {
        throw new ForbiddenException('Only the author can edit this post');
      }
      if (dto.body !== undefined && dto.body !== post.body) {
        pendingEdit = this.postEdits.create({
          postId: post.id,
          previousBody: post.body,
          editorId: actorId,
        });
        post.body = dto.body;
        post.editedAt = new Date();
      }
      if (dto.kind !== undefined) post.kind = dto.kind;
      if (dto.image !== undefined) {
        // `''`/`null` both clear the image (matches the DTO doc). Only when the
        // value truly changes do we mark the old object for deletion.
        const nextImage = dto.image || null;
        if (nextImage !== post.image) {
          replacedImage = post.image;
          post.image = nextImage;
        }
      }
    }

    const saved = await this.posts.manager.transaction(async (manager) => {
      if (pendingEdit) {
        await manager.save(pendingEdit);
      }
      return manager.save(post);
    });
    // Delete-on-replace, post-commit + best-effort: the superseded image object
    // is orphaned once the new value has committed. A non-key value (external
    // URL) no-ops; a storage failure must never fail the edit.
    if (replacedImage) {
      try {
        await this.storage.deleteObjectByReference(replacedImage);
      } catch (error) {
        this.logger.warn(
          `Failed to delete replaced image for post ${saved.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return saved;
  }

  // Shared by `deletePost` (nested) and `deleteFlatPost` (flat) — the
  // authorization check happens in each caller BEFORE this runs; this is just
  // the idempotent tombstone + DTO echo.
  private async tombstonePost(
    post: CommunityPost,
    actorId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityPostDTO> {
    if (!post.deletedAt) {
      post.deletedAt = new Date();
      // Stamped together with the marker: `assertCanRestore` reads this to
      // decide whether clearing the tombstone is the author undoing their own
      // delete or someone undoing a moderator's.
      post.deletedById = actorId;
      await this.posts.save(post);
    }
    return this.buildPostDTO(post, actorId, viewerRole);
  }

  // Shared by `restorePost` (nested) and `restoreFlatPost` (flat).
  private async restorePostCore(
    post: CommunityPost,
    actorId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityPostDTO> {
    if (post.deletedAt) {
      post.deletedAt = null;
      // Cleared with the marker so a later delete/restore pair is judged on
      // its own actor, never a stale one.
      post.deletedById = null;
      await this.posts.save(post);
    }
    return this.buildPostDTO(post, actorId, viewerRole);
  }

  // Shared by `listPostHistory` (nested) and `listFlatPostHistory` (flat) —
  // both callers have already authorized the actor before calling this.
  private async postHistoryCore(
    postId: string,
  ): Promise<CommunityPostHistoryResponse> {
    const rows = await this.postEdits.find({
      where: { postId },
      order: { createdAt: 'DESC' },
    });
    const editorIds = [
      ...new Set(
        rows.map((row) => row.editorId).filter((id): id is string => !!id),
      ),
    ];
    const editors = await new MemberLookup(this.profiles).byUserIds(editorIds);

    return {
      revisions: rows.map((row) =>
        toCommunityPostHistoryEntry(
          row,
          row.editorId ? (editors.get(row.editorId) ?? null) : null,
        ),
      ),
    };
  }

  // Shared by `updateReply` (nested) and `updateFlatReply` (flat) — edit was
  // already author-only on the nested route, so this is the same check
  // either way.
  private async applyReplyTextEdit(
    reply: CommunityPostReply,
    actorId: string,
    text: string,
  ): Promise<CommunityPostReply> {
    if (reply.deletedAt) {
      throw new NotFoundException('Reply not found');
    }
    if (reply.authorId !== actorId) {
      throw new ForbiddenException('Only the author can edit this reply');
    }
    if (text !== reply.text) {
      await this.replyEdits.save(
        this.replyEdits.create({
          replyId: reply.id,
          previousText: reply.text,
          editorId: actorId,
        }),
      );
      reply.text = text;
      reply.editedAt = new Date();
      await this.replies.save(reply);
    }
    return reply;
  }

  // Shared by `deleteReply` (nested) and `deleteFlatReply` (flat).
  private async tombstoneReply(
    reply: CommunityPostReply,
    actorId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityReplyDTO> {
    if (!reply.deletedAt) {
      reply.deletedAt = new Date();
      reply.deletedById = actorId;
      await this.replies.save(reply);
    }
    return this.mapReply(reply, actorId, viewerRole);
  }

  // Shared by `restoreReply` (nested) and `restoreFlatReply` (flat).
  private async restoreReplyCore(
    reply: CommunityPostReply,
    actorId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityReplyDTO> {
    if (reply.deletedAt) {
      reply.deletedAt = null;
      reply.deletedById = null;
      await this.replies.save(reply);
    }
    return this.mapReply(reply, actorId, viewerRole);
  }

  // Shared by `listReplyHistory` (nested) and `listFlatReplyHistory` (flat) —
  // both callers have already authorized the actor before calling this.
  private async replyHistoryCore(
    replyId: string,
  ): Promise<CommunityReplyHistoryResponse> {
    const rows = await this.replyEdits.find({
      where: { replyId },
      order: { createdAt: 'DESC' },
    });
    const editorIds = [
      ...new Set(
        rows.map((row) => row.editorId).filter((id): id is string => !!id),
      ),
    ];
    const editors = await new MemberLookup(this.profiles).byUserIds(editorIds);

    return {
      revisions: rows.map((row) =>
        toCommunityReplyHistoryEntry(
          row,
          row.editorId ? (editors.get(row.editorId) ?? null) : null,
        ),
      ),
    };
  }

  private async assertMember(
    communityId: string,
    userId: string,
  ): Promise<CommunityMember> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    if (!membership) {
      throw new ForbiddenException('Only roster members can do that');
    }
    return membership;
  }

  /**
   * The community gate every flat (`/community-posts*`) WRITE runs, for a post
   * that belongs to a community: roster membership, the archive check, and the
   * freeze check — the same three the slug-scoped routes have always applied.
   * The flat aliases previously ran `assertMember` only, so a frozen community
   * (including one auto-frozen over an outing/doxxing report) still took new
   * posts, replies and reactions through `POST /community-posts*`, which is
   * exactly what a freeze exists to stop (BE-COM-02).
   *
   * A global post (`communityId: null`) has no community to be frozen, so this
   * is a no-op returning `null`.
   */
  private async assertFlatWriteAllowed(
    communityId: string | null,
    userId: string,
  ): Promise<{ community: Community; membership: CommunityMember } | null> {
    if (!communityId) return null;
    const community = await this.communities.findOne({
      where: { id: communityId },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const membership = await this.assertMember(community.id, userId);
    this.assertNotArchived(community);
    this.assertNotFrozen(community, membership);
    return { community, membership };
  }

  /**
   * An archived community is down for everyone but its own owner/mods (see
   * `Community.archivedAt`), so it takes no new content at all. Checked on the
   * flat write paths alongside the freeze: the nested routes reach it through
   * `CommunitiesService.getBySlug`'s own archived filter, the flat ones had no
   * equivalent.
   */
  private assertNotArchived(community: Community): void {
    if (community.archivedAt != null) {
      throw new ForbiddenException('This community has been archived');
    }
  }

  /**
   * A frozen community (auto-frozen pending report review — see
   * `Community.frozenAt`) takes no new content from plain members: new posts,
   * replies and reactions are blocked. Owner/mods are exempt so they can still
   * post a note and moderate. Reads and edits/deletes of existing content are
   * unaffected — freezing halts new activity, it doesn't hide the community.
   */
  private assertNotFrozen(
    community: Community,
    membership: CommunityMember,
  ): void {
    if (
      community.frozenAt != null &&
      !CommunityPostsService.isStaffRole(membership.role)
    ) {
      throw new ForbiddenException(
        'This community is frozen while moderators review recent reports',
      );
    }
  }

  // The viewer's roster role in a community, or null if they aren't a member.
  // Used to compute the DTO's delete/restore/history flags for feed reads,
  // where the viewer may be a non-member on a non-private tier.
  private async viewerRoleIn(
    communityId: string,
    userId: string,
  ): Promise<RosterRole | null> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    return membership?.role ?? null;
  }

  // Delete / restore / history authz: the author, or the community's owner/mod.
  // (Editing stays author-only and is checked inline, NOT here.)
  private assertAuthorOrOwnerMod(
    // Nullable since `FixCommunityOwnerAuthorErasureCascades1789900000000`: a
    // `null` authorId means the original author's account was erased. It can
    // never equal a live `membership.userId`, so `isAuthor` naturally resolves
    // to false — an erased-author post/reply is manageable by owner/mod only,
    // never "the author" (there isn't one to match).
    authorId: string | null,
    membership: CommunityMember,
  ): void {
    const isAuthor = authorId === membership.userId;
    const isOwnerMod = CommunityPostsService.isStaffRole(membership.role);
    if (!isAuthor && !isOwnerMod) {
      throw new ForbiddenException(
        'Only the author or a community owner/mod can do that',
      );
    }
  }

  /**
   * `PostKind.Announcement` reads as the community's official voice, so only
   * its owner/mod may publish one — on create AND on edit (an author could
   * otherwise post a plain `post` and immediately PATCH it to
   * `announcement`). `pinned` was previously the only staff-gated field, which
   * left members able to publish posts styled as staff announcements inside a
   * community: an impersonation vector (BE-COM-16).
   *
   * `undefined` means "unchanged"/"default" and is always allowed;
   * `PostKind.Post` is always allowed, including a staff member downgrading
   * their own announcement back to an ordinary post.
   */
  private static assertKindAllowed(
    kind: PostKind | undefined,
    viewerRole: RosterRole | null,
  ): void {
    if (kind !== PostKind.Announcement) return;
    if (!CommunityPostsService.isStaffRole(viewerRole)) {
      throw new ForbiddenException(
        'Only a community owner/mod can post an announcement',
      );
    }
  }

  /**
   * Best-effort roster fan-out for a newly created community post.
   *
   * Who hears what is the member's own per-community `notificationLevel`
   * (`community_members.notification_level`):
   *   - `all`: `community_new_post` for every post, `community_announcement`
   *     for an announcement (one notification per post either way, never both)
   *   - `announcements`: only `community_announcement`
   *   - `mentions` / `muted`: nothing from here. A member on `mentions` still
   *     gets named-in-the-post notifications through
   *     `MentionNotificationService`, which this method does not touch.
   * The author never notifies themselves.
   *
   * ONE query selects the recipients: a `user_id` projection over
   * `community_members` filtered by community, level and "not the author", so
   * a roster of any size costs a single indexed read rather than a lookup per
   * member. The write side is then chunked through
   * `NotificationsService.createForRecipients` (see `POST_NOTIFY_CHUNK_SIZE`),
   * which is itself batched: one multi-row INSERT per chunk, with the
   * block/mute and per-category preference filters applied in two more batched
   * queries. There is no per-member create anywhere on this path.
   *
   * Wrapped in its own try/catch and awaited only for ordering: a notification
   * failure must never fail or roll back the post, which is already committed
   * by the time this runs.
   */
  private async notifyRosterOfPost(
    community: Community,
    post: CommunityPost,
    authorId: string,
    isAnnouncement: boolean,
  ): Promise<void> {
    try {
      const levels = isAnnouncement
        ? LEVELS_WANTING_ANNOUNCEMENTS
        : LEVELS_WANTING_EVERY_POST;
      const rosterRows = await this.members.find({
        where: {
          communityId: community.id,
          notificationLevel: In([...levels]),
          userId: Not(authorId),
        },
        select: { userId: true },
        order: { joinedAt: 'ASC' },
        take: POST_NOTIFY_MAX_RECIPIENTS,
      });
      const recipientIds = rosterRows.map((row) => row.userId);
      if (!recipientIds.length) return;

      const type = isAnnouncement
        ? NotificationType.CommunityAnnouncement
        : NotificationType.CommunityNewPost;
      const payload = {
        actorId: authorId,
        source: 'community',
        communitySlug: community.slug,
        communityName: community.name,
        postId: post.id,
        excerpt: post.body.slice(0, 140),
      };

      for (
        let offset = 0;
        offset < recipientIds.length;
        offset += POST_NOTIFY_CHUNK_SIZE
      ) {
        await this.notifications.createForRecipients(
          recipientIds.slice(offset, offset + POST_NOTIFY_CHUNK_SIZE),
          type,
          payload,
          authorId,
        );
      }
    } catch (error) {
      // Intentionally swallowed: the post already committed, and a bell that
      // did not ring is never worth losing a member's post over.
      this.logger.warn(
        `Community post fan-out failed for ${community.slug}/${post.id}: ${String(error)}`,
      );
    }
  }

  /**
   * Restore authz, on top of whichever delete-tier check the caller already
   * ran (`assertAuthorOrOwnerMod` on the nested routes, `assertAuthorOnly` on
   * the flat ones).
   *
   * The rule: a tombstone may only be cleared by the actor who SET it, or by
   * the community's owner/mod. Before `deleted_by_id` existed, delete and
   * restore shared one author-OR-owner/mod check, so the author of a post a
   * community moderator had removed simply undid the removal — community
   * moderation via the delete button was cosmetic (BE-COM-01).
   *
   * `deletedById === null` is the LEGACY case: a tombstone written before
   * `AddContentTombstoneActor1793520000000`, or a row that isn't tombstoned at
   * all (restore is then a no-op anyway). There is no actor to compare
   * against, so it falls through to the caller's own author-or-staff check
   * rather than locking legacy content out of restore entirely.
   */
  private assertCanRestore(
    deletedById: string | null,
    actorId: string,
    viewerRole: RosterRole | null,
  ): void {
    if (CommunityPostsService.isStaffRole(viewerRole)) return;
    if (deletedById === null) return;
    if (deletedById !== actorId) {
      throw new ForbiddenException(
        'Only a community owner/mod can restore content a moderator removed',
      );
    }
  }

  // Flat (`/community-posts*`) delete/restore/history authz: author-only.
  // There's no community here, so there's no owner/mod concept to fall back
  // to — unlike `assertAuthorOrOwnerMod`'s nested-route counterpart, a
  // non-author is rejected outright, even a platform moderator (moderator
  // takedown of a flat post goes through `src/moderation`'s
  // `hide_content`/`remove_content`, not this author-facing path). Same
  // null-safe comparison as above: a `null` authorId (erased author) can
  // never equal a live `actorId`.
  private assertAuthorOnly(authorId: string | null, actorId: string): void {
    if (authorId !== actorId) {
      throw new ForbiddenException('Only the author can do that');
    }
  }

  // Private communities are 404 (not 403) to a non-member, mirroring
  // `CommunitiesService.getBySlug` — existence isn't leaked. Non-private
  // tiers' post feeds are viewable without membership; only mutating actions
  // (`createPost`/`addReaction`/`addReply`/pin) require a roster row.
  private async assertViewable(
    community: Community,
    viewerId: string,
  ): Promise<void> {
    if (community.accessTier !== AccessTier.Private) return;
    const membership = await this.members.findOne({
      where: { communityId: community.id, userId: viewerId },
    });
    if (!membership) {
      throw new NotFoundException('Community not found');
    }
  }

  // States for a page of posts + their replies, keyed by row id. One query for
  // the whole set (post ids and reply ids never collide — both are uuids).
  private async moderationStatesFor(
    postIds: string[],
    replyIds: string[],
  ): Promise<Map<string, ContentModerationState>> {
    return this.contentModeration.statesForAnyType(
      CommunityPostsService.SUBJECT_TYPES,
      [...postIds, ...replyIds],
    );
  }

  // The same lookup for the moderation queue, which also carries gathering
  // photos. ONE query for the whole page rather than a second call for the
  // photo ids: `statesForAnyType` already spans several subject types and
  // takes the strongest state per subject id, and post, reply and photo ids
  // are uuids from disjoint tables, so nothing can collide.
  private async reportModerationStatesFor(
    postIds: string[],
    replyIds: string[],
    photoIds: string[],
  ): Promise<Map<string, ContentModerationState>> {
    return this.contentModeration.statesForAnyType(
      CommunityPostsService.REPORT_SUBJECT_TYPES,
      [...postIds, ...replyIds, ...photoIds],
    );
  }

  /**
   * Bounded, batched reply preview for a page of posts: at most `limit`
   * replies per post (oldest-first, matching `listReplies`'s own window),
   * resolved in ONE query for the whole page via a `ROW_NUMBER() OVER
   * (PARTITION BY post_id ...)` top-N-per-group — not `limit` separate
   * per-post queries, which would reintroduce the N+1 shape this file
   * otherwise avoids (see `nestjs-and-queries.md` rule 1). This is the fix for
   * the structural gap this service used to have: a post's `replies` used to
   * be `this.replies.find({ where: { postId } })` with no LIMIT at all — a
   * viral post's entire reply history rode along on every feed page it
   * appeared on. Blocked (either way) / muted authors are excluded IN-QUERY
   * (mirrors `listPosts`'s use of `excludeHidden`), so a post's preview fills
   * with `limit` visible replies instead of coming back short.
   *
   * `excludeModerationHidden` is opt-in (not folded in unconditionally) so
   * `buildPostDTO`'s mutation echo can keep its deliberate, pre-existing
   * choice to show the acting viewer every reply regardless of moderation
   * state, while `toPostDTOs`'s feed listing (which DOES need to withhold
   * hidden replies from non-staff) can ask for it. Pass `true` only when the
   * caller is about to withhold hidden rows anyway — mirrors `listReplies`'s
   * own `!viewerIsStaff` gate on `ContentModerationService.excludeHidden`.
   */
  private async topRepliesByPost(
    postIds: string[],
    viewerId: string,
    limit: number,
    excludeModerationHidden: boolean,
  ): Promise<Map<string, CommunityPostReply[]>> {
    const repliesByPost = new Map<string, CommunityPostReply[]>();
    if (!postIds.length) return repliesByPost;

    const rankedRows = await this.replies.manager
      .createQueryBuilder()
      .select('ranked.id', 'id')
      .addSelect('ranked."postId"', 'postId')
      .addSelect('ranked."authorId"', 'authorId')
      .addSelect('ranked.text', 'text')
      .addSelect('ranked."createdAt"', 'createdAt')
      .addSelect('ranked."editedAt"', 'editedAt')
      .addSelect('ranked."deletedAt"', 'deletedAt')
      .addSelect('ranked."deletedById"', 'deletedById')
      .from((subQuery) => {
        const inner = subQuery
          .select('r.id', 'id')
          .addSelect('r.post_id', 'postId')
          .addSelect('r.author_id', 'authorId')
          .addSelect('r.text', 'text')
          .addSelect('r.created_at', 'createdAt')
          .addSelect('r.edited_at', 'editedAt')
          .addSelect('r.deleted_at', 'deletedAt')
          .addSelect('r.deleted_by_id', 'deletedById')
          .addSelect(
            'ROW_NUMBER() OVER (PARTITION BY r.post_id ORDER BY r.created_at ASC, r.id ASC)',
            'rn',
          )
          .from(CommunityPostReply, 'r')
          .where('r.post_id IN (:...postIds)', { postIds });
        this.blockFilter.excludeHidden(inner, viewerId, '"r"."author_id"');
        if (excludeModerationHidden) {
          this.contentModeration.excludeHidden(
            inner,
            CommunityPostsService.SUBJECT_TYPES,
            '"r"."id"',
          );
        }
        return inner;
      }, 'ranked')
      .where('ranked.rn <= :limit', { limit })
      .orderBy('ranked."postId"', 'ASC')
      .addOrderBy('ranked."createdAt"', 'ASC')
      .getRawMany<{
        id: string;
        postId: string;
        authorId: string;
        text: string;
        createdAt: Date;
        editedAt: Date | null;
        deletedAt: Date | null;
        deletedById: string | null;
      }>();

    for (const row of rankedRows) {
      const reply: CommunityPostReply = {
        id: row.id,
        postId: row.postId,
        authorId: row.authorId,
        text: row.text,
        createdAt: new Date(row.createdAt),
        editedAt: row.editedAt ? new Date(row.editedAt) : null,
        deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
        deletedById: row.deletedById ?? null,
      };
      const list = repliesByPost.get(reply.postId);
      if (list) list.push(reply);
      else repliesByPost.set(reply.postId, [reply]);
    }
    return repliesByPost;
  }

  /**
   * The TRUE total reply count per post, independent of `topRepliesByPost`'s
   * bounded preview — so `CommunityPostDTO.replyCount` still reflects every
   * reply even though `replies` is capped. Same block/mute exclusion as the
   * preview and `listReplies`, so the count matches what a "load more" click
   * can actually page through, not a count of rows the viewer could never
   * reach anyway. Same moderation exclusion too (gated on `viewerIsStaff`,
   * exactly like `listReplies`'s own count via `paginate()`'s
   * `getManyAndCount()`) — otherwise a page of moderator-hidden replies would
   * inflate this count past what `listReplies` can ever actually return,
   * making "load more" appear when every remaining page is entirely hidden.
   */
  private async replyCountByPost(
    postIds: string[],
    viewerId: string,
    viewerIsStaff: boolean,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!postIds.length) return counts;

    const qb = this.replies
      .createQueryBuilder('r')
      .select('r.post_id', 'postId')
      .addSelect('COUNT(*)', 'count')
      .where('r.post_id IN (:...postIds)', { postIds })
      .groupBy('r.post_id');
    this.blockFilter.excludeHidden(qb, viewerId, '"r"."author_id"');
    if (!viewerIsStaff) {
      this.contentModeration.excludeHidden(
        qb,
        CommunityPostsService.SUBJECT_TYPES,
        '"r"."id"',
      );
    }

    const rows = await qb.getRawMany<{ postId: string; count: string }>();
    for (const row of rows) counts.set(row.postId, Number(row.count));
    return counts;
  }

  /**
   * Reaction summary data, batched AND bounded: an aggregate `COUNT` per
   * (post, key) instead of fetching every reaction row — a post with
   * thousands of reactions used to mean thousands of rows over the wire just
   * to compute 4 numbers. `mine` is resolved separately, scoped to the
   * viewer's own rows (at most 4 per post, per `UQ_community_post_reactions`)
   * rather than pulled out of the full row set.
   */
  private async reactionAggregatesByPost(
    postIds: string[],
    viewerId: string,
  ): Promise<Map<string, ReactionAggregate>> {
    const aggregatesByPost = new Map<string, ReactionAggregate>();
    if (!postIds.length) return aggregatesByPost;

    const aggregateFor = (postId: string): ReactionAggregate => {
      const existing = aggregatesByPost.get(postId);
      if (existing) return existing;
      const created: ReactionAggregate = {
        counts: new Map(),
        mine: new Set(),
      };
      aggregatesByPost.set(postId, created);
      return created;
    };

    const [countRows, mineRows] = await Promise.all([
      this.reactions
        .createQueryBuilder('rx')
        .select('rx.post_id', 'postId')
        .addSelect('rx.key', 'key')
        .addSelect('COUNT(*)', 'count')
        .where('rx.post_id IN (:...postIds)', { postIds })
        .groupBy('rx.post_id')
        .addGroupBy('rx.key')
        .getRawMany<{ postId: string; key: ReactionKey; count: string }>(),
      this.reactions.find({
        where: { postId: In(postIds), userId: viewerId },
        select: { postId: true, key: true },
      }),
    ]);

    for (const row of countRows) {
      aggregateFor(row.postId).counts.set(row.key, Number(row.count));
    }
    for (const row of mineRows) {
      aggregateFor(row.postId).mine.add(row.key);
    }
    return aggregatesByPost;
  }

  private async buildPostDTO(
    post: CommunityPost,
    viewerId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityPostDTO> {
    // `replyCount` still uses the viewer's real staff-ness (it drives the
    // client's "load more" trigger against `listReplies`, which DOES withhold
    // hidden replies from non-staff), even though the echoed `replies` preview
    // below deliberately does not (see the comment further down).
    const viewerIsStaff = CommunityPostsService.isStaffRole(viewerRole);
    const [repliesByPost, replyCountByPost, reactionsByPost] =
      await Promise.all([
        this.topRepliesByPost([post.id], viewerId, PAGE_SIZE, false),
        this.replyCountByPost([post.id], viewerId, viewerIsStaff),
        this.reactionAggregatesByPost([post.id], viewerId),
      ]);
    const replyRows = repliesByPost.get(post.id) ?? [];

    const authorIds = nonNullIds([
      post.authorId,
      ...replyRows.map((r) => r.authorId),
    ]);
    const [authors, states] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.moderationStatesFor(
        [post.id],
        replyRows.map((r) => r.id),
      ),
    ]);

    // This is a mutation echo (create/react/delete/restore returns the acted-on
    // post to the actor), so it reflects moderation state via the mappers but
    // does not drop hidden rows — the actor is operating on the post directly.
    const replies = replyRows.map((r) =>
      toCommunityReply(
        r,
        authorRefOf(authors, r.authorId),
        viewerId,
        viewerRole,
        states.get(r.id) ?? CommunityPostsService.VISIBLE,
      ),
    );
    return toCommunityPost(
      post,
      authorRefOf(authors, post.authorId),
      reactionsByPost.get(post.id) ?? { counts: new Map(), mine: new Set() },
      replies,
      replyCountByPost.get(post.id) ?? replies.length,
      viewerId,
      viewerRole,
      states.get(post.id) ?? CommunityPostsService.VISIBLE,
    );
  }

  // Batched mapping for a page of posts (`listPosts`): one query each for
  // reply previews/counts/reactions/authors across the whole page instead of
  // N+1 per-post lookups — mirrors `EventsService.summarize` /
  // `CommunitiesService.statsForMany`.
  private async toPostDTOs(
    rows: CommunityPost[],
    viewerId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityPostDTO[]> {
    if (!rows.length) return [];
    const postIds = rows.map((p) => p.id);
    const viewerIsStaff = CommunityPostsService.isStaffRole(viewerRole);

    const [repliesByPostPreview, replyCountByPost, reactionsByPost] =
      await Promise.all([
        // Fold moderation-hidden exclusion into the SQL window itself (when
        // non-staff) — post-filtering it afterward (as this used to) could
        // under-fill a post's reply preview below `PAGE_SIZE` even when
        // enough later-ranked visible replies existed to fill it.
        this.topRepliesByPost(postIds, viewerId, PAGE_SIZE, !viewerIsStaff),
        this.replyCountByPost(postIds, viewerId, viewerIsStaff),
        this.reactionAggregatesByPost(postIds, viewerId),
      ]);
    const allReplyRows = [...repliesByPostPreview.values()].flat();

    const states = await this.moderationStatesFor(
      postIds,
      allReplyRows.map((r) => r.id),
    );
    const isWithheld = (id: string): boolean => {
      const state = states.get(id);
      // Hidden-but-not-removed content is withheld from non-staff; removed
      // content stays (as a tombstone) for everyone.
      return !!state && state.hidden && !state.removed && !viewerIsStaff;
    };

    // Drop hidden posts from a member's feed entirely — pre-existing,
    // post-level pagination behavior; out of scope for this fix (the same
    // fixed-fetch-then-filter shape exists for `listPosts`'s own page/total,
    // untouched here).
    const visiblePosts = rows.filter((post) => !isWithheld(post.id));
    // Reply rows are already moderation-filtered in SQL by `topRepliesByPost`
    // above (when non-staff), so this is now harmless defense-in-depth, not
    // the primary filter.
    const replyRows = allReplyRows.filter((reply) => !isWithheld(reply.id));

    const repliesByPost = groupBy(replyRows, (r) => r.postId);

    const authorIds = new Set<string>();
    for (const p of visiblePosts) if (p.authorId) authorIds.add(p.authorId);
    for (const r of replyRows) if (r.authorId) authorIds.add(r.authorId);
    const authors = await new MemberLookup(this.profiles).byUserIds([
      ...authorIds,
    ]);

    return visiblePosts.map((post) => {
      const replies = (repliesByPost.get(post.id) ?? []).map((r) =>
        toCommunityReply(
          r,
          authorRefOf(authors, r.authorId),
          viewerId,
          viewerRole,
          states.get(r.id) ?? CommunityPostsService.VISIBLE,
        ),
      );
      return toCommunityPost(
        post,
        authorRefOf(authors, post.authorId),
        reactionsByPost.get(post.id) ?? { counts: new Map(), mine: new Set() },
        replies,
        replyCountByPost.get(post.id) ?? replies.length,
        viewerId,
        viewerRole,
        states.get(post.id) ?? CommunityPostsService.VISIBLE,
      );
    });
  }
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

/** Filters a batch of author ids down to the ones worth resolving via
 * `MemberLookup.byUserIds` — a `null` id (the author's account was erased,
 * per `CommunityPost.authorId`'s doc comment) never has a profile to look up,
 * so it's dropped here rather than passed through. */
function nonNullIds(ids: (string | null)[]): string[] {
  return ids.filter((id): id is string => id !== null);
}

/** Safe `Map<string, MemberRef>` lookup for a possibly-null author id: an
 * erased account's post/reply keeps its content but loses its author
 * reference (`CommunityPost.authorId`/`CommunityPostReply.authorId`), so
 * there's nothing to resolve — `null` in, `null` out, without needing every
 * call site to guard the `.get()` itself. */
function authorRefOf(
  authors: Map<string, MemberRef>,
  authorId: string | null,
): MemberRef | null {
  return authorId ? (authors.get(authorId) ?? null) : null;
}
