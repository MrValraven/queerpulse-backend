import { MemberRef } from '../common/member-ref';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import {
  communityPostToFeedItem,
  forumThreadToFeedItem,
} from './feed-response';

// Only the columns the two mappers read. The cast keeps each fixture to the
// fields a test is about; `feed.service.spec.ts` carries the full rows.
const baseThread = (overrides: Partial<ForumThread> = {}): ForumThread =>
  ({
    id: 'thread-1',
    slug: 'hello-world',
    title: 'Hello world',
    authorId: 'author-1',
    category: 'support',
    isOfficial: false,
    isAnonymous: false,
    contentWarnings: [],
    replyCount: 2,
    opVoteCount: 0,
    createdAt: new Date('2026-07-09T00:00:00.000Z'),
    ...overrides,
  }) as ForumThread;

const basePost = (overrides: Partial<CommunityPost> = {}): CommunityPost =>
  ({
    id: 'post-1',
    communityId: null,
    authorId: 'author-1',
    body: 'Hello from a flat post',
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    ...overrides,
  }) as CommunityPost;

const author: MemberRef = {
  slug: 'ava',
  firstName: 'Ava',
  lastName: 'Lee',
  pronouns: 'she/her',
  avatarUrl: null,
};

describe('feed-response mappers', () => {
  describe('forumThreadToFeedItem', () => {
    it('maps an anonymous thread to a null actor with bylineMask anonymous', () => {
      const item = forumThreadToFeedItem(
        baseThread({ isAnonymous: true }),
        author,
      );

      expect(item.actor).toBeNull();
      expect(item.bylineMask).toBe('anonymous');
    });

    it('official wins over anonymous', () => {
      const item = forumThreadToFeedItem(
        baseThread({ isAnonymous: true, isOfficial: true }),
        author,
      );

      expect(item.actor).toBeNull();
      expect(item.bylineMask).toBe('official');
    });

    it('keeps the author and a null bylineMask on an ordinary thread', () => {
      const item = forumThreadToFeedItem(baseThread(), author);

      expect(item.actor).toMatchObject({
        handle: 'ava',
        displayName: 'Ava Lee',
      });
      expect(item.bylineMask).toBeNull();
    });

    it('carries contentWarnings and category', () => {
      const item = forumThreadToFeedItem(
        baseThread({ contentWarnings: ['grief', 'violence'] }),
        author,
        {
          excerpt: 'A hard week.',
          replyCount: 1,
          opPostId: 'op-1',
          opVoteCount: 0,
          hasViewerVoted: false,
        },
      );

      expect(item.contentWarnings).toEqual(['grief', 'violence']);
      expect(item.category).toBe('support');
      // Kept for clients that still read the English line.
      expect(item.summary).toBe('support · 1 reply');
    });

    it('carries the like state off the card (FEED-LIKE)', () => {
      const item = forumThreadToFeedItem(baseThread(), author, {
        excerpt: 'A hard week.',
        replyCount: 1,
        opPostId: 'op-1',
        opVoteCount: 5,
        hasViewerVoted: true,
      });

      expect(item.opPostId).toBe('op-1');
      expect(item.reactionCount).toBe(5);
      expect(item.myReaction).toBe('like');
    });

    it('has no like affordance without a card, falling back to the stored vote count', () => {
      const item = forumThreadToFeedItem(
        baseThread({ opVoteCount: 3 }),
        author,
      );

      expect(item.opPostId).toBeNull();
      expect(item.reactionCount).toBe(3);
      expect(item.myReaction).toBeNull();
    });
  });

  describe('communityPostToFeedItem', () => {
    it('a flat community post has an empty title', () => {
      const item = communityPostToFeedItem(basePost(), null, author);

      expect(item.title).toBe('');
      expect(item.link).toBe('/feed');
    });
  });
});
