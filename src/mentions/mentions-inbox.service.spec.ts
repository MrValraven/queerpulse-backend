import { FindOperator } from 'typeorm';
import type { FindManyOptions, FindOptionsWhere } from 'typeorm';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { visibleThroughMailboxSeatRules } from '../notifications/notification-mailbox-block';
import { visibleThroughActorBlocks } from '../notifications/notification-actor-block';
import { NOTIFICATION_STATE_CHANGED } from '../notifications/notification.events';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { Community } from '../communities/entities/community.entity';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { Message } from '../messaging/entities/message.entity';
import { MentionsInboxService } from './mentions-inbox.service';

const now = new Date('2026-08-05T10:00:00.000Z');
const beforeMention = new Date('2026-08-05T09:00:00.000Z');
const afterMention = new Date('2026-08-05T11:00:00.000Z');

// Payload ids the freshness check looks up must look like uuids.
const POST_ID = '11111111-1111-4111-8111-111111111111';
const REPLY_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const THREAD_ID = '44444444-4444-4444-8444-444444444444';

function mentionRow(
  id: string,
  payload: Record<string, unknown> = {},
): Notification {
  return {
    id,
    userId: 'me',
    type: NotificationType.Mention,
    read: false,
    createdAt: now,
    payload,
    bundleKey: null,
    otherActorCount: 0,
  };
}

function build() {
  const notifications = {
    find: jest
      .fn<Promise<Notification[]>, [FindManyOptions<Notification>]>()
      .mockResolvedValue([]),
    count: jest
      .fn<Promise<number>, [FindManyOptions<Notification>]>()
      .mockResolvedValue(0),
    // The service reads only `affected` off `update`'s result (to decide
    // whether to announce the change), so the mock resolves just that field.
    update: jest
      .fn<
        Promise<{ affected?: number }>,
        [FindOptionsWhere<Notification>, Partial<Notification>]
      >()
      .mockResolvedValue({ affected: 1 }),
  };
  const eventEmitter = { emit: jest.fn() };
  const profiles = { find: jest.fn().mockResolvedValue([]) };
  const threads = { find: jest.fn().mockResolvedValue([]) };
  const communities = { find: jest.fn().mockResolvedValue([]) };
  // ENG-411: the source repositories the excerpt freshness check reads,
  // reached through the DataSource.
  const forumPosts = { find: jest.fn().mockResolvedValue([]) };
  const communityPosts = { find: jest.fn().mockResolvedValue([]) };
  const communityReplies = { find: jest.fn().mockResolvedValue([]) };
  const messages = { find: jest.fn().mockResolvedValue([]) };
  // Platform moderator takedowns (`hide_content` / `remove_content`), which
  // leave the source row itself untouched.
  const contentModeration = { find: jest.fn().mockResolvedValue([]) };
  // The parents of the spaces on the page, read through the DataSource.
  const parentCommunities = { find: jest.fn().mockResolvedValue([]) };
  const repositoryByEntity = new Map<unknown, unknown>([
    [ForumPost, forumPosts],
    [CommunityPost, communityPosts],
    [CommunityPostReply, communityReplies],
    [Message, messages],
    [ContentModeration, contentModeration],
    [Community, parentCommunities],
  ]);
  const dataSource = {
    getRepository: jest.fn((entity: unknown) => repositoryByEntity.get(entity)),
  };

  const service = new MentionsInboxService(
    notifications as never,
    profiles as never,
    threads as never,
    communities as never,
    dataSource as never,
    eventEmitter as never,
  );
  return {
    service,
    notifications,
    eventEmitter,
    profiles,
    threads,
    communities,
    forumPosts,
    communityPosts,
    communityReplies,
    messages,
    contentModeration,
    parentCommunities,
  };
}

