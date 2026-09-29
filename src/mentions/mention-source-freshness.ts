import { FindOptionsWhere, In, Repository } from 'typeorm';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { Message } from '../messaging/entities/message.entity';
import { MESSAGE_SUBJECT_TYPE } from '../messaging/message-visibility-predicates';
import { Notification } from '../notifications/entities/notification.entity';

/**
 * `content_moderation.subject_type` values a forum post, a community post and
 * a community reply can be taken down under, keyed by the row's uuid. The
 * same pair `ForumPostsService.SUBJECT_TYPES` and
 * `CommunityPostsService.SUBJECT_TYPES` hold (both are private to their
 * services, so it is repeated here; keep them in sync).
 */
const POST_MODERATION_SUBJECT_TYPES: readonly string[] = ['post', 'reply'];

/**
 * `content_moderation.subject_type` for a whole community, keyed by the
 * community's slug. The same value as `CommunitiesService.SUBJECT_TYPE`,
 * which is private to that service, so it is repeated here; keep them in
 * sync.
 */
const COMMUNITY_MODERATION_SUBJECT_TYPE = 'community';

/**
 * Postgres refuses a `uuid` comparison against a non-uuid literal with a
 * `22P02` error, which would fail the whole inbox page. A payload id that
 * cannot be a uuid is left out of every lookup, so its row reads as a source
 * that no longer resolves.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a mention's `excerpt` was copied from, read off the payload
 * `MentionNotificationService.notify` writes. Its callers write exactly these
 * shapes:
 *  - `ForumThreadsService` (opening post): `source: 'forum'` + `threadSlug`.
 *  - `ForumPostsService.reply`: `source: 'forum'` + `threadSlug` + `postId`.
 *  - `CommunityPostsService` posts (nested and flat): `source: 'community'`
 *    + `postId`, with `communitySlug` unless the post is global.
 *  - `CommunityPostsService` replies (nested and flat): the same plus
 *    `replyId`.
 *  - `MessagesService.sendMessage`: `source: 'message'` + `conversationId` +
 *    `messageId`.
 * Anything else is `unknown`, whose excerpt is never served.
 */
export type MentionSource =
  | { kind: 'forumThread'; threadSlug: string }
  | { kind: 'forumPost'; threadSlug: string | null; postId: string }
  | { kind: 'communityPost'; communitySlug: string | null; postId: string }
  | {
      kind: 'communityReply';
      communitySlug: string | null;
      postId: string;
      replyId: string;
    }
  | { kind: 'message'; messageId: string }
  | { kind: 'unknown' };

function payloadString(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value ? value : null;
}

function payloadUuid(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = payloadString(payload, key);
  return value && UUID_PATTERN.test(value) ? value : null;
}

export function mentionSourceOf(notification: Notification): MentionSource {
  const payload = notification.payload;
  const source = payloadString(payload, 'source');
  if (source === 'message') {
    const messageId = payloadUuid(payload, 'messageId');
    return messageId ? { kind: 'message', messageId } : { kind: 'unknown' };
  }
  if (source === 'forum') {
    const threadSlug = payloadString(payload, 'threadSlug');
    const postId = payloadUuid(payload, 'postId');
    if (postId) return { kind: 'forumPost', threadSlug, postId };
    // A `postId` that is present but cannot be a uuid names a reply this
    // check cannot look up. Reading it as the thread's opening post would
    // serve a reply's words on the strength of a different row.
    if (payloadString(payload, 'postId')) return { kind: 'unknown' };
    return threadSlug
      ? { kind: 'forumThread', threadSlug }
      : { kind: 'unknown' };
  }
  if (source === 'community') {
    const communitySlug = payloadString(payload, 'communitySlug');
    const postId = payloadUuid(payload, 'postId');
    const replyId = payloadUuid(payload, 'replyId');
    if (!postId) return { kind: 'unknown' };
    return replyId
      ? { kind: 'communityReply', communitySlug, postId, replyId }
      : { kind: 'communityPost', communitySlug, postId };
  }
  return { kind: 'unknown' };
}

