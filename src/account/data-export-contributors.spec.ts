import { DataSource, FindOperator, Repository } from 'typeorm';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { EventMatchEntry } from '../go-together/entities/event-match-entry.entity';
import { FriendMatchProfile } from '../go-together/entities/friend-match-profile.entity';
import { MatchAvoidance } from '../go-together/entities/match-avoidance.entity';
import { MatchFeedback } from '../go-together/entities/match-feedback.entity';
import { MatchGroupFeedback } from '../go-together/entities/match-group-feedback.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import { MyCardsService } from '../membership-cards/my-cards.service';
import { Message } from '../messaging/entities/message.entity';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import {
  EXPORT_KEPT_ACTOR_TYPES,
  EXPORT_WITHHELD_TEXT_KEYS,
  GoTogetherExportContributor,
  ListingsExportContributor,
  MembershipCardsExportContributor,
  NotificationsExportContributor,
} from './data-export-contributors';

describe('ListingsExportContributor', () => {
  const listingRow = (overrides: Partial<Listing>): Listing =>
    ({
      id: 'listing-1',
      ref: 'QPL-2026-0001',
      slug: 'lux-cafe',
      name: 'Lux Café',
      status: ListingStatus.Live,
      ownerId: 'user-1',
      suggestedByUserId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }) as Listing;

  it('reads the listings the member owns and the ones they suggested', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const contributor = new ListingsExportContributor({
      find,
    } as unknown as Repository<Listing>);

    await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: [{ ownerId: 'user-1' }, { suggestedByUserId: 'user-1' }],
      order: { createdAt: 'ASC' },
    });
  });

  it('marks each row as owned or suggested by the member', async () => {
    const find = jest.fn().mockResolvedValue([
      listingRow({ id: 'owned-listing', ownerId: 'user-1' }),
      listingRow({
        id: 'held-suggestion',
        ownerId: null,
        suggestedByUserId: 'user-1',
      }),
      listingRow({
        id: 'claimed-suggestion',
        ownerId: 'claimant-1',
        suggestedByUserId: 'user-1',
      }),
    ]);
    const contributor = new ListingsExportContributor({
      find,
    } as unknown as Repository<Listing>);

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      expect.objectContaining({ id: 'owned-listing', relationship: 'owner' }),
      expect.objectContaining({
        id: 'held-suggestion',
        relationship: 'suggested',
      }),
      expect.objectContaining({
        id: 'claimed-suggestion',
        relationship: 'suggested',
      }),
    ]);
  });

  it('reports a listing the member both suggested and now owns as owned', async () => {
    const find = jest
      .fn()
      .mockResolvedValue([
        listingRow({ ownerId: 'user-1', suggestedByUserId: 'user-1' }),
      ]);
    const contributor = new ListingsExportContributor({
      find,
    } as unknown as Repository<Listing>);

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      expect.objectContaining({ relationship: 'owner' }),
    ]);
  });
});

describe('MembershipCardsExportContributor', () => {
  it('registers under the membershipCards category/archive key', () => {
    const myCards = { forUser: jest.fn() } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);
    expect(contributor.category).toBe('membershipCards');
    expect(contributor.archiveKey).toBe('membershipCards');
  });

  it("includes the caller's membership cards, delegating to MyCardsService.forUser", async () => {
    const cards = [
      {
        id: 'card-1',
        serial: 'AQ-7K4M2',
        status: 'active',
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        communityName: 'Azores Queer',
        communitySlug: 'azores-queer',
        role: 'member',
        holderName: 'Anika Kovač',
        program: {
          isEnabled: true,
          skin: 'plum',
          accentToken: 'accent',
          crestUrl: null,
          cardName: 'Sócie',
          validityMonths: null,
          allowsPrint: false,
          allowsWallet: false,
          allowsPublicBadge: true,
          serialPrefix: 'AQ',
        },
      },
    ];
    const forUser = jest.fn().mockResolvedValue(cards);
    const myCards = { forUser } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);

    const result = await contributor.buildContribution('user-1');

    expect(forUser).toHaveBeenCalledWith('user-1');
    expect(result).toEqual([
      expect.objectContaining({
        serial: 'AQ-7K4M2',
        communitySlug: 'azores-queer',
      }),
    ]);
  });

  it('returns an empty archive for a member holding no cards', async () => {
    const myCards = {
      forUser: jest.fn().mockResolvedValue([]),
    } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);

    await expect(contributor.buildContribution('user-2')).resolves.toEqual([]);
  });
});

