import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator, QueryFailedError } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { encodeCursor } from '../common/cursor-pagination';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { GroupInvite } from './entities/group-invite.entity';
import { Message, MessageKind } from './entities/message.entity';
import { buildReplyTo } from './message-response';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { MessageCreatedEvent } from './messaging.events';
import { MessagingService } from './messaging.service';
import { MessagingCoreService } from './messaging-core.service';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { MessageAnnotationsService } from './message-annotations.service';
import { GroupsService } from './groups.service';
import { GroupInvitesService } from './group-invites.service';
import { MessageRequestsService } from './message-requests.service';
import { StorageService } from '../storage/storage.service';
import { PreferencesService } from '../preferences/preferences.service';

/**
 * Minimal chainable stand-in for a TypeORM SelectQueryBuilder. Every builder
 * method returns the same object so the fluent chain works; `getMany` /
 * `getRawMany` are the terminal awaited calls the tests configure.
 */
interface MockQb {
  distinctOn: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  groupBy: jest.Mock;
  take: jest.Mock;
  withDeleted: jest.Mock;
  getMany: jest.Mock;
  getRawMany: jest.Mock;
  getRawOne: jest.Mock;
  getRawAndEntities: jest.Mock;
  getExists: jest.Mock;
  // `markRead` advances both watermarks through an UPDATE builder so the
  // GREATEST(...) expression is evaluated by Postgres.
  update: jest.Mock;
  set: jest.Mock;
  execute: jest.Mock;
}

function makeQb(): MockQb {
  const qb = {} as MockQb;
  const self = (): MockQb => qb;
  qb.distinctOn = jest.fn(self);
  qb.select = jest.fn(self);
  qb.addSelect = jest.fn(self);
  qb.innerJoin = jest.fn(self);
  qb.where = jest.fn(self);
  qb.andWhere = jest.fn(self);
  // Bound by the moderator-takedown NOT EXISTS predicate the message queries now
  // compose in (`setParameter('messageSubjectType', …)`); chainable like the rest.
  qb.setParameter = jest.fn(self);
  qb.orderBy = jest.fn(self);
  qb.addOrderBy = jest.fn(self);
  qb.groupBy = jest.fn(self);
  qb.take = jest.fn(self);
  qb.withDeleted = jest.fn(self);
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
  // The backward history page (`getMessages`) reads entities plus raw rows,
  // where the raw row carries the exact microsecond created_at for its cursor.
  // Default: whatever `getMany` is stubbed with, and no raw cursor text.
  qb.getRawAndEntities = jest.fn(() =>
    (qb.getMany() as Promise<unknown[]>).then((entities) => ({
      entities,
      raw: [],
    })),
  );
  // `MessagingCoreService.requireActiveParticipant` (BE-MSG-09) probes for a
  // blocked DM counterpart with a single `getExists()`; default: not blocked.
  qb.getExists = jest.fn().mockResolvedValue(false);
  qb.update = jest.fn(self);
  qb.set = jest.fn(self);
  qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
  return qb;
}

/**
 * The six-key, all-zero reaction summary every `MessageResponse` now carries
 * when a message has no reactions — one entry per `MessageReactionKey`, in the
 * canonical order, `count: 0` / `mine: false`. Matches `toMessageReactionSummaries`.
 */
function emptyReactions(): { key: string; count: number; mine: boolean }[] {
  return ['love', 'laugh', 'like', 'wow', 'sad', 'thanks'].map((key) => ({
    key,
    count: 0,
    mine: false,
  }));
}