/** The repositories the freshness check reads, one per source kind. */
export interface MentionSourceRepositories {
  forumPosts: Repository<ForumPost>;
  communityPosts: Repository<CommunityPost>;
  communityReplies: Repository<CommunityPostReply>;
  messages: Repository<Message>;
  /** Platform moderator takedowns (`hide_content` / `remove_content`). */
  contentModeration: Repository<ContentModeration>;
}

/** The threads and communities the page names, as the caller resolved them. */
export interface MentionSourceContext {
  /** Threads a member can still read (standing, and either never sent to
   *  review or approved), by slug, with their id for the opening-post
   *  lookup. */
  readableThreadIdBySlug: Map<string, string>;
  /** Communities on the page that are archived, and so read as gone. */
  archivedCommunitySlugs: Set<string>;
  /** Each space on the page whose parent is present and unarchived, keyed by
   *  the space's slug, with the parent's slug. The parent's slug joins the
   *  page's takedown lookup, and a parent taken down makes the space read as
   *  gone, the same gate `CommunitiesService.assertParentViewable` and the
   *  shared `assertCommunityInteriorReadable`
   *  (`communities/community-read-gate.ts`) hold. */
  parentSlugBySpaceSlug: Map<string, string>;
  /** Spaces on the page whose parent is archived or did not load, which read
   *  as gone (the other two cases `assertParentViewable` and
   *  `assertCommunityInteriorReadable` answer with a 404). */
  spaceSlugsWithUnviewableParent: Set<string>;
}

interface SourceRowState {
  deletedAt: Date | null;
  editedAt: Date | null;
}

function editedAfter(editedAt: Date | null, writtenAt: Date): boolean {
  return !!editedAt && new Date(editedAt).getTime() > writtenAt.getTime();
}

/** Live and unchanged since the mention was written. */
function isUnchanged(
  state: SourceRowState | undefined,
  writtenAt: Date,
): boolean {
  return !!state && !state.deletedAt && !editedAfter(state.editedAt, writtenAt);
}

/** The live sources and communities a platform moderator hid or removed. */
interface TakenDownSourceIds {
  /** Forum posts, community posts and community replies. */
  posts: Set<string>;
  messages: Set<string>;
  /** Community slugs a platform moderator took down as a whole. */
  communitySlugs: Set<string>;
}

/**
 * A platform moderator's `hide_content` or `remove_content` writes a
 * `content_moderation` row and leaves the source row itself untouched (no
 * `deletedAt`, no `editedAt`), so the columns above never see it. One query
 * covers every live source the page found and every community the page
 * names, plus the parent of every space among them (a whole-community
 * takedown reads like an archive: nothing said in it, or in its spaces, is
 * served). Any row with a hide or a removal counts, including a hide
 * that staff can still read: the excerpt is served to a member, and a member
 * is shown neither.
 */
async function takenDownSourceIdsOf(
  repository: Repository<ContentModeration>,
  postIds: string[],
  messageIds: string[],
  communitySlugs: string[],
): Promise<TakenDownSourceIds> {
  const takenDown: TakenDownSourceIds = {
    posts: new Set<string>(),
    messages: new Set<string>(),
    communitySlugs: new Set<string>(),
  };
  const where: FindOptionsWhere<ContentModeration>[] = [
    ...(postIds.length
      ? [
          {
            subjectType: In([...POST_MODERATION_SUBJECT_TYPES]),
            subjectId: In(postIds),
          },
        ]
      : []),
    ...(messageIds.length
      ? [{ subjectType: MESSAGE_SUBJECT_TYPE, subjectId: In(messageIds) }]
      : []),
    ...(communitySlugs.length
      ? [
          {
            subjectType: COMMUNITY_MODERATION_SUBJECT_TYPE,
            subjectId: In(communitySlugs),
          },
        ]
      : []),
  ];
  if (!where.length) return takenDown;
  const moderationRows = await repository.find({
    where,
    select: {
      subjectType: true,
      subjectId: true,
      hiddenAt: true,
      removedAt: true,
    },
  });
  for (const moderationRow of moderationRows) {
    if (!moderationRow.hiddenAt && !moderationRow.removedAt) continue;
    if (moderationRow.subjectType === MESSAGE_SUBJECT_TYPE) {
      takenDown.messages.add(moderationRow.subjectId);
    } else if (
      moderationRow.subjectType === COMMUNITY_MODERATION_SUBJECT_TYPE
    ) {
      takenDown.communitySlugs.add(moderationRow.subjectId);
    } else {
      takenDown.posts.add(moderationRow.subjectId);
    }
  }
  return takenDown;
}

