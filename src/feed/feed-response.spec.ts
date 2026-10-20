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

const STUDIO_ORIGINS = ['https://queerpulse.test'];
const STUDIO_TRACK_ID = '0f8a3c2e-5b1d-4e6f-9a7b-1c2d3e4f5a6b';

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
      const item = communityPostToFeedItem(
        basePost(),
        null,
        author,
        STUDIO_ORIGINS,
      );

      expect(item.title).toBe('');
      expect(item.link).toBe('/feed');
      expect(item.studioLink).toBeNull();
    });
  });

  describe('communityPostToFeedItem Studio link (Studio rich cards)', () => {
    it('carries the canonical path of the first Studio link and leaves it out of the summary', () => {
      const item = communityPostToFeedItem(
        basePost({
          body: `New one from Lua https://queerpulse.test/studio/track?id=${STUDIO_TRACK_ID.toUpperCase()}&t=42`,
        }),
        null,
        author,
        STUDIO_ORIGINS,
      );

      expect(item.studioLink).toBe(`/studio/track?id=${STUDIO_TRACK_ID}&t=42`);
      expect(item.summary).toBe('New one from Lua');
    });

    it('reads a markdown-wrapped Studio link as its label in the summary', () => {
      const item = communityPostToFeedItem(
        basePost({
          body: `listen to [the EP](https://queerpulse.test/studio/album?id=${STUDIO_TRACK_ID}) tonight`,
        }),
        null,
        author,
        STUDIO_ORIGINS,
      );

      expect(item.studioLink).toBe(`/studio/album?id=${STUDIO_TRACK_ID}`);
      expect(item.summary).toBe('listen to the EP tonight');
    });

    it('finds a link that sits past the 220 character summary window', () => {
      const item = communityPostToFeedItem(
        basePost({
          body: `${'a'.repeat(300)}\nhttps://queerpulse.test/studio/album?id=${STUDIO_TRACK_ID}`,
        }),
        null,
        author,
        STUDIO_ORIGINS,
      );

      expect(item.studioLink).toBe(`/studio/album?id=${STUDIO_TRACK_ID}`);
      expect(item.summary).toHaveLength(220);
      expect(item.summary).not.toContain('studio');
    });

    it('reads a root-relative Studio path', () => {
      const item = communityPostToFeedItem(
        basePost({ body: `/studio/collection?id=${STUDIO_TRACK_ID}` }),
        null,
        author,
        STUDIO_ORIGINS,
      );

      expect(item.studioLink).toBe(`/studio/collection?id=${STUDIO_TRACK_ID}`);
      expect(item.summary).toBe('');
    });

    it('keeps a Studio path on another host as plain text', () => {
      const body = `look https://elsewhere.example/studio/track?id=${STUDIO_TRACK_ID}`;
      const item = communityPostToFeedItem(
        basePost({ body }),
        null,
        author,
        STUDIO_ORIGINS,
      );

      expect(item.studioLink).toBeNull();
      expect(item.summary).toBe(body);
    });

    it('keeps a preview link as plain text', () => {
      const body = `early mix https://queerpulse.test/studio/preview/${'b'.repeat(43)}`;
      const item = communityPostToFeedItem(
        basePost({ body }),
        null,
        author,
        STUDIO_ORIGINS,
      );

      expect(item.studioLink).toBeNull();
      expect(item.summary).toBe(body);
    });

    it('blanks the Studio link and the summary of a tombstoned post', () => {
      const item = communityPostToFeedItem(
        basePost({
          body: `https://queerpulse.test/studio/track?id=${STUDIO_TRACK_ID}`,
          deletedAt: new Date('2026-07-11T00:00:00.000Z'),
        }),
        null,
        author,
        STUDIO_ORIGINS,
      );

      expect(item.studioLink).toBeNull();
      expect(item.summary).toBe('');
    });

    it('sets no Studio link on a forum thread', () => {
      expect(forumThreadToFeedItem(baseThread(), author).studioLink).toBeNull();
    });
  });
});