describe('MentionsInboxService', () => {
  describe('list', () => {
    it('scopes to the caller and to Mention rows, with the canonical page envelope', async () => {
      const { service, notifications } = build();
      notifications.find.mockResolvedValue([mentionRow('n1')]);
      notifications.count.mockResolvedValue(1);

      const result = await service.list('me', { page: 2 });

      // `service.list` always calls `notifications.find` exactly once above.
      const findArgs = notifications.find.mock.calls[0]![0];
      // Task 13g: plus the mailbox block visibility condition on `payload`.
      // PRD-403: plus the actor block condition on `id`.
      expect(findArgs.where).toEqual({
        userId: 'me',
        type: NotificationType.Mention,
        id: expect.any(FindOperator),
        payload: expect.any(FindOperator),
      });
      expect(findArgs.order).toEqual({ createdAt: 'DESC', id: 'DESC' });
      expect(findArgs.skip).toBe(20); // (page 2 - 1) * PAGE_SIZE
      expect(findArgs.take).toBe(20);
      expect(result).toMatchObject({ total: 1, page: 2, pageSize: 20 });
      expect(result.items).toHaveLength(1);
    });

    it('adds the unread predicate only when requested', async () => {
      const { service, notifications } = build();

      await service.list('me', { unread: true });

      expect(notifications.find.mock.calls[0]![0].where).toEqual({
        userId: 'me',
        type: NotificationType.Mention,
        id: expect.any(FindOperator),
        read: false,
        payload: expect.any(FindOperator),
      });
    });

    it('normalises an absent/invalid page to 1', async () => {
      const { service, notifications } = build();

      const result = await service.list('me', {});

      expect(notifications.find.mock.calls[0]![0].skip).toBe(0);
      expect(result.page).toBe(1);
    });

    it('enriches actors/threads/communities in one batched query each', async () => {
      const { service, notifications, profiles, threads, communities } =
        build();
      notifications.find.mockResolvedValue([
        mentionRow('n1', {
          actorId: 'actor-1',
          source: 'forum',
          threadSlug: 'welcome',
        }),
        mentionRow('n2', {
          actorId: 'actor-1', // duplicate actor -> deduped in the IN list
          source: 'community',
          communitySlug: 'pride',
        }),
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: 'actor-1',
          slug: 'ada',
          firstName: 'Ada',
          lastName: 'L',
          avatarUrl: null,
        },
      ]);
      threads.find.mockResolvedValue([
        { slug: 'welcome', title: 'Welcome', reviewState: null },
      ]);
      communities.find.mockResolvedValue([{ slug: 'pride', name: 'Pride' }]);

      const result = await service.list('me', {});

      expect(profiles.find).toHaveBeenCalledTimes(1);
      expect(threads.find).toHaveBeenCalledTimes(1);
      expect(communities.find).toHaveBeenCalledTimes(1);
      expect(result.items[0]!.actor?.slug).toBe('ada');
      expect(result.items[0]!.sourceLabel).toBe('Welcome');
      expect(result.items[1]!.sourceLabel).toBe('Pride');
    });

    it('skips enrichment queries entirely when the page has no such refs', async () => {
      const {
        service,
        notifications,
        profiles,
        threads,
        communities,
        forumPosts,
        communityPosts,
        communityReplies,
        messages,
      } = build();
      notifications.find.mockResolvedValue([mentionRow('n1', {})]);

      await service.list('me', {});

      expect(profiles.find).not.toHaveBeenCalled();
      expect(threads.find).not.toHaveBeenCalled();
      expect(communities.find).not.toHaveBeenCalled();
      expect(forumPosts.find).not.toHaveBeenCalled();
      expect(communityPosts.find).not.toHaveBeenCalled();
      expect(communityReplies.find).not.toHaveBeenCalled();
      expect(messages.find).not.toHaveBeenCalled();
    });

    it('serves the actor avatar only while the actor shows their photo (ENG-412)', async () => {
      const { service, notifications, profiles } = build();
      notifications.find.mockResolvedValue([
        mentionRow('n1', { actorId: 'actor-1' }),
        mentionRow('n2', { actorId: 'actor-2' }),
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: 'actor-1',
          slug: 'ada',
          firstName: 'Ada',
          lastName: 'L',
          avatarUrl: 'https://lh3.googleusercontent.com/a/ada.png',
          photoVisible: true,
        },
        {
          userId: 'actor-2',
          slug: 'bea',
          firstName: 'Bea',
          lastName: 'M',
          avatarUrl: 'https://lh3.googleusercontent.com/a/bea.png',
          photoVisible: false,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.actor?.avatarUrl).toBe(
        'https://lh3.googleusercontent.com/a/ada.png',
      );
      expect(result.items[1]!.actor).toEqual({
        slug: 'bea',
        firstName: 'Bea',
        lastName: 'M',
        avatarUrl: null,
      });
    });

    it('puts the actor block condition on the page and on its total (PRD-403)', async () => {
      const { service, notifications } = build();

      await service.list('me', {});

      const expectedCondition = visibleThroughActorBlocks('me');
      const pageCondition = (
        notifications.find.mock.calls[0]![0].where as {
          id: FindOperator<unknown>;
        }
      ).id;
      const totalCondition = (
        notifications.count.mock.calls[0]![0].where as {
          id: FindOperator<unknown>;
        }
      ).id;
      for (const condition of [pageCondition, totalCondition]) {
        expect(condition.getSql?.('Notification.id')).toBe(
          expectedCondition.getSql?.('Notification.id'),
        );
        expect(condition.objectLiteralParameters).toEqual({
          actorBlockReaderUserId: 'me',
        });
      }
      expect(notifications.update).not.toHaveBeenCalled();
    });
  });

  // ENG-411: the excerpt is frozen into the row at mention time, so every
  // read checks its source and serves it empty once the words are gone or
  // changed.
  describe('excerpt freshness', () => {
    const forumReplyRow = mentionRow('n-forum', {
      source: 'forum',
      threadSlug: 'welcome',
      postId: POST_ID,
      excerpt: 'forum words',
    });
    const readableThread = {
      id: THREAD_ID,
      slug: 'welcome',
      title: 'Welcome',
      reviewState: null,
    };

    it('keeps the excerpt of a live, unedited forum reply', async () => {
      const { service, notifications, threads, forumPosts } = build();
      notifications.find.mockResolvedValue([forumReplyRow]);
      threads.find.mockResolvedValue([readableThread]);
      forumPosts.find.mockResolvedValue([
        {
          id: POST_ID,
          threadId: THREAD_ID,
          isOp: false,
          deletedAt: null,
          editedAt: beforeMention,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('forum words');
    });

    it('drops the excerpt of a forum reply its author deleted or a moderator took down', async () => {
      const { service, notifications, threads, forumPosts } = build();
      notifications.find.mockResolvedValue([forumReplyRow]);
      threads.find.mockResolvedValue([readableThread]);
      forumPosts.find.mockResolvedValue([
        {
          id: POST_ID,
          threadId: THREAD_ID,
          isOp: false,
          deletedAt: afterMention,
          editedAt: null,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');
    });

    it('drops the excerpt of a forum reply edited after the mention', async () => {
      const { service, notifications, threads, forumPosts } = build();
      notifications.find.mockResolvedValue([forumReplyRow]);
      threads.find.mockResolvedValue([readableThread]);
      forumPosts.find.mockResolvedValue([
        {
          id: POST_ID,
          threadId: THREAD_ID,
          isOp: false,
          deletedAt: null,
          editedAt: afterMention,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');
    });

    it('drops the excerpt and the title of a withdrawn thread', async () => {
      const { service, notifications, threads, forumPosts } = build();
      notifications.find.mockResolvedValue([forumReplyRow]);
      // The `deletedAt: IsNull()` filter leaves a withdrawn thread out.
      threads.find.mockResolvedValue([]);
      forumPosts.find.mockResolvedValue([
        {
          id: POST_ID,
          threadId: THREAD_ID,
          isOp: false,
          deletedAt: null,
          editedAt: null,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');
      expect(result.items[0]!.sourceLabel).toBeNull();
    });

    it('drops the excerpt of a thread held back by review', async () => {
      const { service, notifications, threads, forumPosts } = build();
      notifications.find.mockResolvedValue([forumReplyRow]);
      threads.find.mockResolvedValue([
        { ...readableThread, reviewState: 'rejected' },
      ]);
      forumPosts.find.mockResolvedValue([
        {
          id: POST_ID,
          threadId: THREAD_ID,
          isOp: false,
          deletedAt: null,
          editedAt: null,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');
    });

    it('names a thread only while its review state lets the member read it', async () => {
      const { service, notifications, threads } = build();
      const forumRow = (id: string, threadSlug: string) =>
        mentionRow(id, { source: 'forum', threadSlug, excerpt: 'words' });
      notifications.find.mockResolvedValue([
        forumRow('n-rejected', 'rejected-thread'),
        forumRow('n-pending', 'pending-thread'),
        forumRow('n-approved', 'approved-thread'),
        forumRow('n-never-reviewed', 'welcome'),
      ]);
      // The mention was written while each thread was readable; two of them
      // have since moved to rejected or pending.
      threads.find.mockResolvedValue([
        {
          id: '12121212-1212-4121-8121-121212121212',
          slug: 'rejected-thread',
          title: 'Rejected',
          reviewState: 'rejected',
        },
        {
          id: '13131313-1313-4131-8131-131313131313',
          slug: 'pending-thread',
          title: 'Pending',
          reviewState: 'pending',
        },
        {
          id: '14141414-1414-4141-8141-141414141414',
          slug: 'approved-thread',
          title: 'Approved',
          reviewState: 'approved',
        },
        readableThread,
      ]);

      const result = await service.list('me', {});

      expect(result.items.map((item) => item.sourceLabel)).toEqual([
        null,
        null,
        'Approved',
        'Welcome',
      ]);
    });

    it("checks a new thread's opening post: kept while unedited, dropped once edited", async () => {
      const { service, notifications, threads, forumPosts } = build();
      notifications.find.mockResolvedValue([
        mentionRow('n-live', {
          source: 'forum',
          threadSlug: 'welcome',
          excerpt: 'opening words',
        }),
        mentionRow('n-edited', {
          source: 'forum',
          threadSlug: 'edited-thread',
          excerpt: 'old opening words',
        }),
      ]);
      const editedThreadId = '55555555-5555-4555-8555-555555555555';
      threads.find.mockResolvedValue([
        readableThread,
        {
          id: editedThreadId,
          slug: 'edited-thread',
          title: 'Edited',
          reviewState: 'approved',
        },
      ]);
      forumPosts.find.mockResolvedValue([
        {
          id: 'op-1',
          threadId: THREAD_ID,
          isOp: true,
          deletedAt: null,
          editedAt: null,
        },
        {
          id: 'op-2',
          threadId: editedThreadId,
          isOp: true,
          deletedAt: null,
          editedAt: afterMention,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('opening words');
      expect(result.items[1]!.excerpt).toBe('');
    });

    it('drops the excerpt of a community post a moderator took down', async () => {
      const { service, notifications, communityPosts } = build();
      notifications.find.mockResolvedValue([
        mentionRow('n1', {
          source: 'community',
          communitySlug: 'pride',
          postId: POST_ID,
          excerpt: 'post words',
        }),
      ]);
      communityPosts.find.mockResolvedValue([
        { id: POST_ID, deletedAt: afterMention, editedAt: null },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');
    });

    it('keeps a live community reply and drops one whose reply or parent post is gone', async () => {
      const { service, notifications, communityPosts, communityReplies } =
        build();
      const deletedParentId = '66666666-6666-4666-8666-666666666666';
      const deletedReplyId = '77777777-7777-4777-8777-777777777777';
      notifications.find.mockResolvedValue([
        mentionRow('n-live', {
          source: 'community',
          communitySlug: 'pride',
          postId: POST_ID,
          replyId: REPLY_ID,
          excerpt: 'reply words',
        }),
        mentionRow('n-parent-gone', {
          source: 'community',
          communitySlug: 'pride',
          postId: deletedParentId,
          replyId: REPLY_ID,
          excerpt: 'reply under a removed post',
        }),
        mentionRow('n-reply-gone', {
          source: 'community',
          communitySlug: 'pride',
          postId: POST_ID,
          replyId: deletedReplyId,
          excerpt: 'deleted reply words',
        }),
      ]);
      communityPosts.find.mockResolvedValue([
        { id: POST_ID, deletedAt: null, editedAt: afterMention },
        { id: deletedParentId, deletedAt: afterMention, editedAt: null },
      ]);
      communityReplies.find.mockResolvedValue([
        { id: REPLY_ID, deletedAt: null, editedAt: null },
        { id: deletedReplyId, deletedAt: afterMention, editedAt: null },
      ]);

      const result = await service.list('me', {});

      // An edit to the parent post leaves the reply's own words intact.
      expect(result.items[0]!.excerpt).toBe('reply words');
      expect(result.items[1]!.excerpt).toBe('');
      expect(result.items[2]!.excerpt).toBe('');
    });

    it('drops the excerpt of a post in an archived community', async () => {
      const { service, notifications, communities, communityPosts } = build();
      notifications.find.mockResolvedValue([
        mentionRow('n1', {
          source: 'community',
          communitySlug: 'pride',
          postId: POST_ID,
          excerpt: 'post words',
        }),
      ]);
      communities.find.mockResolvedValue([
        { slug: 'pride', name: 'Pride', archivedAt: afterMention },
      ]);
      communityPosts.find.mockResolvedValue([
        { id: POST_ID, deletedAt: null, editedAt: null },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');
    });

    it('keeps a live message, and drops one deleted for everyone or edited', async () => {
      const { service, notifications, messages } = build();
      const deletedMessageId = '88888888-8888-4888-8888-888888888888';
      const editedMessageId = '99999999-9999-4999-8999-999999999999';
      const messageRow = (id: string, messageId: string) =>
        mentionRow(id, {
          source: 'message',
          conversationId: 'c1',
          messageId,
          excerpt: `words of ${id}`,
        });
      notifications.find.mockResolvedValue([
        messageRow('n-live', MESSAGE_ID),
        messageRow('n-deleted', deletedMessageId),
        messageRow('n-edited', editedMessageId),
      ]);
      // A message deleted for everyone carries `deletedAt`, which the
      // `@DeleteDateColumn` keeps out of the lookup, so it never comes back.
      messages.find.mockResolvedValue([
        { id: MESSAGE_ID, deletedAt: null, editedAt: null },
        { id: editedMessageId, deletedAt: null, editedAt: afterMention },
      ]);

      const result = await service.list('me', {});

      expect(result.items.map((item) => item.excerpt)).toEqual([
        'words of n-live',
        '',
        '',
      ]);
    });

    it('drops the excerpt of a forum reply a platform moderator hid, and of a community post one removed', async () => {
      const {
        service,
        notifications,
        threads,
        forumPosts,
        communityPosts,
        contentModeration,
      } = build();
      const removedPostId = '55555555-5555-4555-8555-555555555555';
      notifications.find.mockResolvedValue([
        forumReplyRow,
        mentionRow('n-post', {
          source: 'community',
          communitySlug: 'pride',
          postId: removedPostId,
          excerpt: 'post words',
        }),
      ]);
      threads.find.mockResolvedValue([readableThread]);
      // Both rows are live and unedited: only `content_moderation` knows.
      forumPosts.find.mockResolvedValue([
        {
          id: POST_ID,
          threadId: THREAD_ID,
          isOp: false,
          deletedAt: null,
          editedAt: null,
        },
      ]);
      communityPosts.find.mockResolvedValue([
        { id: removedPostId, deletedAt: null, editedAt: null },
      ]);
      contentModeration.find.mockResolvedValue([
        {
          subjectType: 'reply',
          subjectId: POST_ID,
          hiddenAt: afterMention,
          removedAt: null,
        },
        {
          subjectType: 'post',
          subjectId: removedPostId,
          hiddenAt: afterMention,
          removedAt: afterMention,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items.map((item) => item.excerpt)).toEqual(['', '']);
    });

    it('drops the excerpt of a community reply whose parent post a platform moderator hid', async () => {
      const {
        service,
        notifications,
        communityPosts,
        communityReplies,
        contentModeration,
      } = build();
      notifications.find.mockResolvedValue([
        mentionRow('n-reply', {
          source: 'community',
          communitySlug: 'pride',
          postId: POST_ID,
          replyId: REPLY_ID,
          excerpt: 'reply words',
        }),
      ]);
      communityPosts.find.mockResolvedValue([
        { id: POST_ID, deletedAt: null, editedAt: null },
      ]);
      communityReplies.find.mockResolvedValue([
        { id: REPLY_ID, deletedAt: null, editedAt: null },
      ]);
      contentModeration.find.mockResolvedValue([
        {
          subjectType: 'post',
          subjectId: POST_ID,
          hiddenAt: afterMention,
          removedAt: null,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');
    });

    it('drops the excerpt of a message a platform moderator took down, and keeps an untouched one', async () => {
      const { service, notifications, messages, contentModeration } = build();
      const takenDownMessageId = '99999999-9999-4999-8999-999999999999';
      const messageRow = (id: string, messageId: string) =>
        mentionRow(id, {
          source: 'message',
          conversationId: 'c1',
          messageId,
          excerpt: `words of ${id}`,
        });
      notifications.find.mockResolvedValue([
        messageRow('n-live', MESSAGE_ID),
        messageRow('n-taken-down', takenDownMessageId),
      ]);
      messages.find.mockResolvedValue([
        { id: MESSAGE_ID, deletedAt: null, editedAt: null },
        { id: takenDownMessageId, deletedAt: null, editedAt: null },
      ]);
      contentModeration.find.mockResolvedValue([
        {
          subjectType: 'message',
          subjectId: takenDownMessageId,
          hiddenAt: afterMention,
          removedAt: null,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items.map((item) => item.excerpt)).toEqual([
        'words of n-live',
        '',
      ]);
    });

    it('drops the excerpt of a live post in a community a platform moderator took down, and looks its slug up even when no post resolved', async () => {
      const { service, notifications, communityPosts, contentModeration } =
        build();
      const unresolvedPostId = '55555555-5555-4555-8555-555555555555';
      notifications.find.mockResolvedValue([
        mentionRow('n-live-post', {
          source: 'community',
          communitySlug: 'taken-down',
          postId: POST_ID,
          excerpt: 'post words',
        }),
      ]);
      communityPosts.find.mockResolvedValue([
        { id: POST_ID, deletedAt: null, editedAt: null },
      ]);
      contentModeration.find.mockResolvedValue([
        {
          subjectType: 'community',
          subjectId: 'taken-down',
          hiddenAt: afterMention,
          removedAt: null,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');

      contentModeration.find.mockClear();
      communityPosts.find.mockResolvedValue([]);
      notifications.find.mockResolvedValue([
        mentionRow('n-unresolved', {
          source: 'community',
          communitySlug: 'pride',
          postId: unresolvedPostId,
          excerpt: 'post words',
        }),
      ]);

      await service.list('me', {});

      const [moderationFindOptions] = contentModeration.find.mock.calls[0] as [
        { where: unknown },
      ];
      expect(moderationFindOptions.where).toEqual([
        { subjectType: 'community', subjectId: expect.any(FindOperator) },
      ]);
    });

    describe('a mention in a space', () => {
      const PARENT_ID = '66666666-6666-4666-8666-666666666666';
      const spaceRow = mentionRow('n-space', {
        source: 'community',
        communitySlug: 'pride-book-club',
        postId: POST_ID,
        excerpt: 'space words',
      });
      const liveSpace = {
        slug: 'pride-book-club',
        name: 'Book club',
        archivedAt: null,
        parentId: PARENT_ID,
      };
      const liveParent = { id: PARENT_ID, slug: 'pride', archivedAt: null };

      function buildSpacePage() {
        const built = build();
        built.notifications.find.mockResolvedValue([spaceRow]);
        built.communities.find.mockResolvedValue([liveSpace]);
        built.communityPosts.find.mockResolvedValue([
          { id: POST_ID, deletedAt: null, editedAt: null },
        ]);
        return built;
      }

      it('drops the excerpt of a live post while the parent community is taken down, and keeps it once the parent is restored', async () => {
        const { service, contentModeration, parentCommunities } =
          buildSpacePage();
        parentCommunities.find.mockResolvedValue([liveParent]);
        contentModeration.find.mockResolvedValue([
          {
            subjectType: 'community',
            subjectId: 'pride',
            hiddenAt: afterMention,
            removedAt: null,
          },
        ]);

        const takenDownResult = await service.list('me', {});

        expect(takenDownResult.items[0]!.excerpt).toBe('');

        // Restoring clears the hide and the removal and keeps the row.
        contentModeration.find.mockResolvedValue([
          {
            subjectType: 'community',
            subjectId: 'pride',
            hiddenAt: null,
            removedAt: null,
          },
        ]);

        const restoredResult = await service.list('me', {});

        expect(restoredResult.items[0]!.excerpt).toBe('space words');
      });

      it("reads the parent once by id and puts its slug beside the space's in the one takedown lookup", async () => {
        const { service, contentModeration, parentCommunities } =
          buildSpacePage();
        parentCommunities.find.mockResolvedValue([liveParent]);

        await service.list('me', {});

        expect(parentCommunities.find).toHaveBeenCalledTimes(1);
        expect(parentCommunities.find).toHaveBeenCalledWith({
          where: { id: expect.any(FindOperator) },
          select: { id: true, slug: true, archivedAt: true },
        });
        const [parentFindOptions] = parentCommunities.find.mock.calls[0] as [
          { where: { id: FindOperator<string[]> } },
        ];
        expect(parentFindOptions.where.id.value).toEqual([PARENT_ID]);

        expect(contentModeration.find).toHaveBeenCalledTimes(1);
        const [moderationFindOptions] = contentModeration.find.mock
          .calls[0] as [
          {
            where: Array<{
              subjectType: unknown;
              subjectId: FindOperator<string[]>;
            }>;
          },
        ];
        const communityArm = moderationFindOptions.where.find(
          (arm) => arm.subjectType === 'community',
        );
        expect([...communityArm!.subjectId.value].sort()).toEqual([
          'pride',
          'pride-book-club',
        ]);
      });

      it('drops the excerpt of a live post whose parent community is archived', async () => {
        const { service, parentCommunities } = buildSpacePage();
        parentCommunities.find.mockResolvedValue([
          { ...liveParent, archivedAt: afterMention },
        ]);

        const result = await service.list('me', {});

        expect(result.items[0]!.excerpt).toBe('');
      });

      it('drops the excerpt of a live post whose parent community does not load', async () => {
        const { service, parentCommunities } = buildSpacePage();
        parentCommunities.find.mockResolvedValue([]);

        const result = await service.list('me', {});

        expect(result.items[0]!.excerpt).toBe('');
      });

      it('keeps the excerpt of a live post in a space whose parent is live and standing', async () => {
        const { service, parentCommunities } = buildSpacePage();
        parentCommunities.find.mockResolvedValue([liveParent]);

        const result = await service.list('me', {});

        expect(result.items[0]!.excerpt).toBe('space words');
      });

      it('reads no parent when the page names no space', async () => {
        const { service, notifications, communities, parentCommunities } =
          build();
        notifications.find.mockResolvedValue([
          mentionRow('n-top-level', {
            source: 'community',
            communitySlug: 'pride',
            postId: POST_ID,
            excerpt: 'post words',
          }),
        ]);
        communities.find.mockResolvedValue([
          { slug: 'pride', name: 'Pride', archivedAt: null, parentId: null },
        ]);

        await service.list('me', {});

        expect(parentCommunities.find).not.toHaveBeenCalled();
      });

      it("selects each community's parentId for the label lookup, so a space is known as one", async () => {
        const { service, communities } = buildSpacePage();

        await service.list('me', {});

        const [communityFindOptions] = communities.find.mock.calls[0] as [
          { select: Record<string, boolean> },
        ];
        expect(communityFindOptions.select).toMatchObject({
          slug: true,
          archivedAt: true,
          parentId: true,
        });
      });
    });

    it('reads every takedown for the page in one lookup, and none when no source resolved', async () => {
      const {
        service,
        notifications,
        communityPosts,
        messages,
        contentModeration,
      } = build();
      notifications.find.mockResolvedValue([
        mentionRow('n-post', {
          source: 'community',
          communitySlug: 'pride',
          postId: POST_ID,
          excerpt: 'post words',
        }),
        mentionRow('n-message', {
          source: 'message',
          messageId: MESSAGE_ID,
          excerpt: 'message words',
        }),
      ]);
      communityPosts.find.mockResolvedValue([
        { id: POST_ID, deletedAt: null, editedAt: null },
      ]);
      messages.find.mockResolvedValue([
        { id: MESSAGE_ID, deletedAt: null, editedAt: null },
      ]);

      await service.list('me', {});

      expect(contentModeration.find).toHaveBeenCalledTimes(1);
      const [moderationFindOptions] = contentModeration.find.mock.calls[0] as [
        { where: unknown },
      ];
      expect(moderationFindOptions.where).toEqual([
        {
          subjectType: expect.any(FindOperator),
          subjectId: expect.any(FindOperator),
        },
        { subjectType: 'message', subjectId: expect.any(FindOperator) },
        { subjectType: 'community', subjectId: expect.any(FindOperator) },
      ]);

      contentModeration.find.mockClear();
      notifications.find.mockResolvedValue([
        mentionRow('n-orphan', { excerpt: 'orphaned words' }),
      ]);

      await service.list('me', {});

      expect(contentModeration.find).not.toHaveBeenCalled();
    });

    it('never serves the excerpt of a payload with no resolvable source', async () => {
      const { service, notifications } = build();
      notifications.find.mockResolvedValue([
        mentionRow('n1', { excerpt: 'orphaned words' }),
        mentionRow('n2', {
          source: 'message',
          messageId: 'not-a-uuid',
          excerpt: 'unverifiable words',
        }),
      ]);

      const result = await service.list('me', {});

      expect(result.items.map((item) => item.excerpt)).toEqual(['', '']);
    });

    it('drops the excerpt of a forum mention whose postId is present but malformed', async () => {
      const { service, notifications, threads, forumPosts } = build();
      notifications.find.mockResolvedValue([
        mentionRow('n1', {
          source: 'forum',
          threadSlug: 'welcome',
          postId: 'not-a-uuid',
          excerpt: 'reply words',
        }),
      ]);
      threads.find.mockResolvedValue([readableThread]);
      // A live, unedited opening post: reading the row as a thread mention
      // would have served the reply's words on the strength of this row.
      forumPosts.find.mockResolvedValue([
        {
          id: 'op-1',
          threadId: THREAD_ID,
          isOp: true,
          deletedAt: null,
          editedAt: null,
        },
      ]);

      const result = await service.list('me', {});

      expect(result.items[0]!.excerpt).toBe('');
      expect(forumPosts.find).not.toHaveBeenCalled();
    });

    it('looks each source kind up once per page, however many rows name it', async () => {
      const {
        service,
        notifications,
        threads,
        forumPosts,
        communityPosts,
        communityReplies,
        messages,
      } = build();
      notifications.find.mockResolvedValue([
        forumReplyRow,
        mentionRow('n-thread', { source: 'forum', threadSlug: 'welcome' }),
        mentionRow('n-post', {
          source: 'community',
          communitySlug: 'pride',
          postId: POST_ID,
        }),
        mentionRow('n-reply', {
          source: 'community',
          communitySlug: 'pride',
          postId: POST_ID,
          replyId: REPLY_ID,
        }),
        mentionRow('n-message-1', { source: 'message', messageId: MESSAGE_ID }),
        mentionRow('n-message-2', { source: 'message', messageId: MESSAGE_ID }),
      ]);
      threads.find.mockResolvedValue([readableThread]);

      await service.list('me', {});

      expect(forumPosts.find).toHaveBeenCalledTimes(1);
      expect(communityPosts.find).toHaveBeenCalledTimes(1);
      expect(communityReplies.find).toHaveBeenCalledTimes(1);
      expect(messages.find).toHaveBeenCalledTimes(1);
      const [forumFindOptions] = forumPosts.find.mock.calls[0] as [
        { where: unknown },
      ];
      expect(forumFindOptions.where).toEqual([
        { id: expect.any(FindOperator) },
        { threadId: expect.any(FindOperator), isOp: true },
      ]);
    });
  });

  describe('markAllRead', () => {
    it('marks read scoped to Mention only, never other categories', async () => {
      const { service, notifications } = build();

      const result = await service.markAllRead('me');

      const [criteria, patch] = notifications.update.mock.calls[0]!;
      expect(criteria).toMatchObject({
        userId: 'me',
        type: NotificationType.Mention,
        read: false,
      });
      expect(patch).toEqual({ read: true });
      expect(result).toEqual({ ok: true });
    });

    it('composes the same actor block filter list uses, on the id column (PRD-403)', async () => {
      const { service, notifications } = build();

      await service.markAllRead('me');

      const [criteria] = notifications.update.mock.calls[0]!;
      const idCondition = (criteria as { id: FindOperator<unknown> }).id;
      const expectedCondition = visibleThroughActorBlocks('me');
      expect(idCondition).toBeInstanceOf(FindOperator);
      expect(idCondition.getSql?.('id')).toBe(expectedCondition.getSql?.('id'));
      expect(idCondition.objectLiteralParameters).toEqual(
        expectedCondition.objectLiteralParameters,
      );
    });

    // CW-22: without this filter, a mention a mailbox block currently hides
    // from `list` still got marked read here, so lifting the block later
    // resurfaced a row the member never actually saw, already marked read.
    it('composes the same mailbox block visibility filter list uses, on the payload column', async () => {
      const { service, notifications } = build();

      await service.markAllRead('me');

      const [criteria] = notifications.update.mock.calls[0]!;
      const payloadCondition = (criteria as { payload: FindOperator<unknown> })
        .payload;
      const expectedCondition = visibleThroughMailboxSeatRules('me');
      expect(payloadCondition).toBeInstanceOf(FindOperator);
      expect(payloadCondition.getSql?.('Notification.payload')).toBe(
        expectedCondition.getSql?.('Notification.payload'),
      );
      expect(payloadCondition.objectLiteralParameters).toEqual(
        expectedCondition.objectLiteralParameters,
      );
    });

    // The chat gateway relays this as `notification:changed`, so the
    // member's other tabs and devices refetch their bell.
    it('announces the change when mentions were marked read', async () => {
      const { service, eventEmitter } = build();

      await service.markAllRead('me');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NOTIFICATION_STATE_CHANGED,
        { userId: 'me' },
      );
    });

    it('stays silent when there was nothing unread', async () => {
      const { service, notifications, eventEmitter } = build();
      notifications.update.mockResolvedValue({ affected: 0 });

      await service.markAllRead('me');

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