/**
 * ENG-411: the ids of the page's mention rows whose frozen `excerpt` must not
 * be served, because the words it copied are gone or have changed. The
 * excerpt is written once, at mention time, and no delete, edit, delete for
 * everyone or moderator takedown ever rewrites the notification row, so the
 * inbox and the data export check the source on every read (both through
 * `staleMentionExcerptIds`):
 *  - forum: the thread is withdrawn or held back by review, or the post (the
 *    opening post, for a mention in a new thread) is tombstoned or edited;
 *  - community: the community is archived or taken down as a whole by a
 *    platform moderator, for a space its parent community is archived,
 *    taken down or no longer loads, the post is tombstoned or edited,
 *    or, for a reply, the parent post is tombstoned or the reply itself is
 *    tombstoned or edited;
 *  - message: the message is deleted for everyone (its `@DeleteDateColumn`
 *    keeps it out of the lookup) or edited;
 *  - any kind: a platform moderator hid or removed the post, the reply, a
 *    reply's parent post or the message (`content_moderation`, read through
 *    `takenDownSourceIdsOf`);
 *  - an unrecognised or incomplete payload: never served.
 * An edit counts when `editedAt` is later than the row's `createdAt` (mention
 * rows never bundle, so that is the moment the excerpt was copied).
 *
 * One query per source kind for the whole page, whatever its size: forum
 * posts and opening posts share one, community posts (including every
 * reply's parent) one, replies one, messages one. A kind the page does not
 * contain costs nothing. One more query reads the moderator takedowns of
 * every source those lookups found, of every community the page names and
 * of every loaded parent of a space among them, and is skipped when there is
 * none of these.
 */