describe('MessagingService', () => {
  let service: MessagingService;
  let core: MessagingCoreService;
  let messageRequestsService: MessageRequestsService;
  let conversations: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  let participants: {
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    exists: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let messages: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let connections: {
    areConnected: jest.Mock;
    assertRequestsNotPaused: jest.Mock;
    requestConnection: jest.Mock;
    allAcceptedConnectionUserIds: jest.Mock;
    acceptedSinceByCounterpart: jest.Mock;
  };
  let blockFilter: {
    isBlockedEitherWay: jest.Mock;
    blockedUserIds: jest.Mock;
    excludeBlocked: jest.Mock;
  };
  let emitter: { emit: jest.Mock };
  let reactions: {
    find: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let pins: {
    find: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let stars: {
    find: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let usersService: {
    findById: jest.Mock;
    liftExpiredRestriction: jest.Mock;
  };
  let mentions: { notify: jest.Mock };
  let storage: { deleteObjectByReference: jest.Mock };
  let preferences: {
    getMessagingPrivacy: jest.Mock;
    getMessagingPrivacyForUsers: jest.Mock;
  };
  // PRD-353: `GroupInvite` repository — `GroupsService.toGroupConversationResponse`
  // reads it (owner/admin caller only); `GroupInvitesService` reads/writes it
  // directly. No test in this file exercises those paths yet, so an empty
  // default is enough.
  let groupInvites: { find: jest.Mock };
  // `MessagingCoreService.toMessageResponses` now reads the shared
  // `content_moderation` table to tombstone moderator-taken-down messages; the
  // repo only needs `find` (default: no takedowns) for these tests.
  let moderationStates: { find: jest.Mock; exist: jest.Mock };

  beforeEach(async () => {
    conversations = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((value: Partial<Conversation>) => value),
      // PRD-340: `sendMessage`'s connection-gate block flips `openedAt` on the
      // non-initiator's first reply; `ConversationsService`'s `MEMBER_BLOCKED`
      // handler resets it. Mirrors `participants.update` above.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    participants = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn((value: Partial<ConversationParticipant>) =>
        Promise.resolve(value),
      ),
      exists: jest.fn().mockResolvedValue(true),
      // `listConversations` now loads the caller's own participant rows through a
      // bounded, last-activity-ordered QueryBuilder (a deterministic
      // DEFAULT_LIST_LIMIT cap) rather than `participants.find`. Default to an
      // empty page; tests that exercise a populated inbox stub `getMany` via
      // `stubMyParticipants` below.
      createQueryBuilder: jest.fn(() => makeQb()),
    };
    messages = {
      create: jest.fn((value: Partial<Message>) => value),
      save: jest.fn((value: Partial<Message>) =>
        Promise.resolve({
          id: 'm1',
          createdAt: new Date(),
          editedAt: null,
          deletedAt: null,
          ...value,
        }),
      ),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => makeQb()),
    };
    profiles = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    dataSource = { transaction: jest.fn() };
    connections = {
      areConnected: jest.fn().mockResolvedValue(true),
      // PRD-365: the report-driven pause `deliverEnquiry` checks for a
      // non-connected pair. Default: not paused.
      assertRequestsNotPaused: jest.fn().mockResolvedValue(undefined),
      requestConnection: jest.fn(),
      // `replyRequiresConnection` (PRD-220): `listConversations` batches this
      // once per call rather than checking `areConnected` per row. Default:
      // everyone the caller has ever DM'd is an accepted connection, so
      // existing fixtures (which never set up a "not connected" thread) keep
      // getting `replyRequiresConnection: false` unless a test overrides this.
      allAcceptedConnectionUserIds: jest
        .fn()
        .mockResolvedValue(['u2', 'u3', 'x', 'y', 'them']),
      // DES-225: `connectedSince` is batched once per inbox call. Default: no
      // accepted-at timestamps, so every fixture's `connectedSince` is null
      // unless a test overrides this.
      acceptedSinceByCounterpart: jest.fn().mockResolvedValue(new Map()),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      // The inbox drops threads whose counterpart is blocked either way, in
      // ONE batched query rather than per conversation. Default: nobody
      // blocked.
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
      // PRD-354: `getMessages`/`getMessagesSince` append this predicate for a
      // GROUP conversation only. Default stub just returns the same builder
      // (mirroring the real method's chainable return), so tests that don't
      // care about it keep working unchanged.
      excludeBlocked: jest.fn((qb: unknown) => qb),
    };
    emitter = { emit: jest.fn() };
    reactions = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(() => ({
        insert: () => ({
          into: () => ({
            values: () => ({
              orIgnore: () => ({ execute: jest.fn().mockResolvedValue({}) }),
            }),
          }),
        }),
      })),
    };
    const orIgnoreInsert = {
      insert: () => ({
        into: () => ({
          values: () => ({
            orIgnore: () => ({ execute: jest.fn().mockResolvedValue({}) }),
          }),
        }),
      }),
    };
    pins = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(() => orIgnoreInsert),
    };
    stars = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(() => orIgnoreInsert),
    };
    // `sendMessage` asserts the sender is still an ACTIVE member (BE-MSG-02),
    // so the default row has to be one. `deleteMessage`'s staff check reads
    // `role` off the same row and a plain member is not staff, exactly as the
    // previous `null` default behaved there.
    usersService = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'me', status: UserStatus.Active }),
      // ENG-242: no fixture in this file sets up a moderator `restrict`, so
      // every sender reads as never-restricted unless a test overrides this.
      liftExpiredRestriction: jest.fn().mockResolvedValue(false),
    };
    moderationStates = {
      find: jest.fn().mockResolvedValue([]),
      // `editMessage` refuses to edit a moderator-taken-down message
      // (BE-MSG-07); default: no takedown.
      exist: jest.fn().mockResolvedValue(false),
    };
    mentions = { notify: jest.fn().mockResolvedValue(new Set()) };
    storage = { deleteObjectByReference: jest.fn().mockResolvedValue(true) };
    // PRD-364: default every fixture to sharing everything ON (the platform's
    // pre-PRD-364 behaviour), so the existing `listConversations`/`markRead`
    // expectations below — none of which anticipate the new gating — keep
    // passing unless a test explicitly overrides these mocks.
    preferences = {
      getMessagingPrivacy: jest.fn().mockResolvedValue({
        shareReadReceipts: true,
        shareTyping: true,
        sharePresence: true,
        whoCanMessage: 'everyone',
      }),
      getMessagingPrivacyForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    groupInvites = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        MessagingCoreService,
        ConversationsService,
        MessagesService,
        MessageAnnotationsService,
        GroupsService,
        GroupInvitesService,
        MessageRequestsService,
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: participants,
        },
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(GroupInvite), useValue: groupInvites },
        { provide: getRepositoryToken(MessageReaction), useValue: reactions },
        {
          provide: getRepositoryToken(ConversationPinnedMessage),
          useValue: pins,
        },
        { provide: getRepositoryToken(MessageStar), useValue: stars },
        {
          provide: getRepositoryToken(ContentModeration),
          useValue: moderationStates,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: emitter },
        { provide: ConnectionsService, useValue: connections },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: UsersService, useValue: usersService },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: MentionNotificationService,
          // Best-effort fan-out `sendMessage` now fires on every fresh send —
          // mirrors how forum/community specs stub it out; the notify() call
          // itself is covered by `MentionNotificationService`'s own spec.
          useValue: mentions,
        },
        {
          provide: StorageService,
          // `deleteMessage` purges the BYTES behind a tombstoned message's
          // attachment; the bucket call itself is stubbed here and asserted in
          // the delete specs below.
          useValue: storage,
        },
        { provide: PreferencesService, useValue: preferences },
      ],
    }).compile();
    service = module.get(MessagingService);
    core = module.get(MessagingCoreService);
    messageRequestsService = module.get(MessageRequestsService);
  });

  /**
   * Stub the bounded "my participant rows" QueryBuilder that `listConversations`
   * now runs first (ordered by last activity, capped at DEFAULT_LIST_LIMIT),
   * returning `rows` from its terminal `getMany`. The counterpart ("others")
   * rows still flow through `participants.find`.
   */
  function stubMyParticipants(rows: unknown[]): MockQb {
    const qb = makeQb();
    qb.getMany.mockResolvedValue(rows);
    participants.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }

  describe('listConversations', () => {
    it('returns [] when the user has no participant rows', async () => {
      stubMyParticipants([]);
      await expect(service.listConversations('me')).resolves.toEqual([]);
      // Short-circuits before touching messages.
      expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('maps grouped unread counts, sorts newest-first, and 0s conversations with no unread row', async () => {
      stubMyParticipants([
        { conversationId: 'c1', muted: false, lastReadAt: null },
        { conversationId: 'c2', muted: true, lastReadAt: new Date() },
      ]);
      // others (non-self)
      participants.find.mockResolvedValueOnce([
        { conversationId: 'c1', userId: 'u2' },
        { conversationId: 'c2', userId: 'u3' },
      ]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'c1',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'c2',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'u2',
          slug: 'alice',
          firstName: 'Alice',
          lastName: 'A',
          avatarUrl: null,
        },
        {
          userId: 'u3',
          slug: 'bob',
          firstName: 'Bob',
          lastName: 'B',
          avatarUrl: null,
        },
      ]);

      const lastQb = makeQb();
      // c1 is newer than c2 → must sort first.
      lastQb.getMany.mockResolvedValue([
        {
          conversationId: 'c1',
          id: 'm-c1',
          senderId: 'u2',
          body: 'hi',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
        {
          conversationId: 'c2',
          id: 'm-c2',
          senderId: 'u3',
          body: 'yo',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      const unreadQb = makeQb();
      unreadQb.getRawMany.mockResolvedValue([
        { conversationId: 'c1', count: '2' },
      ]);
      messages.createQueryBuilder
        .mockReturnValueOnce(lastQb)
        .mockReturnValueOnce(unreadQb);

      const result = await service.listConversations('me');

      expect(result.map((c) => c.id)).toEqual(['c1', 'c2']); // newest-first
      expect(result[0]!.unreadCount).toBe(2);
      expect(result[1]!.unreadCount).toBe(0); // absent from unread rows
      // ENG-195: the caller's OWN read watermark, from the participant row the
      // inbox already loaded (c1 was never read, c2 was).
      expect(result[0]!.myLastReadAt).toBeNull();
      expect(result[1]!.myLastReadAt).toEqual(expect.any(String));
      // Contract shape: `otherParticipant` with handle/displayName, not the
      // internal slug/firstName/lastName.
      expect(result[0]!.otherParticipant).toEqual({
        handle: 'alice',
        displayName: 'Alice A',
        avatarUrl: null,
      });
      expect(result[0]!.type).toBe('dm');
      // `updatedAt` tracks last activity (the newest message).
      expect(result[0]!.updatedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(result[1]!.updatedAt).toBe('2026-01-01T00:00:00.000Z');
      // No N+1: exactly two message queries regardless of conversation count.
      expect(messages.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('emits a `sender` on every lastMessage — including one the caller sent', async () => {
      stubMyParticipants([
        { conversationId: 'c1', muted: false, lastReadAt: null },
      ]);
      participants.find.mockResolvedValueOnce([
        { conversationId: 'c1', userId: 'u2' },
      ]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'c1',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      // The caller's own profile must be loaded too: they may be the sender of
      // the last message, and `MessageResponse.sender` is non-nullable.
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'u2',
          slug: 'alice',
          firstName: 'Alice',
          lastName: 'A',
          avatarUrl: null,
        },
        {
          userId: 'me',
          slug: 'me-handle',
          firstName: 'Me',
          lastName: 'Myself',
          avatarUrl: 'https://cdn.example/me.png',
          // `authorSummaryFrom` gates the avatar on `photoVisible`, so a
          // fixture that omits the column reads as "photo hidden" and the
          // assertion below would pass against a null it never meant to test.
          photoVisible: true,
        },
      ]);

      const lastQb = makeQb();
      lastQb.getMany.mockResolvedValue([
        {
          conversationId: 'c1',
          id: 'm-c1',
          senderId: 'me', // the caller sent the newest message
          body: 'hi',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      ]);
      messages.createQueryBuilder
        .mockReturnValueOnce(lastQb)
        .mockReturnValueOnce(makeQb());

      const result = await service.listConversations('me');

      expect(result[0]!.lastMessage?.sender).toEqual({
        handle: 'me-handle',
        displayName: 'Me Myself',
        avatarUrl: 'https://cdn.example/me.png',
      });
      expect(result[0]!.lastMessage?.conversationId).toBe('c1');
      expect(result[0]!.lastMessage?.createdAt).toBe(
        '2026-01-02T00:00:00.000Z',
      );
      // The caller is queried alongside the counterparts, in the same query.
      const findCalls = profiles.find.mock.calls as [
        { where: { userId: FindOperator<string> } },
      ][];
      expect(findCalls[0]![0].where.userId.value).toEqual(
        expect.arrayContaining(['u2', 'me']),
      );
    });

    it('expresses the null-lastReadAt branch in the unread query', async () => {
      stubMyParticipants([
        { conversationId: 'c1', muted: false, lastReadAt: null },
      ]);
      participants.find.mockResolvedValueOnce([]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'c1',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      const lastQb = makeQb();
      const unreadQb = makeQb();
      messages.createQueryBuilder
        .mockReturnValueOnce(lastQb)
        .mockReturnValueOnce(unreadQb);

      await service.listConversations('me');

      const clauses = unreadQb.andWhere.mock.calls.map(
        (call: [string]) => call[0],
      );
      expect(clauses).toContain(
        '(p.last_read_at IS NULL OR m.created_at > p.last_read_at)',
      );
    });

    it('renders official/welcome threads as type "group" with no otherParticipant (>2 participants)', async () => {
      stubMyParticipants([
        { conversationId: 'off', muted: false, lastReadAt: null },
      ]);
      // two other participants on the official thread
      participants.find.mockResolvedValueOnce([
        { conversationId: 'off', userId: 'x' },
        { conversationId: 'off', userId: 'y' },
      ]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'off',
          isOfficial: true,
          createdAt: new Date('2026-03-04T05:06:07Z'),
        },
      ]);
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'x',
          slug: 'x',
          firstName: 'X',
          lastName: 'X',
          avatarUrl: null,
        },
        {
          userId: 'y',
          slug: 'y',
          firstName: 'Y',
          lastName: 'Y',
          avatarUrl: null,
        },
      ]);
      messages.createQueryBuilder
        .mockReturnValueOnce(makeQb())
        .mockReturnValueOnce(makeQb());

      const result = await service.listConversations('me');

      expect(result[0]!.isOfficial).toBe(true);
      expect(result[0]!.type).toBe('group');
      expect(result[0]!.otherParticipant).toBeNull();
      expect(result[0]!.lastMessage).toBeNull();
      // No messages yet, so last activity falls back to the thread's creation
      // (`conversations` has no updated_at column).
      expect(result[0]!.updatedAt).toBe('2026-03-04T05:06:07.000Z');
      // The connection gate (PRD-220) never applies to an official thread.
      expect(result[0]!.replyRequiresConnection).toBe(false);
    });

    it('sets replyRequiresConnection (PRD-220) for a DM whose counterpart is not an accepted connection, but not for one who is', async () => {
      stubMyParticipants([
        { conversationId: 'c1', muted: false, lastReadAt: null },
        { conversationId: 'c2', muted: false, lastReadAt: null },
      ]);
      participants.find.mockResolvedValueOnce([
        // c1's counterpart is a stranger (e.g. a cold housing enquiry);
        // c2's is an accepted connection.
        { conversationId: 'c1', userId: 'stranger' },
        { conversationId: 'c2', userId: 'u2' },
      ]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'c1',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'c2',
          isOfficial: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'stranger',
          slug: 'stranger',
          firstName: 'Sam',
          lastName: 'T',
          avatarUrl: null,
        },
        {
          userId: 'u2',
          slug: 'alice',
          firstName: 'Alice',
          lastName: 'A',
          avatarUrl: null,
        },
      ]);
      messages.createQueryBuilder
        .mockReturnValueOnce(makeQb())
        .mockReturnValueOnce(makeQb());
      // Only 'u2' is an accepted connection of the caller.
      connections.allAcceptedConnectionUserIds.mockResolvedValueOnce(['u2']);

      const result = await service.listConversations('me');

      const c1 = result.find((c) => c.id === 'c1')!;
      const c2 = result.find((c) => c.id === 'c2')!;
      expect(c1.replyRequiresConnection).toBe(true);
      expect(c2.replyRequiresConnection).toBe(false);
      // One batched call, not one `areConnected` per conversation.
      expect(connections.allAcceptedConnectionUserIds).toHaveBeenCalledTimes(1);
      expect(connections.allAcceptedConnectionUserIds).toHaveBeenCalledWith(
        'me',
      );
    });

    // Messaging scan section 8 (Groups), item 9: `canManageInviteLink`/
    // `canTransferOwnership`/`canDissolve` are computed from the caller's own
    // role/leftAt and the group's dissolvedAt, exactly like
    // `GroupsService.toGroupConversationResponse`, instead of the old
    // hardcoded `false` that told every owner they could never dissolve
    // their own group.
    it('computes canManageInviteLink/canTransferOwnership/canDissolve for a GROUP from role + dissolvedAt', async () => {
      stubMyParticipants([
        {
          conversationId: 'g-owner',
          userId: 'me',
          muted: false,
          lastReadAt: null,
          role: ConversationRole.Owner,
          leftAt: null,
        },
        {
          conversationId: 'g-admin',
          userId: 'me',
          muted: false,
          lastReadAt: null,
          role: ConversationRole.Admin,
          leftAt: null,
        },
        {
          conversationId: 'g-dissolved',
          userId: 'me',
          muted: false,
          lastReadAt: null,
          role: ConversationRole.Owner,
          leftAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]);
      participants.find.mockResolvedValueOnce([
        {
          conversationId: 'g-owner',
          userId: 'them',
          role: ConversationRole.Member,
          leftAt: null,
        },
        {
          conversationId: 'g-admin',
          userId: 'them',
          role: ConversationRole.Member,
          leftAt: null,
        },
        {
          conversationId: 'g-dissolved',
          userId: 'them',
          role: ConversationRole.Member,
          leftAt: new Date('2026-04-01T00:00:00Z'),
        },
      ]);
      conversations.find.mockResolvedValueOnce([
        {
          id: 'g-owner',
          kind: ConversationKind.Group,
          isOfficial: false,
          title: 'Owner group',
          avatarUrl: null,
          description: null,
          inviteToken: null,
          dissolvedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'g-admin',
          kind: ConversationKind.Group,
          isOfficial: false,
          title: 'Admin group',
          avatarUrl: null,
          description: null,
          inviteToken: null,
          dissolvedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'g-dissolved',
          kind: ConversationKind.Group,
          isOfficial: false,
          title: 'Ended group',
          avatarUrl: null,
          description: null,
          inviteToken: null,
          dissolvedAt: new Date('2026-04-01T00:00:00Z'),
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'me',
          slug: 'me-handle',
          firstName: 'Me',
          lastName: 'M',
          avatarUrl: null,
        },
        {
          userId: 'them',
          slug: 'them-handle',
          firstName: 'Them',
          lastName: 'T',
          avatarUrl: null,
        },
      ]);
      messages.createQueryBuilder
        .mockReturnValueOnce(makeQb()) // lastMessagesByConversation
        .mockReturnValueOnce(makeQb()) // unreadCountsByConversation
        .mockReturnValueOnce(makeQb()); // hasUnreadMentionByConversation

      const result = await service.listConversations('me');

      const owner = result.find((c) => c.id === 'g-owner')!;
      const admin = result.find((c) => c.id === 'g-admin')!;
      const dissolved = result.find((c) => c.id === 'g-dissolved')!;

      expect(owner.canManageInviteLink).toBe(true);
      expect(owner.canTransferOwnership).toBe(true);
      expect(owner.canDissolve).toBe(true);

      // An admin manages the invite link but never transfers ownership or
      // dissolves the group.
      expect(admin.canManageInviteLink).toBe(true);
      expect(admin.canTransferOwnership).toBe(false);
      expect(admin.canDissolve).toBe(false);

      // Even the owner loses every can* flag once the group has ended.
      expect(dissolved.canManageInviteLink).toBe(false);
      expect(dissolved.canTransferOwnership).toBe(false);
      expect(dissolved.canDissolve).toBe(false);
    });
  });

  describe('getMessages', () => {
    beforeEach(() => {
      // requireParticipant passes.
      participants.findOne.mockResolvedValue({
        conversationId: 'c1',
        userId: 'me',
      });
    });

    // The backward page reads one row past the clamped limit to decide
    // `hasMore` exactly, hence 100 + 1 and 30 + 1.
    it('clamps the limit to MAX_LIMIT and defaults when unset', async () => {
      const qbBig = makeQb();
      const qbDefault = makeQb();
      messages.createQueryBuilder
        .mockReturnValueOnce(qbBig)
        .mockReturnValueOnce(qbDefault);

      await service.getMessages('c1', 'me', { limit: 500 });
      expect(qbBig.take).toHaveBeenCalledWith(101);

      await service.getMessages('c1', 'me', {});
      expect(qbDefault.take).toHaveBeenCalledWith(31);
    });

    // INCLUSIVE (`<=`), deliberately: without `beforeId` this is a single-column
    // keyset on a timestamptz several messages routinely share (a burst send, or
    // the system pills a group transaction inserts together), and a strict `<`
    // dropped every one of them. Repeating the boundary message is free — history
    // pages are merged by id.
    it('uses an inclusive created_at cursor when only `before` is given', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      await service.getMessages('c1', 'me', { before: '2026-01-01T00:00:00Z' });
      expect(qb.andWhere).toHaveBeenCalledWith('m.created_at <= :before', {
        before: '2026-01-01T00:00:00Z',
      });
    });

    it('uses a composite (created_at, id) cursor when `beforeId` is also given', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      await service.getMessages('c1', 'me', {
        before: '2026-01-01T00:00:00Z',
        beforeId: '11111111-1111-4111-8111-111111111111',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        expect.objectContaining({
          beforeId: '11111111-1111-4111-8111-111111111111',
        }),
      );
    });

    it('orders created_at DESC, id DESC and opts into soft-deleted rows with withDeleted so tombstones stay in the thread', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      await service.getMessages('c1', 'me', {});
      expect(qb.orderBy).toHaveBeenCalledWith('m.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('m.id', 'DESC');
      // The QueryBuilder would drop @DeleteDateColumn rows by default; the
      // thread read calls `.withDeleted()` so a message deleted for everyone
      // still renders as a tombstone in history.
      expect(messages.createQueryBuilder).toHaveBeenCalledWith('m');
      expect(qb.withDeleted).toHaveBeenCalled();
    });

    it('rejects a non-participant', async () => {
      participants.findOne.mockReset();
      participants.findOne.mockResolvedValue(null);
      await expect(
        service.getMessages('c1', 'intruder', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('decodes an opaque `cursor` into the same composite keyset predicate', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      const cursor = encodeCursor({
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        id: '11111111-1111-4111-8111-111111111111',
      });

      await service.getMessages('c1', 'me', { cursor });

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        {
          before: '2026-01-01T00:00:00.000Z',
          beforeId: '11111111-1111-4111-8111-111111111111',
        },
      );
    });

    it('treats a malformed `cursor` as no cursor (first page)', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getMessages('c1', 'me', { cursor: 'not-a-real-cursor' });

      // The "delete for me" NOT EXISTS predicate always applies; only the
      // keyset predicates must be absent.
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        expect.anything(),
      );
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'm.created_at <= :before',
        expect.anything(),
      );
    });

    it('prefers an explicit `before`/`beforeId` over `cursor` when both are given', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      const cursor = encodeCursor({
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        id: '22222222-2222-4222-8222-222222222222',
      });

      await service.getMessages('c1', 'me', {
        before: '2026-01-01T00:00:00Z',
        cursor,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('m.created_at <= :before', {
        before: '2026-01-01T00:00:00Z',
      });
    });

    it('returns MessageResponses with a resolved `sender` on every message', async () => {
      const qb = makeQb();
      qb.getMany.mockResolvedValue([
        {
          id: 'm2',
          conversationId: 'c1',
          senderId: 'them',
          body: 'yo',
          createdAt: new Date('2026-01-02T00:00:00Z'),
          editedAt: null,
        },
        {
          id: 'm1',
          conversationId: 'c1',
          senderId: 'me',
          body: 'hi',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          editedAt: null,
        },
      ]);
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'them',
          slug: 'tam-rivera',
          firstName: 'Tam',
          lastName: 'Rivera',
          avatarUrl: null,
        },
        {
          userId: 'me',
          slug: 'me-handle',
          firstName: 'Me',
          lastName: 'Myself',
          avatarUrl: null,
        },
      ]);

      const result = await service.getMessages('c1', 'me', {});

      expect(result.pageInfo).toEqual({ nextCursor: null, hasMore: false });
      expect(result.data).toEqual([
        {
          id: 'm2',
          conversationId: 'c1',
          body: 'yo',
          sender: {
            handle: 'tam-rivera',
            displayName: 'Tam Rivera',
            avatarUrl: null,
          },
          createdAt: '2026-01-02T00:00:00.000Z',
          editedAt: null,
          reactions: emptyReactions(),
          deletedAt: null,
          deliveredAt: null,
          clientMessageId: undefined,
          forwarded: undefined,
          pinnedAt: null,
          starred: false,
          canPin: true,
          // Not the author (sender is `them`) and viewer isn't staff → may
          // report but never edit/delete someone else's message.
          canEdit: false,
          canDelete: false,
          canReport: true,
          replyTo: null,
          kind: 'user',
          attachment: null,
          systemEvent: null,
        },
        {
          id: 'm1',
          conversationId: 'c1',
          body: 'hi',
          sender: {
            handle: 'me-handle',
            displayName: 'Me Myself',
            avatarUrl: null,
          },
          createdAt: '2026-01-01T00:00:00.000Z',
          editedAt: null,
          reactions: emptyReactions(),
          deletedAt: null,
          deliveredAt: null,
          clientMessageId: undefined,
          forwarded: undefined,
          pinnedAt: null,
          starred: false,
          canPin: true,
          // The author's own message: may delete it, but it's already older than
          // the 15-min edit window and there's nothing to self-report.
          canEdit: false,
          canDelete: true,
          canReport: false,
          replyTo: null,
          kind: 'user',
          attachment: null,
          systemEvent: null,
        },
      ]);
      // The internal `senderId` is gone: the frontend reads `sender` only.
      expect(result.data[0]).not.toHaveProperty('senderId');
      // Senders are hydrated in ONE query for the whole page, not per message.
      expect(profiles.find).toHaveBeenCalledTimes(1);
    });

    it('falls back to a placeholder sender rather than emitting a message with none', async () => {
      const qb = makeQb();
      qb.getMany.mockResolvedValue([
        {
          id: 'm1',
          conversationId: 'c1',
          senderId: 'ghost', // profile can't be resolved
          body: 'hi',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          editedAt: null,
        },
      ]);
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      profiles.find.mockResolvedValueOnce([]);

      const result = await service.getMessages('c1', 'me', {});

      // Never null/undefined — the frontend adapter reads sender.displayName
      // unguarded and would throw a TypeError.
      expect(result.data[0]!.sender).toEqual({
        handle: '',
        displayName: 'Member',
        pronouns: null,
        avatarUrl: null,
      });
    });

    it('skips the profile query entirely for an empty page', async () => {
      const qb = makeQb();
      qb.getMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      await expect(service.getMessages('c1', 'me', {})).resolves.toEqual({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('fetches limit + 1 rows, returns `limit`, and cursors the oldest returned row at its exact timestamp', async () => {
      const qb = makeQb();
      const messageRow = (id: string, createdAt: string) => ({
        id,
        conversationId: 'c1',
        senderId: 'them',
        body: 'hi',
        createdAt: new Date(createdAt),
        editedAt: null,
      });
      const newestRow = messageRow(
        '33333333-3333-4333-8333-333333333333',
        '2026-01-01T00:00:00.125Z',
      );
      // The JS Date only holds .123; Postgres holds .123456 (see the raw row).
      const boundaryRow = messageRow(
        '22222222-2222-4222-8222-222222222222',
        '2026-01-01T00:00:00.123Z',
      );
      const probeRow = messageRow(
        '11111111-1111-4111-8111-111111111111',
        '2026-01-01T00:00:00.123Z',
      );
      qb.getRawAndEntities.mockResolvedValue({
        entities: [newestRow, boundaryRow, probeRow],
        raw: [
          {
            m_id: newestRow.id,
            cursor_created_at: '2026-01-01T00:00:00.125000Z',
          },
          {
            m_id: boundaryRow.id,
            cursor_created_at: '2026-01-01T00:00:00.123456Z',
          },
          {
            m_id: probeRow.id,
            cursor_created_at: '2026-01-01T00:00:00.123400Z',
          },
        ],
      });
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getMessages('c1', 'me', { limit: 2 });

      expect(qb.take).toHaveBeenCalledWith(3);
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('HH24:MI:SS.US'),
        'cursor_created_at',
      );
      expect(result.data.map((message) => message.id)).toEqual([
        newestRow.id,
        boundaryRow.id,
      ]);
      expect(result.pageInfo).toEqual({
        hasMore: true,
        nextCursor: Buffer.from(
          `2026-01-01T00:00:00.123456Z|${boundaryRow.id}`,
        ).toString('base64'),
      });
    });

    // Defensive only: with no join every entity has a raw row. If one is ever
    // missing the page still gets a cursor, at millisecond precision.
    it('falls back to a millisecond cursor when the oldest row has no raw timestamp', async () => {
      const qb = makeQb();
      const messageRow = (id: string, createdAt: string) => ({
        id,
        conversationId: 'c1',
        senderId: 'them',
        body: 'hi',
        createdAt: new Date(createdAt),
        editedAt: null,
      });
      const oldestReturnedRow = messageRow(
        '22222222-2222-4222-8222-222222222222',
        '2026-01-01T00:00:00.123Z',
      );
      const probeRow = messageRow(
        '11111111-1111-4111-8111-111111111111',
        '2026-01-01T00:00:00.100Z',
      );
      qb.getRawAndEntities.mockResolvedValue({
        entities: [oldestReturnedRow, probeRow],
        raw: [
          {
            m_id: probeRow.id,
            cursor_created_at: '2026-01-01T00:00:00.100000Z',
          },
        ],
      });
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getMessages('c1', 'me', { limit: 1 });

      expect(result.pageInfo).toEqual({
        hasMore: true,
        nextCursor: Buffer.from(
          `2026-01-01T00:00:00.123Z|${oldestReturnedRow.id}`,
        ).toString('base64'),
      });
    });

    it('reports no further page when at most `limit` rows come back', async () => {
      const qb = makeQb();
      qb.getMany.mockResolvedValue([
        {
          id: 'm1',
          conversationId: 'c1',
          senderId: 'them',
          body: 'hi',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          editedAt: null,
        },
      ]);
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getMessages('c1', 'me', { limit: 1 });

      expect(qb.take).toHaveBeenCalledWith(2);
      expect(result.data).toHaveLength(1);
      expect(result.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    });

    // Same-millisecond boundary: `messages.created_at` stores microseconds. A
    // millisecond cursor (.123) for a boundary row at .123456 would make the
    // strict tuple `<` treat every older row in [.123000, .123456) as newer,
    // so those rows would never appear on any page. The cursor text is bound
    // verbatim instead.
    it('binds a microsecond cursor verbatim so rows sharing the boundary millisecond are not skipped', async () => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);
      const cursor = Buffer.from(
        '2026-01-01T00:00:00.123456Z|22222222-2222-4222-8222-222222222222',
      ).toString('base64');

      await service.getMessages('c1', 'me', { cursor });

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        {
          before: '2026-01-01T00:00:00.123456Z',
          beforeId: '22222222-2222-4222-8222-222222222222',
        },
      );
    });

    // Both halves are cast in SQL (`::timestamptz`, `::uuid`), so a forged value
    // must fall back to the first page instead of surfacing as a 500.
    it.each([
      ['a non-uuid id', '2026-01-01T00:00:00.000Z|not-a-uuid'],
      [
        'an impossible date',
        '2026-02-30T00:00:00.000Z|22222222-2222-4222-8222-222222222222',
      ],
    ])('treats a cursor with %s as no cursor', async (_label, rawCursor) => {
      const qb = makeQb();
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getMessages('c1', 'me', {
        cursor: Buffer.from(rawCursor).toString('base64'),
      });

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        expect.anything(),
      );
    });

    it('keeps the forward reconcile path (`after`) a bare array', async () => {
      const qb = makeQb();
      qb.getMany.mockResolvedValue([
        {
          id: 'm1',
          conversationId: 'c1',
          senderId: 'them',
          body: 'hi',
          createdAt: new Date('2026-01-02T00:00:00Z'),
          editedAt: null,
        },
      ]);
      messages.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getMessages('c1', 'me', {
        after: '2026-01-01T00:00:00.000Z',
        afterId: '11111111-1111-4111-8111-111111111111',
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result.map((message) => message.id)).toEqual(['m1']);
      expect(qb.take).toHaveBeenCalledWith(30);
      expect(qb.getRawAndEntities).not.toHaveBeenCalled();
    });
  });

  describe('clearedAt filtering', () => {
    it('unread count query floors on cleared_at', async () => {
      const queryBuilder = makeQb();
      queryBuilder.getRawMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValue(queryBuilder);

      // `unreadCountsByConversation` now lives on the shared
      // `MessagingCoreService` (extracted from the god `MessagingService`),
      // not the facade — every split concern calls through it.
      await core.unreadCountsByConversation(['conv-1'], 'user-1');

      const predicates = queryBuilder.andWhere.mock.calls
        .map((call: [string]) => call[0])
        .join(' | ');
      expect(predicates).toContain('cleared_at');
    });

    it('getMessages floors history at the caller cleared_at', async () => {
      participants.findOne.mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        clearedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const queryBuilder = makeQb();
      queryBuilder.getMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.getMessages('conv-1', 'user-1', {});

      // The query-builder predicate binds the floor via a `:clearedAt`
      // parameter placeholder (camelCase, no underscore) rather than the raw
      // `cleared_at` column name — unlike the unread-count query above, which
      // embeds the column directly in a hand-written NULL-safe clause.
      const predicates = queryBuilder.andWhere.mock.calls
        .map((call: [string]) => call[0])
        .join(' | ');
      expect(predicates).toContain('m.created_at > :clearedAt');
      const boundParams = queryBuilder.andWhere.mock.calls.map(
        (call: [string, Record<string, string>?]) => call[1],
      );
      expect(boundParams).toContainEqual({
        clearedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    // P0 hardening: a removed/left group member kept unbounded read access
    // (and forward reconnect-sync access) to everything posted after they
    // left — `leftAt` now ceilings both the same way `clearedAt` floors them.
    it('getMessages ceilings history at the caller leftAt (P0)', async () => {
      participants.findOne.mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        leftAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const queryBuilder = makeQb();
      queryBuilder.getMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.getMessages('conv-1', 'user-1', {});

      const predicates = queryBuilder.andWhere.mock.calls
        .map((call: [string]) => call[0])
        .join(' | ');
      expect(predicates).toContain('m.created_at <= :leftAt');
      const boundParams = queryBuilder.andWhere.mock.calls.map(
        (call: [string, Record<string, string>?]) => call[1],
      );
      expect(boundParams).toContainEqual({
        leftAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('getMessages forward reconnect-sync (`after`) also ceilings at leftAt', async () => {
      participants.findOne.mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        leftAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const queryBuilder = makeQb();
      queryBuilder.getMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.getMessages('conv-1', 'user-1', {
        after: '2026-01-02T00:00:00.000Z',
      });

      const predicates = queryBuilder.andWhere.mock.calls
        .map((call: [string]) => call[0])
        .join(' | ');
      expect(predicates).toContain('m.created_at <= :leftAt');
    });

    // PRD-354: a block does not dissolve a GROUP, so a blocked-either-way
    // sender's messages otherwise keep showing to every other member.
    it('getMessages applies the block filter IN SQL for a GROUP conversation', async () => {
      participants.findOne.mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        clearedAt: null,
        leftAt: null,
      });
      conversations.findOne.mockResolvedValue({
        id: 'conv-1',
        kind: ConversationKind.Group,
      });
      const queryBuilder = makeQb();
      queryBuilder.getMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.getMessages('conv-1', 'user-1', {});

      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        'user-1',
        '"m"."sender_id"',
      );
    });

    it('getMessages does NOT apply the block filter for a DM', async () => {
      participants.findOne.mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        clearedAt: null,
        leftAt: null,
      });
      conversations.findOne.mockResolvedValue({
        id: 'conv-1',
        kind: ConversationKind.Direct,
      });
      const queryBuilder = makeQb();
      queryBuilder.getMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.getMessages('conv-1', 'user-1', {});

      expect(blockFilter.excludeBlocked).not.toHaveBeenCalled();
    });

    it('getMessages forward reconnect-sync (`after`) also applies the block filter for a GROUP', async () => {
      participants.findOne.mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        clearedAt: null,
        leftAt: null,
      });
      conversations.findOne.mockResolvedValue({
        id: 'conv-1',
        kind: ConversationKind.Group,
      });
      const queryBuilder = makeQb();
      queryBuilder.getMany.mockResolvedValue([]);
      messages.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.getMessages('conv-1', 'user-1', {
        after: '2026-01-02T00:00:00.000Z',
      });

      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        'user-1',
        '"m"."sender_id"',
      );
    });
  });

  describe('canJoinConversationLive', () => {
    it('refuses a participant who left/was removed from a group (P0)', async () => {
      participants.findOne.mockResolvedValueOnce({
        conversationId: 'c1',
        userId: 'me',
        leftAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      await expect(service.canJoinConversationLive('c1', 'me')).resolves.toBe(
        false,
      );
    });

    it('refuses a DM whose counterpart is blocked either way (P0)', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
      await expect(service.canJoinConversationLive('c1', 'me')).resolves.toBe(
        false,
      );
    });

    it('allows a normal, unblocked, still-present participant', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      await expect(service.canJoinConversationLive('c1', 'me')).resolves.toBe(
        true,
      );
    });
  });

  describe('markRead', () => {
    // `requireActiveParticipant` runs its blocked-counterpart probe on its own
    // builder before `markRead` builds the UPDATE, so the update builder is the
    // SECOND one handed out. Pin both so the assertions below read the right one.
    function stubMarkReadBuilders(): { probe: MockQb; update: MockQb } {
      const probe = makeQb();
      const update = makeQb();
      participants.createQueryBuilder
        .mockReturnValueOnce(probe)
        .mockReturnValueOnce(update);
      return { probe, update };
    }

    it('stamps both watermarks with a DB-side expression and emits the DB value', async () => {
      const dbTime = new Date('2026-06-30T12:00:00Z');
      participants.findOne
        // requireParticipant
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        // re-read after the DB-side update
        .mockResolvedValueOnce({
          conversationId: 'c1',
          userId: 'me',
          lastReadAt: dbTime,
        });
      const { update } = stubMarkReadBuilders();

      const result = await service.markRead('c1', 'me');

      expect(result).toEqual({ ok: true });
      const [values] = update.set.mock.calls[0] as [
        { lastReadAt: () => string; deliveredAt: () => string },
      ];
      // Both values are raw SQL, so Postgres (not the app server) resolves the
      // time, and GREATEST keeps the watermark monotonic.
      expect(values.lastReadAt()).toBe('GREATEST(last_read_at, now())');
      expect(values.deliveredAt()).toBe('GREATEST(delivered_at, now())');
      expect(update.execute).toHaveBeenCalled();
      // Does NOT save the participant entity with an app-server Date.
      expect(participants.save).not.toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledWith(
        'message.read',
        expect.objectContaining({ lastReadAt: dbTime }),
      );
    });

    // REGRESSION (BE-MSG-20): the watermark used to be `now()` unconditionally,
    // so a message that arrived between the client's last fetch and its `read`
    // frame was marked read without ever being rendered.
    it("stamps the named message's own created_at when `upToMessageId` is given", async () => {
      const messageTime = new Date('2026-06-30T11:59:00Z');
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({
          conversationId: 'c1',
          userId: 'me',
          lastReadAt: messageTime,
        });
      messages.findOne.mockResolvedValueOnce({
        id: 'm1',
        createdAt: messageTime,
      });
      const { update } = stubMarkReadBuilders();

      await service.markRead('c1', 'me', { upToMessageId: 'm1' });

      const [values] = update.set.mock.calls[0] as [
        { lastReadAt: () => string },
      ];
      expect(values.lastReadAt()).toBe(
        'GREATEST(last_read_at, LEAST(:watermark::timestamptz, now()))',
      );
      expect(update.setParameter).toHaveBeenCalledWith(
        'watermark',
        messageTime.toISOString(),
      );
    });

    it('404s when `upToMessageId` is not a message in this conversation', async () => {
      participants.findOne.mockResolvedValueOnce({
        conversationId: 'c1',
        userId: 'me',
      });
      messages.findOne.mockResolvedValueOnce(null);
      await expect(
        service.markRead('c1', 'me', { upToMessageId: 'm-elsewhere' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a non-participant before touching the DB', async () => {
      participants.findOne.mockResolvedValueOnce(null);
      await expect(service.markRead('c1', 'ghost')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(participants.update).not.toHaveBeenCalled();
    });
  });

  describe('clearConversation', () => {
    it('stamps the caller participant cleared_at with the DB clock', async () => {
      participants.findOne.mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
      });
      participants.update.mockResolvedValue({ affected: 1 });

      const result = await service.clearConversation('conv-1', 'user-1');

      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'conv-1', userId: 'user-1' },
        { clearedAt: expect.any(Function) as unknown },
      );
      expect(result).toEqual({ ok: true });
    });

    it('rejects a non-participant', async () => {
      participants.findOne.mockResolvedValue(null);
      await expect(
        service.clearConversation('conv-1', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(participants.update).not.toHaveBeenCalled();
    });
  });

  describe('setMuted', () => {
    it('updates the participant with the new muted flag', async () => {
      participants.findOne.mockResolvedValueOnce({
        conversationId: 'c1',
        userId: 'me',
        muted: false,
      });
      const result = await service.setMuted('c1', 'me', true);
      expect(result).toEqual({ ok: true });
      // ENG-247: a targeted UPDATE on the columns this preference owns, not
      // a load-then-save() of the whole participant row.
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        expect.objectContaining({ muted: true }),
      );
    });
  });

  describe('sendMessage', () => {
    it('rejects a non-participant', async () => {
      participants.findOne.mockResolvedValueOnce(null);
      await expect(
        service.sendMessage('c1', 'intruder', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when the participants are no longer connected', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(false);
      await expect(
        service.sendMessage('c1', 'me', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // P0 hardening: a `blocks` row is a hard stop even if the `connections`
    // edge somehow still reads Accepted — defense-in-depth alongside the
    // transactional sever in `SocialService.blockMember`.
    it('rejects a send when either party has blocked the other, even if still marked accepted-connected', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(true);
      blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
      await expect(
        service.sendMessage('c1', 'me', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('me', 'them');
    });

    it('rejects a sender whose account is no longer active (BE-MSG-02)', async () => {
      // A moderator suspension goes dark on HTTP immediately (JwtStrategy
      // re-reads the row per request) but the websocket only checked `status`
      // in the handshake claim — this is the shared write-path assertion.
      usersService.findById.mockResolvedValue({
        id: 'me',
        status: UserStatus.Suspended,
      });
      await expect(
        service.sendMessage('c1', 'me', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(participants.findOne).not.toHaveBeenCalled();
    });

    it('persists and emits message.created on a valid send', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(true);

      const result = await service.sendMessage('c1', 'me', 'hello');
      expect(result.body).toBe('hello');
      expect(emitter.emit).toHaveBeenCalledWith(
        'message.created',
        expect.objectContaining({ conversationId: 'c1' }),
      );
    });

    it('returns a MessageResponse carrying the sender, not the internal view', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(true);
      messages.save.mockResolvedValueOnce({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        body: 'hello',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        editedAt: null,
        deletedAt: null,
      });
      profiles.find.mockResolvedValueOnce([
        {
          userId: 'me',
          slug: 'me-handle',
          firstName: 'Me',
          lastName: 'Myself',
          avatarUrl: null,
        },
      ]);

      const result = await service.sendMessage('c1', 'me', 'hello');

      expect(result).toEqual({
        id: 'm1',
        conversationId: 'c1',
        body: 'hello',
        sender: {
          handle: 'me-handle',
          displayName: 'Me Myself',
          avatarUrl: null,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        editedAt: null,
        reactions: emptyReactions(),
        deletedAt: null,
        deliveredAt: null,
        clientMessageId: undefined,
        forwarded: undefined,
        pinnedAt: null,
        starred: false,
        canPin: true,
        // The caller authored this send: deletable by them, past the edit
        // window (mocked createdAt is months old), and not self-reportable.
        canEdit: false,
        canDelete: true,
        canReport: false,
        replyTo: null,
        kind: 'user',
        attachment: null,
        systemEvent: null,
      });
      expect(result).not.toHaveProperty('senderId');
    });

    it('still emits the internal MessageView (with senderId) on message.created', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({ id: 'c1', isOfficial: false });
      connections.areConnected.mockResolvedValue(true);

      await service.sendMessage('c1', 'me', 'hello');

      // The event payload is internal (chat.gateway consumers), and is
      // deliberately NOT remapped to the frontend contract here.
      const emitCalls = emitter.emit.mock.calls as [
        string,
        MessageCreatedEvent,
      ][];
      const [eventName, payload] = emitCalls[0]!;
      expect(eventName).toBe('message.created');
      expect(payload.conversationId).toBe('c1');
      expect(payload.message.senderId).toBe('me');
      expect(payload.message.body).toBe('hello');
    });

    // PRD-221: mentioning the ONE person a 1:1 DM could possibly be to is
    // always the same fact its own delivery already told them.
    it('excludes the DM counterpart from the mention fan-out (PRD-221)', async () => {
      participants.findOne
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
        .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
      conversations.findOne.mockResolvedValue({
        id: 'c1',
        kind: ConversationKind.Direct,
        isOfficial: false,
      });
      connections.areConnected.mockResolvedValue(true);

      await service.sendMessage('c1', 'me', '@them are you free tonight?');

      expect(mentions.notify).toHaveBeenCalledTimes(1);
      const [, , , excludeUserIds] = mentions.notify.mock.calls[0]!;
      expect(excludeUserIds).toEqual(['them']);
    });

    // A group has no single counterpart — the generic "new message" push is
    // shared by every member, so a mention of a fellow participant still
    // carries real "this one's about you" information and must not be
    // suppressed the way the 1:1 case is above.
    it('does not exclude anyone from the mention fan-out for a GROUP send', async () => {
      participants.findOne.mockResolvedValueOnce({
        conversationId: 'g1',
        userId: 'me',
      });
      conversations.findOne.mockResolvedValue({
        id: 'g1',
        kind: ConversationKind.Group,
        isOfficial: false,
      });

      await service.sendMessage('g1', 'me', '@teammate check this out');

      expect(mentions.notify).toHaveBeenCalledTimes(1);
      const [, , , excludeUserIds] = mentions.notify.mock.calls[0]!;
      expect(excludeUserIds).toEqual([]);
    });

    // PRD-340 (one-tap reply): a non-connected 1:1 thread is no longer an
    // unconditional dead end for both sides.
    describe('the one-tap-reply gate (PRD-340)', () => {
      it('lets the member who did NOT initiate the thread send, and opens it', async () => {
        participants.findOne
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
        conversations.findOne.mockResolvedValue({
          id: 'c1',
          isOfficial: false,
          initiatorUserId: 'them', // 'me' (the sender here) did NOT start it
          openedAt: null,
        });
        connections.areConnected.mockResolvedValue(false);

        await expect(
          service.sendMessage('c1', 'me', 'hi'),
        ).resolves.toBeDefined();
        expect(conversations.update).toHaveBeenCalledWith('c1', {
          openedAt: expect.any(Date),
        });
      });

      it('still refuses the INITIATOR until the other side has replied', async () => {
        participants.findOne
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
        conversations.findOne.mockResolvedValue({
          id: 'c1',
          isOfficial: false,
          initiatorUserId: 'me', // the SENDER here started the thread
          openedAt: null,
        });
        connections.areConnected.mockResolvedValue(false);

        await expect(
          service.sendMessage('c1', 'me', 'are you there?'),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(conversations.update).not.toHaveBeenCalled();
      });

      it('lets EITHER side send once the thread has been opened', async () => {
        participants.findOne
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
        conversations.findOne.mockResolvedValue({
          id: 'c1',
          isOfficial: false,
          initiatorUserId: 'me', // the sender started it, but it is now open
          openedAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        connections.areConnected.mockResolvedValue(false);

        await expect(
          service.sendMessage('c1', 'me', 'following up'),
        ).resolves.toBeDefined();
        // Already open, so no need to flip it again.
        expect(conversations.update).not.toHaveBeenCalled();
      });

      // A pre-migration DM with no messages ever sent has no known initiator
      // (see the backfill migration's own comment). The platform's original,
      // unconditional rule still applies to it.
      it('keeps refusing both sides of a pre-migration thread with no known initiator', async () => {
        participants.findOne
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
        conversations.findOne.mockResolvedValue({
          id: 'c1',
          isOfficial: false,
          initiatorUserId: null,
          openedAt: null,
        });
        connections.areConnected.mockResolvedValue(false);

        await expect(
          service.sendMessage('c1', 'me', 'hello?'),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      // BLOCKING safety case: two members were connected, exchanged messages,
      // then disconnected. Neither the backfill migration nor the live gate
      // may infer "opened" from that ordinary history (only the explicit
      // mechanism opens a thread), so the thread has NO recorded initiator
      // and BOTH sides stay refused after the disconnect, not just one.
      it('keeps refusing BOTH sides of a formerly-connected pair whose DM has no recorded initiator', async () => {
        conversations.findOne.mockResolvedValue({
          id: 'c1',
          isOfficial: false,
          initiatorUserId: null,
          openedAt: null,
        });
        connections.areConnected.mockResolvedValue(false);

        participants.findOne
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' })
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' });
        await expect(
          service.sendMessage('c1', 'me', 'hey, still there?'),
        ).rejects.toBeInstanceOf(ForbiddenException);

        participants.findOne
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'them' })
          .mockResolvedValueOnce({ conversationId: 'c1', userId: 'me' });
        await expect(
          service.sendMessage('c1', 'them', 'hey, still there?'),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });

  describe('messageRequest', () => {
    it('rejects when either party has blocked the other', async () => {
      profiles.findOne.mockResolvedValueOnce({ userId: 'them', slug: 'them' });
      blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
      await expect(
        service.messageRequest('me', 'them', 'hi there'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('me', 'them');
      expect(connections.areConnected).not.toHaveBeenCalled();
      expect(connections.requestConnection).not.toHaveBeenCalled();
    });

    it('when already connected: materializes a conversation and posts the message', async () => {
      profiles.findOne.mockResolvedValueOnce({ userId: 'them', slug: 'them' });
      connections.areConnected.mockResolvedValue(true);
      // getOrCreateConversation finds an existing thread (no transaction).
      conversations.findOne.mockResolvedValueOnce({
        id: 'c9',
        isOfficial: false,
      });

      const result = await service.messageRequest('me', 'them', 'hey');

      expect(result.conversationId).toBe('c9');
      expect(result.message?.body).toBe('hey');
      expect(result.connectionRequestId).toBeNull();
      expect(connections.requestConnection).not.toHaveBeenCalled();
    });

    it('when a stranger: seeds a connection request instead of a message', async () => {
      profiles.findOne.mockResolvedValueOnce({ userId: 'them', slug: 'them' });
      connections.areConnected.mockResolvedValue(false);
      connections.requestConnection.mockResolvedValue({ id: 'conn-1' });

      const result = await service.messageRequest('me', 'them', 'hi there');

      expect(result.conversationId).toBeNull();
      expect(result.message).toBeNull();
      expect(result.connectionRequestId).toBe('conn-1');
      expect(connections.requestConnection).toHaveBeenCalledWith(
        'me',
        'them',
        'hi there',
      );
    });
  });

  describe('enquiryContactability (PRD-340)', () => {
    it('never requires a connection to reply while the enquiry can be delivered, and says so truthfully whether or not they are connected', async () => {
      connections.areConnected.mockResolvedValueOnce(false);
      const notConnected = await messageRequestsService.enquiryContactability(
        'me',
        'them',
      );
      expect(notConnected).toEqual({
        canDeliver: true,
        blockedReason: null,
        replyRequiresConnection: false,
        followUpAwaitsReply: true,
      });

      connections.areConnected.mockResolvedValueOnce(true);
      const alreadyConnected =
        await messageRequestsService.enquiryContactability('me', 'them');
      expect(alreadyConnected).toEqual({
        canDeliver: true,
        blockedReason: null,
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      });
    });

    it('still refuses self-enquiry and a block either way, regardless of connection', async () => {
      const self = await messageRequestsService.enquiryContactability(
        'me',
        'me',
      );
      expect(self).toEqual({
        canDeliver: false,
        blockedReason: 'self',
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      });

      blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
      const blocked = await messageRequestsService.enquiryContactability(
        'me',
        'them',
      );
      expect(blocked).toEqual({
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
      });
      // Self and block short-circuit before the connection lookup: nothing
      // will be delivered, so there is nothing to explain to the enquirer.
      expect(connections.areConnected).not.toHaveBeenCalled();
    });
  });

  describe('deliverEnquiry (PRD-340)', () => {
    it('claims the initiator on an EXISTING thread that has none yet, since a fresh enquiry is itself fresh cold contact', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: 'c1',
        isOfficial: false,
        pairKey: 'me:them',
        initiatorUserId: null,
        openedAt: null,
      });

      await messageRequestsService.deliverEnquiry(
        'me',
        'them',
        'Is this room still available?',
      );

      expect(conversations.update).toHaveBeenCalledWith('c1', {
        initiatorUserId: 'me',
      });
    });

    it('does NOT claim the initiator on an existing thread that already has one', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: 'c1',
        isOfficial: false,
        pairKey: 'me:them',
        initiatorUserId: 'them',
        openedAt: null,
      });

      await messageRequestsService.deliverEnquiry('me', 'them', 'hi again');

      expect(conversations.update).not.toHaveBeenCalled();
    });

    it('does NOT claim the initiator on an existing thread that is already open', async () => {
      conversations.findOne.mockResolvedValueOnce({
        id: 'c1',
        isOfficial: false,
        pairKey: 'me:them',
        initiatorUserId: 'them',
        openedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await messageRequestsService.deliverEnquiry('me', 'them', 'hi again');

      expect(conversations.update).not.toHaveBeenCalled();
    });
  });

  describe('createConversation', () => {
    const recipient = {
      userId: 'them',
      slug: 'tam-rivera',
      firstName: 'Tam',
      lastName: 'Rivera',
      avatarUrl: null,
    };

    it('creates a new DM when none exists and returns a ConversationResponse', async () => {
      profiles.findOne.mockResolvedValueOnce(recipient);
      // getOrCreateConversation: no existing pairKey row -> materializes one.
      conversations.findOne.mockResolvedValueOnce(null);
      const created = {
        id: 'convo-1',
        isOfficial: false,
        pairKey: 'me:them',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      dataSource.transaction.mockResolvedValueOnce(created);
      // toConversationResponse: profile lookup for both participants, plus
      // the last-message/unread-count query-builder queries (no rows yet).
      profiles.find.mockResolvedValueOnce([recipient]);
      messages.createQueryBuilder
        .mockReturnValueOnce(makeQb()) // lastMessagesByConversation
        .mockReturnValueOnce(makeQb()); // unreadCountsByConversation

      const result = await service.createConversation('me', 'tam-rivera');

      expect(result.id).toBe('convo-1');
      expect(result.type).toBe('dm');
      expect(result.otherParticipant).toEqual({
        handle: 'tam-rivera',
        displayName: 'Tam Rivera',
        avatarUrl: null,
      });
      expect(result.lastMessage).toBeNull();
      expect(result.unreadCount).toBe(0);
      // Default fixture: `connections.areConnected` resolves true.
      expect(result.replyRequiresConnection).toBe(false);
    });

    // PRD-343: a FRESH thread between two non-connections is now refused
    // outright. Cold first contact goes through a message request/enquiry
    // instead, which seeds an explicit `initiatorUserId` this endpoint does
    // not. Supersedes the old "sets replyRequiresConnection" case, which
    // exercised exactly this create-a-fresh-non-connected-thread path and
    // expected it to succeed; that is no longer this endpoint's contract.
    it('refuses to create a FRESH thread between two members who are not accepted connections (PRD-343)', async () => {
      profiles.findOne.mockResolvedValueOnce(recipient);
      connections.areConnected.mockResolvedValueOnce(false);
      // The gate's own existing-thread lookup (by pairKey): no row yet.
      conversations.findOne.mockResolvedValueOnce(null);

      await expect(
        service.createConversation('me', 'tam-rivera'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    // PRD-340/343: an EXISTING thread the reply gate already reads "open" for
    // THIS caller. Here, the caller did not initiate it, so their very next
    // ordinary reply is allowed, and it is still returned rather than
    // refused, even though the two are not accepted connections.
    it('reuses an EXISTING thread the reply gate already reads open for this caller (PRD-340)', async () => {
      profiles.findOne.mockResolvedValueOnce(recipient);
      connections.areConnected.mockResolvedValueOnce(false); // the gate's own check
      const existingConversation = {
        id: 'convo-open',
        isOfficial: false,
        pairKey: 'me:them',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        initiatorUserId: 'them', // the OTHER member started this thread
        openedAt: null,
      };
      conversations.findOne.mockResolvedValue(existingConversation);
      profiles.find.mockResolvedValueOnce([recipient]);
      messages.createQueryBuilder
        .mockReturnValueOnce(makeQb())
        .mockReturnValueOnce(makeQb());
      connections.areConnected.mockResolvedValueOnce(false); // toConversationResponse's own check

      const result = await service.createConversation('me', 'tam-rivera');

      expect(result.id).toBe('convo-open');
      expect(result.replyGate).toBe('open');
      expect(result.replyRequiresConnection).toBe(false);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    // The mirror image: an existing thread exists, but THIS caller is the one
    // who started it and the other side hasn't replied yet, so still refused.
    it('still refuses when an existing thread is awaiting the OTHER side to reply, not this caller (PRD-340)', async () => {
      profiles.findOne.mockResolvedValueOnce(recipient);
      connections.areConnected.mockResolvedValueOnce(false);
      conversations.findOne.mockResolvedValueOnce({
        id: 'convo-awaiting',
        isOfficial: false,
        pairKey: 'me:them',
        initiatorUserId: 'me',
        openedAt: null,
      });

      await expect(
        service.createConversation('me', 'tam-rivera'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is idempotent: calling twice returns the same conversation id, only creating once', async () => {
      profiles.findOne.mockResolvedValue(recipient);
      profiles.find.mockResolvedValue([recipient]);
      messages.createQueryBuilder.mockImplementation(() => makeQb());

      // First call: no existing conversation, materializes one.
      conversations.findOne.mockResolvedValueOnce(null);
      const created = {
        id: 'convo-1',
        isOfficial: false,
        pairKey: 'me:them',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      dataSource.transaction.mockResolvedValueOnce(created);
      const first = await service.createConversation('me', 'tam-rivera');

      // Second call: the same pairKey row now exists -> reused, no transaction.
      conversations.findOne.mockResolvedValueOnce(created);
      const second = await service.createConversation('me', 'tam-rivera');

      expect(first.id).toBe('convo-1');
      expect(second.id).toBe('convo-1');
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('floors the preview at the caller cleared_at: a thread the caller previously cleared does not leak its pre-clear last message back through POST /conversations', async () => {
      profiles.findOne.mockResolvedValueOnce(recipient);
      // Reuse path: the pairKey conversation already exists, so no transaction
      // is needed — mirrors the "is idempotent" second call above.
      const existingConversation = {
        id: 'convo-1',
        isOfficial: false,
        pairKey: 'me:them',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      };
      conversations.findOne.mockResolvedValueOnce(existingConversation);
      profiles.find.mockResolvedValueOnce([recipient]);

      const lastMessageBeforeClear = {
        id: 'msg-1',
        conversationId: 'convo-1',
        senderId: 'them',
        body: 'pre-clear history',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      };
      const lastMessageQb = makeQb();
      lastMessageQb.getMany.mockResolvedValueOnce([lastMessageBeforeClear]);
      messages.createQueryBuilder
        .mockReturnValueOnce(lastMessageQb) // lastMessagesByConversation
        .mockReturnValueOnce(makeQb()); // unreadCountsByConversation

      // toConversationResponse reads the OTHER participant row first, then the
      // CALLER's — the caller's clearedAt is newer than the last message above.
      participants.findOne
        .mockResolvedValueOnce({
          conversationId: 'convo-1',
          userId: 'them',
          clearedAt: null,
          lastReadAt: null,
        })
        .mockResolvedValueOnce({
          conversationId: 'convo-1',
          userId: 'me',
          clearedAt: new Date('2026-07-15T00:00:00.000Z'),
        });

      const result = await service.createConversation('me', 'tam-rivera');

      expect(result.lastMessage).toBeNull();
      expect(result.updatedAt).toBe(
        existingConversation.createdAt.toISOString(),
      );
    });

    it('404s when recipientHandle does not resolve to a member', async () => {
      profiles.findOne.mockResolvedValueOnce(null);
      await expect(
        service.createConversation('me', 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400s when recipientHandle resolves to the caller themself', async () => {
      profiles.findOne.mockResolvedValueOnce({ ...recipient, userId: 'me' });
      await expect(
        service.createConversation('me', 'my-own-slug'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when either party has blocked the other', async () => {
      profiles.findOne.mockResolvedValueOnce(recipient);
      blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
      await expect(
        service.createConversation('me', 'tam-rivera'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith('me', 'them');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreateConversation (via CONNECTION_ACCEPTED)', () => {
    it('recovers from a concurrent create race (23505) by returning the winner', async () => {
      // First lookup misses → we attempt to create.
      conversations.findOne
        .mockResolvedValueOnce(null)
        // After the unique-violation, the winner is fetched.
        .mockResolvedValueOnce({ id: 'winner', isOfficial: false });
      const unique = new QueryFailedError('INSERT', [], {
        code: '23505',
      } as never);
      dataSource.transaction.mockRejectedValueOnce(unique);

      await expect(
        messageRequestsService.handleConnectionAccepted({
          connectionId: 'x',
          requesterId: 'a',
          addresseeId: 'b',
          requestMessage: null,
        }),
      ).resolves.toBeUndefined();

      // No seed message posted (created === false on the recovered winner).
      expect(messages.save).not.toHaveBeenCalled();
    });

    it('re-throws a non-unique-violation error', async () => {
      conversations.findOne.mockResolvedValueOnce(null);
      dataSource.transaction.mockRejectedValueOnce(new Error('boom'));
      await expect(
        messageRequestsService.handleConnectionAccepted({
          connectionId: 'x',
          requesterId: 'a',
          addresseeId: 'b',
          requestMessage: null,
        }),
      ).rejects.toThrow('boom');
    });
  });
  describe('deleteMessage attachment purge', () => {
    const IMAGE_KEY =
      'message-images/me/11111111-1111-4111-8111-111111111111.jpg';
    const DOCUMENT_KEY =
      'message-documents/me/22222222-2222-4222-8222-222222222222.pdf';

    /** A participant row for `me`, so `requireParticipant` resolves. */
    function stubParticipant(): void {
      participants.findOne.mockResolvedValue({
        conversationId: 'c1',
        userId: 'me',
        clearedAt: null,
        leftAt: null,
      });
    }

    /**
     * Wire the two builders `deleteMessage` runs, in order: the conditional
     * soft-delete UPDATE (terminal `execute`), then — only when that affected a
     * row — the "is this key still referenced by a LIVE message?" probe
     * (terminal `getExists`).
     */
    function stubDeleteThenReferenceProbe(options: {
      affected: number;
      stillReferenced: boolean;
    }): { update: MockQb; probe: MockQb } {
      const update = makeQb();
      update.execute.mockResolvedValue({ affected: options.affected });
      const probe = makeQb();
      probe.getExists.mockResolvedValue(options.stillReferenced);
      messages.createQueryBuilder
        .mockReturnValueOnce(update)
        .mockReturnValueOnce(probe);
      return { update, probe };
    }

    beforeEach(() => {
      stubParticipant();
    });

    it('deletes the stored object behind an image attachment nothing else references', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        deletedAt: null,
        attachment: {
          url: IMAGE_KEY,
          previewUrl: IMAGE_KEY,
          provider: 'upload',
        },
      });
      stubDeleteThenReferenceProbe({ affected: 1, stillReferenced: false });

      await expect(service.deleteMessage('c1', 'm1', 'me')).resolves.toEqual({
        ok: true,
      });

      // `url` and `previewUrl` are the same key for an uploaded image, so the
      // object is deleted ONCE, not twice.
      expect(storage.deleteObjectByReference).toHaveBeenCalledTimes(1);
      expect(storage.deleteObjectByReference).toHaveBeenCalledWith(IMAGE_KEY);
    });

    it('deletes the stored object behind a document attachment', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        deletedAt: null,
        attachment: {
          url: DOCUMENT_KEY,
          fileName: 'lease.pdf',
          byteSize: 1024,
          contentType: 'application/pdf',
          provider: 'upload',
        },
      });
      stubDeleteThenReferenceProbe({ affected: 1, stillReferenced: false });

      await service.deleteMessage('c1', 'm1', 'me');

      expect(storage.deleteObjectByReference).toHaveBeenCalledWith(
        DOCUMENT_KEY,
      );
    });

    it('KEEPS the object when another live message still references the key (a forward)', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        deletedAt: null,
        attachment: {
          url: IMAGE_KEY,
          previewUrl: IMAGE_KEY,
          provider: 'upload',
        },
      });
      stubDeleteThenReferenceProbe({ affected: 1, stillReferenced: true });

      await service.deleteMessage('c1', 'm1', 'me');

      // A forward reuses the ORIGINAL key rather than copying the object, so
      // deleting here would blank the forwarded copy too.
      expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
    });

    it('never touches storage for a GIF attachment (an absolute provider URL, not our key)', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        deletedAt: null,
        attachment: {
          url: 'https://media.giphy.com/media/abc/giphy.gif',
          previewUrl: 'https://media.giphy.com/media/abc/200w.gif',
          provider: 'giphy',
        },
      });
      stubDeleteThenReferenceProbe({ affected: 1, stillReferenced: false });

      await service.deleteMessage('c1', 'm1', 'me');

      expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
    });

    it('still reports success when the bucket delete throws', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        deletedAt: null,
        attachment: {
          url: IMAGE_KEY,
          previewUrl: IMAGE_KEY,
          provider: 'upload',
        },
      });
      stubDeleteThenReferenceProbe({ affected: 1, stillReferenced: false });
      storage.deleteObjectByReference.mockRejectedValue(new Error('bucket'));

      // The message IS deleted either way; a 500 here would only be retried
      // into an idempotent no-op that never reaches the purge again.
      await expect(service.deleteMessage('c1', 'm1', 'me')).resolves.toEqual({
        ok: true,
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        'message.deleted',
        expect.objectContaining({ conversationId: 'c1', messageId: 'm1' }),
      );
    });

    it('does not purge on a repeat delete of an already-tombstoned message', async () => {
      messages.findOne.mockResolvedValue({
        id: 'm1',
        conversationId: 'c1',
        senderId: 'me',
        deletedAt: new Date(),
        attachment: {
          url: IMAGE_KEY,
          previewUrl: IMAGE_KEY,
          provider: 'upload',
        },
      });

      await expect(service.deleteMessage('c1', 'm1', 'me')).resolves.toEqual({
        ok: true,
      });

      expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});

// DES-220: a reply quote carries its parent's kind plus the media a quote needs
// (a thumbnail for a photo/GIF, a file name for a document), resolved through
// the same `resolveAttachment` path the parent's own bubble uses, and withheld
// once the parent is gone. Absolute `https://` URLs pass `toImageUrl` through
// unchanged, so these cases need no image-URL base configured.
describe('buildReplyTo (DES-220 media quote)', () => {
  type ReplyParent = Pick<
    Message,
    'id' | 'body' | 'senderId' | 'deletedAt' | 'kind' | 'attachment'
  >;
  const profileByUser = new Map<string, Profile>([
    ['ana', { firstName: 'Ana', lastName: 'Silva' } as Profile],
  ]);
  const parentMap = (parent: ReplyParent) =>
    new Map<string, ReplyParent>([[parent.id, parent]]);

  it('reports an image parent with its kind and resolved preview thumbnail', () => {
    const quote = buildReplyTo(
      'p1',
      parentMap({
        id: 'p1',
        body: 'Photo',
        senderId: 'ana',
        deletedAt: null,
        kind: MessageKind.Image,
        attachment: {
          url: 'https://cdn.example/full.jpg',
          previewUrl: 'https://cdn.example/preview.jpg',
          width: 800,
          height: 600,
          provider: 'upload',
        },
      }),
      profileByUser,
    );

    expect(quote).toEqual({
      id: 'p1',
      snippet: 'Photo',
      senderName: 'Ana Silva',
      deleted: false,
      kind: 'image',
      thumbnailUrl: 'https://cdn.example/preview.jpg',
      fileName: null,
    });
  });

  it('reports a document parent with its file name and no thumbnail', () => {
    const quote = buildReplyTo(
      'p2',
      parentMap({
        id: 'p2',
        body: 'Document',
        senderId: 'ana',
        deletedAt: null,
        kind: MessageKind.Document,
        attachment: {
          url: 'https://cdn.example/lease.pdf',
          fileName: 'lease.pdf',
          byteSize: 2048,
          contentType: 'application/pdf',
          provider: 'upload',
        },
      }),
      profileByUser,
    );

    expect(quote).toMatchObject({
      kind: 'document',
      thumbnailUrl: null,
      fileName: 'lease.pdf',
      deleted: false,
    });
  });

  it('keeps the kind but nulls the thumbnail and file name for a deleted parent', () => {
    const quote = buildReplyTo(
      'p3',
      parentMap({
        id: 'p3',
        body: 'Photo',
        senderId: 'ana',
        deletedAt: new Date('2026-01-01T00:00:00Z'),
        kind: MessageKind.Image,
        attachment: {
          url: 'https://cdn.example/full.jpg',
          previewUrl: 'https://cdn.example/preview.jpg',
          width: 800,
          height: 600,
          provider: 'upload',
        },
      }),
      profileByUser,
    );

    expect(quote).toMatchObject({
      deleted: true,
      snippet: '',
      kind: 'image',
      thumbnailUrl: null,
      fileName: null,
    });
  });

  it('withholds the media of a parent a moderator took down for this viewer', () => {
    const quote = buildReplyTo(
      'p4',
      parentMap({
        id: 'p4',
        body: 'Document',
        senderId: 'ana',
        deletedAt: null,
        kind: MessageKind.Document,
        attachment: {
          url: 'https://cdn.example/lease.pdf',
          fileName: 'lease.pdf',
          byteSize: 2048,
          contentType: 'application/pdf',
          provider: 'upload',
        },
      }),
      profileByUser,
      new Set(['p4']),
    );

    expect(quote).toMatchObject({
      deleted: true,
      snippet: '',
      kind: 'document',
      thumbnailUrl: null,
      fileName: null,
    });
  });
});