describe('GoTogetherExportContributor', () => {
  const USER_ID = 'user-1';

  function build(overrides: {
    profile?: FriendMatchProfile | null;
    entries?: EventMatchEntry[];
    given?: MatchFeedback[];
    groupAnswers?: MatchGroupFeedback[];
    avoided?: MatchAvoidance[];
  }) {
    const findOneProfile = jest
      .fn()
      .mockResolvedValue(overrides.profile ?? null);
    const findEntries = jest.fn().mockResolvedValue(overrides.entries ?? []);
    const findFeedback = jest.fn().mockResolvedValue(overrides.given ?? []);
    const findGroupFeedback = jest
      .fn()
      .mockResolvedValue(overrides.groupAnswers ?? []);
    const findAvoidances = jest.fn().mockResolvedValue(overrides.avoided ?? []);
    const contributor = new GoTogetherExportContributor(
      { findOne: findOneProfile } as unknown as Repository<FriendMatchProfile>,
      { find: findEntries } as unknown as Repository<EventMatchEntry>,
      { find: findFeedback } as unknown as Repository<MatchFeedback>,
      { find: findGroupFeedback } as unknown as Repository<MatchGroupFeedback>,
      { find: findAvoidances } as unknown as Repository<MatchAvoidance>,
    );
    return {
      contributor,
      findOneProfile,
      findEntries,
      findFeedback,
      findGroupFeedback,
      findAvoidances,
    };
  }

  it('registers under the goTogether category and go-together archive key', () => {
    const { contributor } = build({});
    expect(contributor.category).toBe('goTogether');
    expect(contributor.archiveKey).toBe('go-together');
  });

  it('reads only rows keyed to the requesting member', async () => {
    const {
      contributor,
      findOneProfile,
      findEntries,
      findFeedback,
      findGroupFeedback,
      findAvoidances,
    } = build({});

    await contributor.buildContribution(USER_ID);

    expect(findOneProfile).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(findEntries).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      order: { createdAt: 'ASC' },
    });
    expect(findFeedback).toHaveBeenCalledWith({
      where: { raterId: USER_ID },
      order: { createdAt: 'ASC' },
    });
    expect(findGroupFeedback).toHaveBeenCalledWith({
      where: { raterId: USER_ID },
      order: { createdAt: 'ASC' },
    });
    expect(findAvoidances).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      order: { createdAt: 'ASC' },
    });
  });

  it('returns the questionnaire as null when the member never filled one in', async () => {
    const { contributor } = build({ profile: null });

    const result = (await contributor.buildContribution(USER_ID)) as {
      questionnaire: unknown;
    };

    expect(result.questionnaire).toBeNull();
  });

  it('includes the questionnaire answers and consent timestamp when a profile exists', async () => {
    const profile = {
      userId: USER_ID,
      answers: { area: 'Arroios' },
      questionnaireVersion: 3,
      consentedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    } as unknown as FriendMatchProfile;
    const { contributor } = build({ profile });

    const result = (await contributor.buildContribution(USER_ID)) as {
      questionnaire: unknown;
    };

    expect(result.questionnaire).toEqual({
      answers: { area: 'Arroios' },
      questionnaireVersion: 3,
      consentedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('maps each opt-in with lensConsentedAt, checkedInAt and leftEventAt', async () => {
    const entry = {
      eventId: 'event-1',
      status: 'grouped',
      pairStatus: 'accepted',
      lens: 'exclude',
      lensConsentedAt: new Date('2026-02-01T00:00:00.000Z'),
      hostAnswers: { q1: 'answer' },
      groupId: 'group-1',
      checkedInAt: new Date('2026-02-02T18:00:00.000Z'),
      leftEventAt: new Date('2026-02-02T22:00:00.000Z'),
      createdAt: new Date('2026-01-15T00:00:00.000Z'),
    } as unknown as EventMatchEntry;
    const { contributor } = build({ entries: [entry] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      optIns: unknown[];
    };

    expect(result.optIns).toEqual([
      {
        eventId: 'event-1',
        status: 'grouped',
        pairStatus: 'accepted',
        lens: 'exclude',
        lensConsentedAt: '2026-02-01T00:00:00.000Z',
        hostAnswers: { q1: 'answer' },
        groupId: 'group-1',
        checkedInAt: '2026-02-02T18:00:00.000Z',
        leftEventAt: '2026-02-02T22:00:00.000Z',
        createdAt: '2026-01-15T00:00:00.000Z',
      },
    ]);
  });

  it('maps an opt-in that was never checked in or left as null timestamps', async () => {
    const entry = {
      eventId: 'event-1',
      status: 'waiting',
      pairStatus: 'none',
      lens: null,
      lensConsentedAt: null,
      hostAnswers: {},
      groupId: null,
      checkedInAt: null,
      leftEventAt: null,
      createdAt: new Date('2026-01-15T00:00:00.000Z'),
    } as unknown as EventMatchEntry;
    const { contributor } = build({ entries: [entry] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      optIns: Array<{
        lensConsentedAt: unknown;
        checkedInAt: unknown;
        leftEventAt: unknown;
      }>;
    };

    expect(result.optIns[0]).toMatchObject({
      lensConsentedAt: null,
      checkedInAt: null,
      leftEventAt: null,
    });
  });

  it('lists the meet-again verdicts this member gave, attributed to the other person', async () => {
    const given = {
      groupId: 'group-1',
      raterId: USER_ID,
      rateeId: 'user-other',
      verdict: 'yes',
      createdAt: new Date('2026-02-03T00:00:00.000Z'),
      updatedAt: new Date('2026-02-03T00:00:00.000Z'),
    } as unknown as MatchFeedback;
    const { contributor, findFeedback } = build({ given: [given] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      meetAgainAnswersGiven: unknown[];
    };

    expect(findFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ where: { raterId: USER_ID } }),
    );
    expect(result.meetAgainAnswersGiven).toEqual([
      {
        groupId: 'group-1',
        aboutUserId: 'user-other',
        verdict: 'yes',
        updatedAt: '2026-02-03T00:00:00.000Z',
      },
    ]);
  });

  it('lists the group-as-a-whole answers this member gave', async () => {
    const groupAnswer = {
      groupId: 'group-1',
      raterId: USER_ID,
      clicked: 'yes',
      goAgain: true,
      createdAt: new Date('2026-02-04T00:00:00.000Z'),
      updatedAt: new Date('2026-02-04T00:00:00.000Z'),
    } as unknown as MatchGroupFeedback;
    const { contributor } = build({ groupAnswers: [groupAnswer] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      groupAnswersGiven: unknown[];
    };

    expect(result.groupAnswersGiven).toEqual([
      {
        groupId: 'group-1',
        clicked: 'yes',
        goAgain: true,
        updatedAt: '2026-02-04T00:00:00.000Z',
      },
    ]);
  });

  it('lists the "Not for me" avoidances this member set', async () => {
    const avoided = {
      userId: USER_ID,
      avoidedUserId: 'user-avoided',
      createdAt: new Date('2026-02-05T00:00:00.000Z'),
    } as unknown as MatchAvoidance;
    const { contributor } = build({ avoided: [avoided] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      notForMe: unknown[];
    };

    expect(result.notForMe).toEqual([
      { userId: 'user-avoided', createdAt: '2026-02-05T00:00:00.000Z' },
    ]);
  });
});

// ENG-411: the export carries each notification's stored payload, and a
// mention's payload holds an `excerpt` copied from someone else's words at
// mention time. The export blanks it through the same check the mentions
// inbox uses, and leaves the rest of the payload as stored.
describe('NotificationsExportContributor', () => {
  const USER_ID = 'user-1';
  const mentionedAt = new Date('2026-08-05T10:00:00.000Z');
  const afterMention = new Date('2026-08-05T11:00:00.000Z');
  const LIVE_MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
  const DELETED_MESSAGE_ID = '88888888-8888-4888-8888-888888888888';
  const EDITED_POST_ID = '11111111-1111-4111-8111-111111111111';
  const REJECTED_THREAD_ID = '44444444-4444-4444-8444-444444444444';

  const notificationRow = (
    id: string,
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Notification => ({
    id,
    userId: USER_ID,
    type,
    payload,
    read: true,
    createdAt: mentionedAt,
    bundleKey: null,
    otherActorCount: 0,
  });

  const messageMention = (id: string, messageId: string) =>
    notificationRow(id, NotificationType.Mention, {
      source: 'message',
      conversationId: 'c1',
      messageId,
      actorId: 'actor-1',
      excerpt: `words of ${id}`,
    });

  function build(rows: Notification[]) {
    const notificationsFind = jest.fn().mockResolvedValue(rows);
    const threads = { find: jest.fn().mockResolvedValue([]) };
    const communities = { find: jest.fn().mockResolvedValue([]) };
    const forumPosts = { find: jest.fn().mockResolvedValue([]) };
    const communityPosts = { find: jest.fn().mockResolvedValue([]) };
    const communityReplies = { find: jest.fn().mockResolvedValue([]) };
    const messages = { find: jest.fn().mockResolvedValue([]) };
    const contentModeration = { find: jest.fn().mockResolvedValue([]) };
    const repositoryByEntity = new Map<unknown, unknown>([
      [ForumThread, threads],
      [Community, communities],
      [ForumPost, forumPosts],
      [CommunityPost, communityPosts],
      [CommunityPostReply, communityReplies],
      [Message, messages],
      [ContentModeration, contentModeration],
    ]);
    const dataSource = {
      getRepository: (entity: unknown) => repositoryByEntity.get(entity),
    };
    const contributor = new NotificationsExportContributor(
      { find: notificationsFind } as unknown as Repository<Notification>,
      dataSource as unknown as DataSource,
    );
    return {
      contributor,
      threads,
      communities,
      forumPosts,
      communityPosts,
      communityReplies,
      messages,
      contentModeration,
    };
  }

  it('blanks the excerpt of a mention whose source is gone, edited or unreadable, and keeps the rest of its payload', async () => {
    const { contributor, threads, communityPosts, messages } = build([
      messageMention('n-live', LIVE_MESSAGE_ID),
      messageMention('n-deleted', DELETED_MESSAGE_ID),
      notificationRow('n-edited-post', NotificationType.Mention, {
        source: 'community',
        postId: EDITED_POST_ID,
        excerpt: 'post words before the edit',
      }),
      notificationRow('n-rejected-thread', NotificationType.Mention, {
        source: 'forum',
        threadSlug: 'rejected-thread',
        excerpt: 'opening words',
      }),
    ]);
    // A message deleted for everyone never comes back from the lookup.
    messages.find.mockResolvedValue([
      { id: LIVE_MESSAGE_ID, deletedAt: null, editedAt: null },
    ]);
    communityPosts.find.mockResolvedValue([
      { id: EDITED_POST_ID, deletedAt: null, editedAt: afterMention },
    ]);
    threads.find.mockResolvedValue([
      {
        id: REJECTED_THREAD_ID,
        slug: 'rejected-thread',
        reviewState: 'rejected',
      },
    ]);

    const exported = (await contributor.buildContribution(USER_ID)) as Array<{
      id: string;
      payload: Record<string, unknown>;
    }>;

    expect(exported.map((row) => row.payload.excerpt)).toEqual([
      'words of n-live',
      '',
      '',
      '',
    ]);
    expect(exported[1]!.payload).toEqual({
      source: 'message',
      conversationId: 'c1',
      messageId: DELETED_MESSAGE_ID,
      actorId: 'actor-1',
      excerpt: '',
    });
    expect(JSON.stringify(exported)).not.toContain('words of n-deleted');
  });

  it('reads threads with the withdrawn ones left out, and communities with their archive date and parent', async () => {
    const { contributor, threads, communities } = build([
      notificationRow('n-thread', NotificationType.Mention, {
        source: 'forum',
        threadSlug: 'welcome',
        excerpt: 'opening words',
      }),
      notificationRow('n-post', NotificationType.Mention, {
        source: 'community',
        communitySlug: 'pride',
        postId: EDITED_POST_ID,
        excerpt: 'post words',
      }),
    ]);

    await contributor.buildContribution(USER_ID);

    expect(threads.find).toHaveBeenCalledWith({
      where: {
        slug: expect.any(FindOperator),
        deletedAt: expect.any(FindOperator),
      },
      select: { id: true, slug: true, reviewState: true },
    });
    expect(communities.find).toHaveBeenCalledWith({
      where: { slug: expect.any(FindOperator) },
      select: { slug: true, archivedAt: true, parentId: true },
    });
    // The mock answers no rows, so no space is known and no parent is read.
    expect(communities.find).toHaveBeenCalledTimes(1);
  });

  it('lets a type with nothing withheld travel as stored, and looks nothing up for it', async () => {
    const forumReplyPayload = {
      source: 'forum',
      threadSlug: 'welcome',
      postId: EDITED_POST_ID,
      actorId: 'actor-1',
    };
    const {
      contributor,
      threads,
      communities,
      forumPosts,
      communityPosts,
      communityReplies,
      messages,
      contentModeration,
    } = build([
      notificationRow(
        'n-reply',
        NotificationType.ForumReply,
        forumReplyPayload,
      ),
    ]);

    const exported = (await contributor.buildContribution(USER_ID)) as Array<{
      payload: Record<string, unknown>;
    }>;

    expect(exported[0]!.payload).toBe(forumReplyPayload);
    for (const repository of [
      threads,
      communities,
      forumPosts,
      communityPosts,
      communityReplies,
      messages,
      contentModeration,
    ]) {
      expect(repository.find).not.toHaveBeenCalled();
    }
  });

  it('checks a long history in batches, one lookup per source kind per batch', async () => {
    const rows = Array.from({ length: 501 }, (_row, index) =>
      messageMention(`n-${index}`, LIVE_MESSAGE_ID),
    );
    const { contributor, messages } = build(rows);
    messages.find.mockResolvedValue([
      { id: LIVE_MESSAGE_ID, deletedAt: null, editedAt: null },
    ]);

    const exported = (await contributor.buildContribution(USER_ID)) as Array<{
      payload: Record<string, unknown>;
    }>;

    expect(messages.find).toHaveBeenCalledTimes(2);
    expect(exported.every((row) => row.payload.excerpt !== '')).toBe(true);
  });

  it('blanks the excerpt of a mention whose message a platform moderator took down', async () => {
    const { contributor, messages, contentModeration } = build([
      messageMention('n-live', LIVE_MESSAGE_ID),
      messageMention('n-taken-down', DELETED_MESSAGE_ID),
    ]);
    // Both messages are live and unedited: only `content_moderation` knows.
    messages.find.mockResolvedValue([
      { id: LIVE_MESSAGE_ID, deletedAt: null, editedAt: null },
      { id: DELETED_MESSAGE_ID, deletedAt: null, editedAt: null },
    ]);
    contentModeration.find.mockResolvedValue([
      {
        subjectType: 'message',
        subjectId: DELETED_MESSAGE_ID,
        hiddenAt: afterMention,
        removedAt: afterMention,
      },
    ]);

    const exported = (await contributor.buildContribution(USER_ID)) as Array<{
      payload: Record<string, unknown>;
    }>;

    expect(exported.map((row) => row.payload.excerpt)).toEqual([
      'words of n-live',
      '',
    ]);
    expect(JSON.stringify(exported)).not.toContain('words of n-taken-down');
  });

  it('blanks the excerpt of a mention in a community post a platform moderator hid', async () => {
    const { contributor, communityPosts, contentModeration } = build([
      notificationRow('n-hidden-post', NotificationType.Mention, {
        source: 'community',
        communitySlug: 'pride',
        postId: EDITED_POST_ID,
        actorId: 'actor-1',
        excerpt: 'hidden post words',
      }),
    ]);
    communityPosts.find.mockResolvedValue([
      { id: EDITED_POST_ID, deletedAt: null, editedAt: null },
    ]);
    contentModeration.find.mockResolvedValue([
      {
        subjectType: 'post',
        subjectId: EDITED_POST_ID,
        hiddenAt: afterMention,
        removedAt: null,
      },
    ]);

    const exported = (await contributor.buildContribution(USER_ID)) as Array<{
      payload: Record<string, unknown>;
    }>;

    expect(exported[0]!.payload).toEqual({
      source: 'community',
      communitySlug: 'pride',
      postId: EDITED_POST_ID,
      actorId: 'actor-1',
      excerpt: '',
    });
  });

  it('blanks the excerpt of a mention on a live post in a community a platform moderator took down', async () => {
    const { contributor, communityPosts, contentModeration } = build([
      notificationRow('n-community-down', NotificationType.Mention, {
        source: 'community',
        communitySlug: 'taken-down',
        postId: EDITED_POST_ID,
        actorId: 'actor-1',
        excerpt: 'words in a taken-down community',
      }),
    ]);
    communityPosts.find.mockResolvedValue([
      { id: EDITED_POST_ID, deletedAt: null, editedAt: null },
    ]);
    contentModeration.find.mockResolvedValue([
      {
        subjectType: 'community',
        subjectId: 'taken-down',
        hiddenAt: afterMention,
        removedAt: afterMention,
      },
    ]);

    const exported = (await contributor.buildContribution(USER_ID)) as Array<{
      payload: Record<string, unknown>;
    }>;

    expect(exported[0]!.payload.excerpt).toBe('');
    expect(JSON.stringify(exported)).not.toContain(
      'words in a taken-down community',
    );
  });

  describe('a mention in a space', () => {
    type ParentRow = { id: string; slug: string; archivedAt: Date | null };
    const PARENT_ID = '66666666-6666-4666-8666-666666666666';
    const liveSpace = {
      slug: 'pride-book-club',
      archivedAt: null,
      parentId: PARENT_ID,
    };
    const liveParent: ParentRow = {
      id: PARENT_ID,
      slug: 'pride',
      archivedAt: null,
    };

    // One Community repository serves both reads: the page's communities
    // by slug, then the parents of its spaces by id.
    function buildSpaceExport(parents: ParentRow[]) {
      const built = build([
        notificationRow('n-space', NotificationType.Mention, {
          source: 'community',
          communitySlug: 'pride-book-club',
          postId: EDITED_POST_ID,
          actorId: 'actor-1',
          excerpt: 'words in a space',
        }),
      ]);
      built.communities.find.mockImplementation(
        (options: { where: Record<string, unknown> }) =>
          Promise.resolve('id' in options.where ? parents : [liveSpace]),
      );
      built.communityPosts.find.mockResolvedValue([
        { id: EDITED_POST_ID, deletedAt: null, editedAt: null },
      ]);
      return built;
    }

    it('blanks the excerpt of a live post while the parent community is taken down, and keeps it once restored', async () => {
      const { contributor, communities, contentModeration } = buildSpaceExport([
        liveParent,
      ]);
      contentModeration.find.mockResolvedValue([
        {
          subjectType: 'community',
          subjectId: 'pride',
          hiddenAt: null,
          removedAt: afterMention,
        },
      ]);

      const takenDownExport = (await contributor.buildContribution(
        USER_ID,
      )) as Array<{ payload: Record<string, unknown> }>;

      expect(takenDownExport[0]!.payload.excerpt).toBe('');
      expect(JSON.stringify(takenDownExport)).not.toContain('words in a space');
      expect(communities.find).toHaveBeenCalledTimes(2);
      expect(communities.find).toHaveBeenLastCalledWith({
        where: { id: expect.any(FindOperator) },
        select: { id: true, slug: true, archivedAt: true },
      });
      expect(contentModeration.find).toHaveBeenCalledTimes(1);

      contentModeration.find.mockResolvedValue([]);

      const restoredExport = (await contributor.buildContribution(
        USER_ID,
      )) as Array<{ payload: Record<string, unknown> }>;

      expect(restoredExport[0]!.payload.excerpt).toBe('words in a space');
    });

    it('blanks the excerpt of a live post whose parent community is archived', async () => {
      const { contributor } = buildSpaceExport([
        { ...liveParent, archivedAt: afterMention },
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported[0]!.payload.excerpt).toBe('');
    });

    it('blanks the excerpt of a live post whose parent community does not load', async () => {
      const { contributor } = buildSpaceExport([]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported[0]!.payload.excerpt).toBe('');
    });
  });

  describe("other people's words the member was never shown", () => {
    const withheldTextCases: Array<[NotificationType, string]> = [
      [NotificationType.CommunityReply, 'excerpt'],
      [NotificationType.ForumReply, 'excerpt'],
      [NotificationType.ForumThreadReply, 'excerpt'],
      [NotificationType.CommunityNewPost, 'excerpt'],
      [NotificationType.CommunityAnnouncement, 'excerpt'],
      [NotificationType.EventAnnouncement, 'body'],
    ];

    it.each(withheldTextCases)(
      'leaves %s.%s out of the export and keeps the rest of the payload',
      async (type, key) => {
        const { contributor } = build([
          notificationRow('n-1', type, {
            source: 'community',
            communitySlug: 'pride',
            postId: EDITED_POST_ID,
            [key]: 'somebody else wrote this',
          }),
        ]);

        const exported = (await contributor.buildContribution(
          USER_ID,
        )) as Array<{ payload: Record<string, unknown> }>;

        expect(exported[0]!.payload).not.toHaveProperty(key);
        expect(exported[0]!.payload).toMatchObject({
          source: 'community',
          communitySlug: 'pride',
          postId: EDITED_POST_ID,
        });
        expect(JSON.stringify(exported)).not.toContain(
          'somebody else wrote this',
        );
      },
    );

    it('lists exactly those keys, and never lists Mention', () => {
      expect(EXPORT_WITHHELD_TEXT_KEYS).toEqual(
        Object.fromEntries(
          withheldTextCases.map(([type, key]) => [type, [key]]),
        ),
      );
      expect(
        EXPORT_WITHHELD_TEXT_KEYS[NotificationType.Mention],
      ).toBeUndefined();
    });

    it('keeps a fresh mention excerpt and its actor exactly as stored', async () => {
      const storedPayload = {
        source: 'message',
        conversationId: 'c1',
        messageId: LIVE_MESSAGE_ID,
        actorId: 'actor-1',
        excerpt: 'words of n-live',
      };
      const { contributor, messages } = build([
        notificationRow('n-live', NotificationType.Mention, storedPayload),
      ]);
      messages.find.mockResolvedValue([
        { id: LIVE_MESSAGE_ID, deletedAt: null, editedAt: null },
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported[0]!.payload).toEqual(storedPayload);
    });

    it('keeps every reason a moderator or reviewer wrote to the member', async () => {
      const declinedPayload = {
        source: 'community',
        communitySlug: 'pride',
        declineKind: 'custom',
        declineReason: 'We are full for this season.',
        reapplyAfter: '2026-10-01T00:00:00.000Z',
      };
      const removedPostPayload = {
        source: 'community',
        communitySlug: 'pride',
        communityName: 'Pride',
        subject: 'post',
        reason: 'Off topic for this space.',
        ruleIndex: 2,
        ruleVersion: 3,
        ruleText: 'Keep posts about the city.',
      };
      const outcomePayload = {
        source: 'moderation',
        action: 'warn',
        reasonCode: 'harassment',
        note: 'Please keep replies kind.',
      };
      const { contributor } = build([
        notificationRow(
          'n-declined',
          NotificationType.JoinRequestDeclined,
          declinedPayload,
        ),
        notificationRow(
          'n-removed',
          NotificationType.CommunityPostRemoved,
          removedPostPayload,
        ),
        notificationRow(
          'n-outcome',
          NotificationType.ModerationOutcome,
          outcomePayload,
        ),
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported.map((row) => row.payload)).toEqual([
        declinedPayload,
        removedPostPayload,
        outcomePayload,
      ]);
    });
  });

  describe('people the bell never names', () => {
    it('leaves the actor out of a type whose bell row names nobody, such as the admin behind a role change', async () => {
      const { contributor } = build([
        notificationRow('n-role', NotificationType.CommunityRoleChanged, {
          actorId: 'platform-admin-1',
          source: 'community',
          communitySlug: 'pride',
          communityName: 'Pride',
          role: 'moderator',
          fromRole: 'member',
          toRole: 'moderator',
        }),
        notificationRow('n-archived', NotificationType.CommunityArchived, {
          actorId: 'owner-1',
          source: 'community',
          communitySlug: 'pride',
          communityName: 'Pride',
        }),
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported[0]!.payload).toEqual({
        source: 'community',
        communitySlug: 'pride',
        communityName: 'Pride',
        role: 'moderator',
        fromRole: 'member',
        toRole: 'moderator',
      });
      expect(exported[1]!.payload).not.toHaveProperty('actorId');
      expect(JSON.stringify(exported)).not.toContain('platform-admin-1');
    });

    it('keeps the actor on a type whose bell row names them', async () => {
      const { contributor } = build([
        notificationRow('n-reply', NotificationType.CommunityReply, {
          actorId: 'replier-1',
          source: 'community',
          communitySlug: 'pride',
          postId: EDITED_POST_ID,
          excerpt: 'reply words',
        }),
        notificationRow('n-announcement', NotificationType.EventAnnouncement, {
          source: 'event',
          eventSlug: 'picnic',
          title: 'Picnic',
          body: 'Bring a blanket.',
          actorId: 'host-1',
        }),
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported[0]!.payload).toEqual({
        actorId: 'replier-1',
        source: 'community',
        communitySlug: 'pride',
        postId: EDITED_POST_ID,
      });
      expect(exported[1]!.payload).toEqual({
        source: 'event',
        eventSlug: 'picnic',
        title: 'Picnic',
        actorId: 'host-1',
      });
    });

    it('keeps the actor and the other party of an ownership transfer the member is party to', async () => {
      const transferPayload = {
        actorId: 'owner-1',
        source: 'community',
        communitySlug: 'pride',
        communityName: 'Pride',
        youAreNowOwner: true,
        counterpartId: 'owner-1',
      };
      const { contributor } = build([
        notificationRow(
          'n-transfer',
          NotificationType.CommunityOwnershipTransferred,
          transferPayload,
        ),
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported[0]!.payload).toEqual(transferPayload);
    });

    it('keeps the inviter on a community invite, which the My invites page names', async () => {
      const invitePayload = {
        actorId: 'inviter-1',
        source: 'community',
        communitySlug: 'pride',
        communityName: 'Pride',
        proposedRole: 'member',
      };
      const { contributor } = build([
        notificationRow(
          'n-invite',
          NotificationType.CommunityInviteReceived,
          invitePayload,
        ),
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported[0]!.payload).toEqual(invitePayload);
    });

    it('lists exactly the invite and the ownership transfer as kept actor types', () => {
      expect([...EXPORT_KEPT_ACTOR_TYPES].sort()).toEqual(
        [
          NotificationType.CommunityInviteReceived,
          NotificationType.CommunityOwnershipTransferred,
        ].sort(),
      );
    });

    it.each([
      NotificationType.CommunityRoleChanged,
      NotificationType.CommunityArchived,
      NotificationType.CommunityFrozen,
      NotificationType.CommunityUnfrozen,
      NotificationType.CommunityOwnerReviewRequested,
      NotificationType.CommunityNewPost,
      NotificationType.CommunityAnnouncement,
      NotificationType.CommunityResourceAdded,
    ])('leaves the actor out of %s', async (type) => {
      const { contributor } = build([
        notificationRow('n-1', type, {
          actorId: 'unnamed-actor-1',
          source: 'community',
          communitySlug: 'pride',
          communityName: 'Pride',
        }),
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(exported[0]!.payload).toEqual({
        source: 'community',
        communitySlug: 'pride',
        communityName: 'Pride',
      });
      expect(JSON.stringify(exported)).not.toContain('unnamed-actor-1');
    });

    it('never gives a masked row an identifier it was written without, even when keys are withheld from it', async () => {
      // A thread follower's reply row and a roster post row, both written
      // without an actor. Each still has a key withheld, so the export
      // rebuilds the payload, and the rebuilt payload names nobody.
      const { contributor } = build([
        notificationRow('n-follower', NotificationType.ForumThreadReply, {
          source: 'forum',
          threadSlug: 'welcome',
          postId: EDITED_POST_ID,
          excerpt: 'reply words',
        }),
        notificationRow('n-roster', NotificationType.CommunityNewPost, {
          source: 'community',
          communitySlug: 'pride',
          communityName: 'Pride',
          postId: EDITED_POST_ID,
          excerpt: 'post words',
        }),
      ]);

      const exported = (await contributor.buildContribution(USER_ID)) as Array<{
        payload: Record<string, unknown>;
      }>;

      expect(Object.keys(exported[0]!.payload).sort()).toEqual(
        ['postId', 'source', 'threadSlug'].sort(),
      );
      expect(Object.keys(exported[1]!.payload).sort()).toEqual(
        ['communityName', 'communitySlug', 'postId', 'source'].sort(),
      );
      for (const row of exported) {
        expect(row.payload).not.toHaveProperty('actorId');
      }
    });
  });
});