export async function mentionIdsWithStaleExcerpt(
  rows: Notification[],
  context: MentionSourceContext,
  repositories: MentionSourceRepositories,
): Promise<Set<string>> {
  const sources = rows.map((row) => ({ row, source: mentionSourceOf(row) }));

  const forumPostIds = new Set<string>();
  const openingThreadIds = new Set<string>();
  const communityPostIds = new Set<string>();
  const communityReplyIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const { source } of sources) {
    switch (source.kind) {
      case 'forumPost':
        forumPostIds.add(source.postId);
        break;
      case 'forumThread': {
        const threadId = context.readableThreadIdBySlug.get(source.threadSlug);
        if (threadId) openingThreadIds.add(threadId);
        break;
      }
      case 'communityPost':
        communityPostIds.add(source.postId);
        break;
      case 'communityReply':
        communityPostIds.add(source.postId);
        communityReplyIds.add(source.replyId);
        break;
      case 'message':
        messageIds.add(source.messageId);
        break;
      case 'unknown':
        break;
    }
  }

  const forumWhere: FindOptionsWhere<ForumPost>[] = [
    ...(forumPostIds.size ? [{ id: In([...forumPostIds]) }] : []),
    ...(openingThreadIds.size
      ? [{ threadId: In([...openingThreadIds]), isOp: true }]
      : []),
  ];
  const [forumPosts, communityPosts, communityReplies, messages] =
    await Promise.all([
      forumWhere.length
        ? repositories.forumPosts.find({
            where: forumWhere,
            select: {
              id: true,
              threadId: true,
              isOp: true,
              deletedAt: true,
              editedAt: true,
            },
          })
        : Promise.resolve([] as ForumPost[]),
      communityPostIds.size
        ? repositories.communityPosts.find({
            where: { id: In([...communityPostIds]) },
            select: { id: true, deletedAt: true, editedAt: true },
          })
        : Promise.resolve([] as CommunityPost[]),
      communityReplyIds.size
        ? repositories.communityReplies.find({
            where: { id: In([...communityReplyIds]) },
            select: { id: true, deletedAt: true, editedAt: true },
          })
        : Promise.resolve([] as CommunityPostReply[]),
      messageIds.size
        ? repositories.messages.find({
            where: { id: In([...messageIds]) },
            select: { id: true, deletedAt: true, editedAt: true },
          })
        : Promise.resolve([] as Message[]),
    ]);

  const forumPostById = new Map(forumPosts.map((post) => [post.id, post]));
  const openingPostByThreadId = new Map(
    forumPosts.filter((post) => post.isOp).map((post) => [post.threadId, post]),
  );
  const communityPostById = new Map(
    communityPosts.map((post) => [post.id, post]),
  );
  const communityReplyById = new Map(
    communityReplies.map((reply) => [reply.id, reply]),
  );
  const messageById = new Map(messages.map((message) => [message.id, message]));

  // Every community a community mention on the page names, looked up even
  // when none of its posts resolved, and the parent of each space among them.
  const pageCommunitySlugs = new Set<string>();
  for (const { source } of sources) {
    if (
      (source.kind === 'communityPost' || source.kind === 'communityReply') &&
      source.communitySlug
    ) {
      pageCommunitySlugs.add(source.communitySlug);
      const parentSlug = context.parentSlugBySpaceSlug.get(
        source.communitySlug,
      );
      if (parentSlug) pageCommunitySlugs.add(parentSlug);
    }
  }
  const takenDown = await takenDownSourceIdsOf(
    repositories.contentModeration,
    [
      ...forumPosts.map((post) => post.id),
      ...communityPosts.map((post) => post.id),
      ...communityReplies.map((reply) => reply.id),
    ],
    messages.map((message) => message.id),
    [...pageCommunitySlugs],
  );
  const isPostStanding = (postId: string | undefined): boolean =>
    !!postId && !takenDown.posts.has(postId);

  const isThreadReadable = (threadSlug: string | null): boolean =>
    !threadSlug || context.readableThreadIdBySlug.has(threadSlug);
  const isCommunityLive = (communitySlug: string | null): boolean => {
    if (!communitySlug) return true;
    if (
      context.archivedCommunitySlugs.has(communitySlug) ||
      takenDown.communitySlugs.has(communitySlug) ||
      context.spaceSlugsWithUnviewableParent.has(communitySlug)
    ) {
      return false;
    }
    const parentSlug = context.parentSlugBySpaceSlug.get(communitySlug);
    return !parentSlug || !takenDown.communitySlugs.has(parentSlug);
  };

  const staleIds = new Set<string>();
  for (const { row, source } of sources) {
    const writtenAt = new Date(row.createdAt);
    let isFresh = false;
    switch (source.kind) {
      case 'forumPost':
        isFresh =
          isThreadReadable(source.threadSlug) &&
          isPostStanding(source.postId) &&
          isUnchanged(forumPostById.get(source.postId), writtenAt);
        break;
      case 'forumThread': {
        const threadId = context.readableThreadIdBySlug.get(source.threadSlug);
        const openingPost = threadId
          ? openingPostByThreadId.get(threadId)
          : undefined;
        isFresh =
          isPostStanding(openingPost?.id) &&
          isUnchanged(openingPost, writtenAt);
        break;
      }
      case 'communityPost':
        isFresh =
          isCommunityLive(source.communitySlug) &&
          isPostStanding(source.postId) &&
          isUnchanged(communityPostById.get(source.postId), writtenAt);
        break;
      case 'communityReply': {
        const parentPost = communityPostById.get(source.postId);
        isFresh =
          isCommunityLive(source.communitySlug) &&
          !!parentPost &&
          !parentPost.deletedAt &&
          isPostStanding(source.postId) &&
          isPostStanding(source.replyId) &&
          isUnchanged(communityReplyById.get(source.replyId), writtenAt);
        break;
      }
      case 'message': {
        const message = messageById.get(source.messageId);
        isFresh =
          !!message &&
          !takenDown.messages.has(source.messageId) &&
          isUnchanged(
            {
              deletedAt: message.deletedAt ?? null,
              editedAt: message.editedAt,
            },
            writtenAt,
          );
        break;
      }
      case 'unknown':
        isFresh = false;
        break;
    }
    if (!isFresh) staleIds.add(row.id);
  }
  return staleIds;
}
