import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { encodeCursor } from '../common/cursor-pagination';
import { ConnectionsService } from '../connections/connections.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PreferencesService } from '../preferences/preferences.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ConversationsService } from './conversations.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessagingCoreService } from './messaging-core.service';

/**
 * ENG-253: coverage for `ConversationsService.listConversations`'s new
 * cursor-paginated envelope and list-row trim, plus `getConversation`, the
 * single-conversation read path that keeps the fields the trim removed.
 *
 * `MessagingCoreService` is provided as a bare mock (like
 * `conversation-preferences.spec.ts`): what is under test here is
 * `listConversations`/`getConversation`'s OWN contract (the query shape, the
 * envelope, and which of `fullDetail`'s two toggled fields each call site
 * gets), not `buildMemberSummaries`/`buildLastMessagePreview`'s own logic,
 * which has its own coverage elsewhere.
 */

const USER_ID = 'me';
const OTHER_USER_ID = 'them';
const GROUP_CONVERSATION_ID = 'c-group';

interface MockParticipantsQb {
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  addSelect: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  getRawAndEntities: jest.Mock;
}

function makeParticipantsQb(
  entities: ConversationParticipant[],
  raw: { participant_id: string; last_activity: string }[] = [],
): MockParticipantsQb {
  const qb = {} as MockParticipantsQb;
  const self = (): MockParticipantsQb => qb;
  qb.where = jest.fn(self);
  qb.andWhere = jest.fn(self);
  qb.setParameter = jest.fn(self);
  qb.addSelect = jest.fn(self);
  qb.orderBy = jest.fn(self);
  qb.addOrderBy = jest.fn(self);
  qb.take = jest.fn(self);
  qb.getRawAndEntities = jest.fn().mockResolvedValue({ entities, raw });
  return qb;
}

function buildGroupParticipant(
  overrides: Partial<ConversationParticipant> = {},
): ConversationParticipant {
  return {
    id: 'p-me',
    conversationId: GROUP_CONVERSATION_ID,
    userId: USER_ID,
    role: ConversationRole.Owner,
    clearedAt: null,
    leftAt: null,
    removedAt: null,
    muted: false,
    mutedUntil: null,
    pinnedAt: null,
    favoritedAt: null,
    archivedAt: null,
    markedUnreadAt: null,
    draft: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
    ...overrides,
  } as ConversationParticipant;
}

describe('ConversationsService.listConversations (ENG-253)', () => {
  let service: ConversationsService;
  let participants: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
  };
  let conversations: { find: jest.Mock };
  let profiles: { find: jest.Mock };
  let core: {
    lastMessagesByConversation: jest.Mock;
    unreadCountsByConversation: jest.Mock;
    hasUnreadMentionByConversation: jest.Mock;
    reactionSummariesByMessage: jest.Mock;
    buildMemberSummaries: jest.Mock;
    buildMemberPreview: jest.Mock;
    groupCapabilities: jest.Mock;
    requireParticipant: jest.Mock;
  };
  let mediaCropService: { getMany: jest.Mock };
  let connectionsService: {
    allAcceptedConnectionUserIds: jest.Mock;
    acceptedSinceByCounterpart: jest.Mock;
  };
  let preferencesService: { getMessagingPrivacyForUsers: jest.Mock };
  let blockFilter: { blockedUserIds: jest.Mock };

  const GROUP_CONVERSATION = {
    id: GROUP_CONVERSATION_ID,
    kind: ConversationKind.Group,
    isOfficial: false,
    title: 'Pride Planning',
    avatarUrl: null,
    description: null,
    dissolvedAt: null,
    inviteToken: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(() => {
    participants = {
      createQueryBuilder: jest.fn(),
      // "others" lookup: no other members in the minimal fixture below.
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    conversations = {
      find: jest.fn().mockResolvedValue([GROUP_CONVERSATION]),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    core = {
      lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
      unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
      hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
      reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
      // A distinguishable stand-in so tests can assert list rows never call
      // through to the FULL (watermark-bearing) builder.
      buildMemberSummaries: jest.fn().mockReturnValue([
        {
          id: OTHER_USER_ID,
          handle: 'them',
          name: 'Them',
          avatarUrl: null,
          role: ConversationRole.Member,
          lastReadAt: '2026-01-01T00:00:00.000Z',
          deliveredAt: '2026-01-01T00:00:00.000Z',
          lastReadInstant: '2026-01-01T00:05:00.000Z',
        },
      ]),
      buildMemberPreview: jest
        .fn()
        .mockReturnValue([
          { id: USER_ID, handle: 'me', name: 'Me', avatarUrl: null },
        ]),
      groupCapabilities: jest.fn().mockReturnValue({
        canAddMembers: true,
        canRemoveMembers: true,
        canRename: true,
        canManageRoles: true,
      }),
      requireParticipant: jest.fn(),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    connectionsService = {
      allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
      acceptedSinceByCounterpart: jest.fn().mockResolvedValue(new Map()),
    };
    preferencesService = {
      getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    blockFilter = { blockedUserIds: jest.fn().mockResolvedValue(new Set()) };

    service = new ConversationsService(
      conversations as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      profiles as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      blockFilter as unknown as BlockFilterService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as unknown as DataSource,
      mediaCropService as unknown as MediaCropService,
      connectionsService as unknown as ConnectionsService,
      preferencesService as unknown as PreferencesService,
      // Task 11: `buildConversationSummaries` now batch-loads every seat's
      // identity, so this needs a real (if empty) `getByIds`/`describeIdentities`
      // here, in place of the bare `{}` stand-in it used to get away with as
      // an unused dependency. This fixture is GROUP-only, so the identity
      // branch of `otherParticipant` never actually runs either way.
      {
        getByIds: jest.fn().mockResolvedValue([]),
        describeIdentities: jest.fn().mockResolvedValue(new Map()),
      } as never,
      // Fix round 1 (Task 11): unused for the same reason.
      {
        buildStaffNameResolver: jest
          .fn()
          .mockResolvedValue({ resolve: () => null }),
      } as never,
    );
  });

  describe('the trimmed list row (paginated call)', () => {
    it('sends an empty `members` and calls the PREVIEW builder, never the full watermark builder', async () => {
      participants.createQueryBuilder.mockReturnValueOnce(
        makeParticipantsQb([buildGroupParticipant({ draft: null })]),
      );

      const page = await service.listConversations(USER_ID, {});

      expect(page.data).toHaveLength(1);
      expect(page.data[0]!.members).toEqual([]);
      expect(page.data[0]!.memberPreview).toEqual([
        { id: USER_ID, handle: 'me', name: 'Me', avatarUrl: null },
      ]);
      expect(core.buildMemberPreview).toHaveBeenCalledTimes(1);
      // The watermark-bearing roster builder must never run for a list row:
      // it is the exact query ENG-253 removed from this response.
      expect(core.buildMemberSummaries).not.toHaveBeenCalled();
    });

    it('omits `draft` and sends a bounded `draftPreview` plus `hasDraft` instead', async () => {
      const longDraft = 'x'.repeat(200);
      participants.createQueryBuilder.mockReturnValueOnce(
        makeParticipantsQb([buildGroupParticipant({ draft: longDraft })]),
      );

      const page = await service.listConversations(USER_ID, {});

      const row = page.data[0]!;
      expect(row.draft).toBeUndefined();
      expect(row.draftPreview).toBe(longDraft.slice(0, 120));
      expect(row.draftPreview).toHaveLength(120);
      expect(row.hasDraft).toBe(true);
    });

    it('reports `hasDraft: false` and a null preview when there is no stored draft', async () => {
      participants.createQueryBuilder.mockReturnValueOnce(
        makeParticipantsQb([buildGroupParticipant({ draft: null })]),
      );

      const page = await service.listConversations(USER_ID, {});

      const row = page.data[0]!;
      expect(row.hasDraft).toBe(false);
      expect(row.draftPreview).toBeNull();
    });

    it('reports the TRUE active member count, independent of the (possibly capped) preview length', async () => {
      core.buildMemberPreview.mockReturnValueOnce([
        { id: USER_ID, handle: 'me', name: 'Me', avatarUrl: null },
      ]); // preview capped to 1 row
      participants.find.mockResolvedValueOnce([
        // Two OTHER active members plus the caller's own row = 3 active.
        buildGroupParticipant({
          id: 'p-2',
          userId: 'u2',
          role: ConversationRole.Member,
        }),
        buildGroupParticipant({
          id: 'p-3',
          userId: 'u3',
          role: ConversationRole.Member,
        }),
      ]);
      participants.createQueryBuilder.mockReturnValueOnce(
        makeParticipantsQb([buildGroupParticipant()]),
      );

      const page = await service.listConversations(USER_ID, {});

      expect(page.data[0]!.memberCount).toBe(3);
      // The preview itself is still whatever the (separately tested) capped
      // builder returned. `memberCount` is computed independently of it.
      expect(page.data[0]!.memberPreview).toHaveLength(1);
    });
  });

  describe('the full-detail legacy overload (bare array, no options)', () => {
    it('keeps returning a bare array with the FULL member roster and full draft', async () => {
      const draft = 'unsent text';
      participants.createQueryBuilder.mockReturnValueOnce(
        makeParticipantsQb([buildGroupParticipant({ draft })]),
      );

      const rows = await service.listConversations(USER_ID);

      expect(Array.isArray(rows)).toBe(true);
      expect(rows[0]!.draft).toBe(draft);
      expect(rows[0]!.members).toHaveLength(1);
      expect(core.buildMemberSummaries).toHaveBeenCalledTimes(1);
    });
  });

  describe('pagination envelope and cursor behaviour', () => {
    function rowWithActivity(
      id: string,
      lastActivityIso: string,
    ): {
      entity: ConversationParticipant;
      raw: { participant_id: string; last_activity: string };
    } {
      const entity = buildGroupParticipant({ id, conversationId: `c-${id}` });
      return {
        entity,
        raw: { participant_id: id, last_activity: lastActivityIso },
      };
    }

    it('returns hasMore: false and nextCursor: null when the page is not full', async () => {
      const { entity, raw } = rowWithActivity('p1', '2026-01-01T00:00:00.000Z');
      participants.createQueryBuilder.mockReturnValueOnce(
        makeParticipantsQb([entity], [raw]),
      );
      conversations.find.mockResolvedValueOnce([
        { ...GROUP_CONVERSATION, id: entity.conversationId },
      ]);

      const page = await service.listConversations(USER_ID, { limit: 5 });

      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    });

    it('detects an extra row past `limit`, trims it, and encodes a cursor from the LAST kept row', async () => {
      const a = rowWithActivity('p1', '2026-01-03T00:00:00.000Z');
      const b = rowWithActivity('p2', '2026-01-02T00:00:00.000Z');
      const extra = rowWithActivity('p3', '2026-01-01T00:00:00.000Z');
      const qb = makeParticipantsQb(
        [a.entity, b.entity, extra.entity],
        [a.raw, b.raw, extra.raw],
      );
      participants.createQueryBuilder.mockReturnValueOnce(qb);
      conversations.find.mockResolvedValueOnce([
        { ...GROUP_CONVERSATION, id: a.entity.conversationId },
        { ...GROUP_CONVERSATION, id: b.entity.conversationId },
      ]);

      const page = await service.listConversations(USER_ID, { limit: 2 });

      expect(qb.take).toHaveBeenCalledWith(3); // limit + 1
      expect(page.data).toHaveLength(2);
      expect(page.pageInfo.hasMore).toBe(true);
      expect(page.pageInfo.nextCursor).toBe(
        encodeCursor({
          createdAt: new Date(b.raw.last_activity),
          id: 'p2',
        }),
      );
    });

    it('decodes an incoming cursor into the keyset seek predicate', async () => {
      const { entity, raw } = rowWithActivity('p9', '2026-01-01T00:00:00.000Z');
      const qb = makeParticipantsQb([entity], [raw]);
      participants.createQueryBuilder.mockReturnValueOnce(qb);
      conversations.find.mockResolvedValueOnce([
        { ...GROUP_CONVERSATION, id: entity.conversationId },
      ]);
      const cursor = encodeCursor({
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        id: 'p-boundary',
      });

      await service.listConversations(USER_ID, { cursor });

      const seekCall = qb.andWhere.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('participant.id) <'),
      ) as [string, Record<string, unknown>] | undefined;
      expect(seekCall).toBeDefined();
      const [, params] = seekCall!;
      expect(params.cursorParticipantId).toBe('p-boundary');
      expect(params.cursorLastActivity).toBe('2026-02-01T00:00:00.000Z');
    });

    it('clamps an over-ceiling limit to MAX_LIMIT (100)', async () => {
      const qb = makeParticipantsQb([]);
      participants.createQueryBuilder.mockReturnValueOnce(qb);

      await service.listConversations(USER_ID, { limit: 999 });

      expect(qb.take).toHaveBeenCalledWith(101);
    });

    it('clamps a non-positive limit up to 1', async () => {
      const qb = makeParticipantsQb([]);
      participants.createQueryBuilder.mockReturnValueOnce(qb);

      await service.listConversations(USER_ID, { limit: 0 });

      expect(qb.take).toHaveBeenCalledWith(2);
    });

    it('returns an empty envelope for a caller with no threads, never an error', async () => {
      participants.createQueryBuilder.mockReturnValueOnce(
        makeParticipantsQb([]),
      );

      const page = await service.listConversations(USER_ID, {});

      expect(page).toEqual({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    });
  });
});

describe('ConversationsService.getConversation (ENG-253 single-conversation read path)', () => {
  let service: ConversationsService;
  let participants: { find: jest.Mock; update: jest.Mock };
  let conversations: { find: jest.Mock };
  let profiles: { find: jest.Mock };
  let core: {
    lastMessagesByConversation: jest.Mock;
    unreadCountsByConversation: jest.Mock;
    hasUnreadMentionByConversation: jest.Mock;
    reactionSummariesByMessage: jest.Mock;
    buildMemberSummaries: jest.Mock;
    buildMemberPreview: jest.Mock;
    groupCapabilities: jest.Mock;
    requireParticipant: jest.Mock;
  };

  const GROUP_CONVERSATION = {
    id: GROUP_CONVERSATION_ID,
    kind: ConversationKind.Group,
    isOfficial: false,
    title: 'Pride Planning',
    avatarUrl: null,
    description: null,
    dissolvedAt: null,
    inviteToken: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(() => {
    participants = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    conversations = { find: jest.fn().mockResolvedValue([GROUP_CONVERSATION]) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    core = {
      lastMessagesByConversation: jest.fn().mockResolvedValue(new Map()),
      unreadCountsByConversation: jest.fn().mockResolvedValue(new Map()),
      hasUnreadMentionByConversation: jest.fn().mockResolvedValue(new Map()),
      reactionSummariesByMessage: jest.fn().mockResolvedValue(new Map()),
      buildMemberSummaries: jest.fn().mockReturnValue([
        {
          id: OTHER_USER_ID,
          handle: 'them',
          name: 'Them',
          avatarUrl: null,
          role: ConversationRole.Member,
          lastReadAt: '2026-01-01T00:00:00.000Z',
          deliveredAt: null,
          lastReadInstant: '2026-01-01T00:05:00.000Z',
        },
      ]),
      buildMemberPreview: jest
        .fn()
        .mockReturnValue([
          { id: USER_ID, handle: 'me', name: 'Me', avatarUrl: null },
        ]),
      groupCapabilities: jest.fn().mockReturnValue({}),
      requireParticipant: jest.fn(),
    };

    service = new ConversationsService(
      conversations as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      profiles as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      {
        blockedUserIds: jest.fn().mockResolvedValue(new Set()),
      } as unknown as BlockFilterService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as unknown as DataSource,
      {
        getMany: jest.fn().mockResolvedValue(new Map()),
      } as unknown as MediaCropService,
      {
        allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
        acceptedSinceByCounterpart: jest.fn().mockResolvedValue(new Map()),
      } as unknown as ConnectionsService,
      {
        getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
      } as unknown as PreferencesService,
      // Task 11: `buildConversationSummaries` now batch-loads every seat's
      // identity, so this needs a real (if empty) `getByIds`/`describeIdentities`
      // here, in place of the bare `{}` stand-in it used to get away with as
      // an unused dependency. This fixture is GROUP-only, so the identity
      // branch of `otherParticipant` never actually runs either way.
      {
        getByIds: jest.fn().mockResolvedValue([]),
        describeIdentities: jest.fn().mockResolvedValue(new Map()),
      } as never,
      // Fix round 1 (Task 11): unused for the same reason.
      {
        buildStaffNameResolver: jest
          .fn()
          .mockResolvedValue({ resolve: () => null }),
      } as never,
    );
  });

  it('returns the FULL member roster (with watermarks) and the full draft body', async () => {
    const draft = 'a full, untruncated draft';
    core.requireParticipant.mockResolvedValueOnce(
      buildGroupParticipant({ draft }),
    );

    const result = await service.getConversation(
      GROUP_CONVERSATION_ID,
      USER_ID,
    );

    expect(result.draft).toBe(draft);
    expect(result.members).toHaveLength(1);
    expect(result.members[0]!.lastReadInstant).toBe('2026-01-01T00:05:00.000Z');
    expect(core.buildMemberSummaries).toHaveBeenCalledTimes(1);
  });

  it('authorizes through the shared `requireParticipant` membership check', async () => {
    core.requireParticipant.mockResolvedValueOnce(buildGroupParticipant());

    await service.getConversation(GROUP_CONVERSATION_ID, USER_ID);

    expect(core.requireParticipant).toHaveBeenCalledWith(
      GROUP_CONVERSATION_ID,
      USER_ID,
    );
  });

  it('404s when the row is one `listConversations` would silently drop (e.g. cleared with no newer message)', async () => {
    core.requireParticipant.mockResolvedValueOnce(
      buildGroupParticipant({ clearedAt: new Date('2026-06-01T00:00:00Z') }),
    );
    // No last message at all, so a clear point always leaves nothing newer.
    core.lastMessagesByConversation.mockResolvedValueOnce(new Map());

    await expect(
      service.getConversation(GROUP_CONVERSATION_ID, USER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
