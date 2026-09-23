import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { ConnectionsService } from '../connections/connections.service';
import { IdentityKind } from '../identities/entities/identity.entity';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { foldedHaystack, foldedSearchTerm } from '../search/search-text';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { StorageService } from '../storage/storage.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { Message, MessageKind } from './entities/message.entity';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from './message-visibility-predicates';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './messaging.constants';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * ENG-268: spec coverage for `MessagesService.searchMessages`'s scoping,
 * which had none of its own. ENG-252 replaced the old `innerJoin` on
 * `conversation_participants` with a single `EXISTS` that carries the
 * participation gate, the `clearedAt` floor and the `leftAt` ceiling
 * together, specifically so `.take()` never triggers TypeORM's joined
 * distinct-id pagination pass (see `searchMessages`'s own doc). ENG-251
 * added `kind`/`attachment` to every hit and the group identity fields to
 * `MessageSearchConversationGroup`.
 *
 * Scoped to `MessagesService` alone: dependencies `searchMessages` never
 * touches (`MessagingCoreService`, `EventEmitter2`, `ConnectionsService`,
 * `UsersService`, `MentionNotificationService`, `StorageService`) are
 * provided as bare stand-ins rather than real instances. `BlockFilterService`
 * gets a working `excludeBlocked` stand-in instead (PRD-354): a no-op
 * `{}` would throw the moment `searchMessages` calls it.
 *
 * The takedown predicate is asserted by calling the SAME shared
 * `notModeratedMessagePredicate` helper `searchMessages` itself composes
 * with (see `message-visibility-predicates.ts`), rather than a hard-coded
 * copy of the SQL text, so this spec keeps matching regardless of whether a
 * call site still inlines the fragment or has already been switched over to
 * the helper.
 */
describe('MessagesService.searchMessages scoping (ENG-268 / ENG-252 / ENG-251)', () => {
  interface SearchQueryBuilder {
    where: jest.Mock;
    andWhere: jest.Mock;
    innerJoin: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    take: jest.Mock;
    getMany: jest.Mock;
  }

  function makeSearchQb(): SearchQueryBuilder {
    const qb = {} as SearchQueryBuilder;
    const self = (): SearchQueryBuilder => qb;
    qb.where = jest.fn(self);
    qb.andWhere = jest.fn(self);
    qb.innerJoin = jest.fn(self);
    qb.orderBy = jest.fn(self);
    qb.addOrderBy = jest.fn(self);
    qb.take = jest.fn(self);
    qb.getMany = jest.fn().mockResolvedValue([]);
    return qb;
  }

  /**
   * Finds the one `andWhere` call whose SQL fragment satisfies `matcher`,
   * rather than asserting a fixed call index, keeping the spec resilient to
   * the predicates being reordered.
   */
  function findAndWhereCall(
    qb: SearchQueryBuilder,
    matcher: (sql: string) => boolean,
  ): [string, Record<string, unknown>] | undefined {
    const calls = qb.andWhere.mock.calls as [string, Record<string, unknown>][];
    return calls.find(([sql]) => matcher(sql));
  }

  function buildMessageRow(overrides: Partial<Message> = {}): Message {
    return {
      id: 'm1',
      conversationId: 'c1',
      senderId: 'u2',
      body: 'hello world',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      kind: MessageKind.User,
      attachment: null,
      ...overrides,
    } as Message;
  }

  function buildProfile(
    userId: string,
    overrides: Partial<Profile> = {},
  ): Profile {
    return {
      userId,
      slug: userId,
      firstName: 'First',
      lastName: 'Last',
      ...overrides,
    } as Profile;
  }

  function buildConversation(
    overrides: Partial<Conversation> = {},
  ): Conversation {
    return {
      id: 'c1',
      kind: ConversationKind.Direct,
      isOfficial: false,
      title: null,
      avatarUrl: null,
      ...overrides,
    } as Conversation;
  }

  let service: MessagesService;
  let qb: SearchQueryBuilder;
  let messages: { createQueryBuilder: jest.Mock };
  let conversations: { find: jest.Mock };
  let participants: { find: jest.Mock };
  let profiles: { find: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let identities: { getByIds: jest.Mock; describeIdentities: jest.Mock };
  let identityAttribution: { buildStaffNameResolver: jest.Mock };

  beforeEach(async () => {
    identities = {
      getByIds: jest.fn().mockResolvedValue([]),
      describeIdentities: jest.fn().mockResolvedValue(new Map()),
    };
    identityAttribution = {
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
    };
    qb = makeSearchQb();
    messages = { createQueryBuilder: jest.fn(() => qb) };
    conversations = { find: jest.fn().mockResolvedValue([]) };
    participants = { find: jest.fn().mockResolvedValue([]) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    // PRD-354: a pass-through stand-in. The SQL it would append is
    // BlockFilterService's own concern (see `block-filter.service.spec.ts`);
    // this suite only needs the call not to throw, plus its own small
    // assertion below that `searchMessages` actually calls it.
    blockFilter = {
      excludeBlocked: jest.fn(
        (queryBuilder: SearchQueryBuilder) => queryBuilder,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: participants,
        },
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        // Task 13c: search renders its senders and counterparts through the
        // real `MessagingCoreService.loadMessageListContext`, reading the
        // same participant and profile stand-ins as this service.
        {
          provide: MessagingCoreService,
          useValue: Object.assign(
            Object.create(
              MessagingCoreService.prototype,
            ) as MessagingCoreService,
            { participants, profiles, identities, identityAttribution },
          ),
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConnectionsService, useValue: {} },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: UsersService, useValue: {} },
        { provide: MentionNotificationService, useValue: {} },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();
    service = module.get(MessagesService);
  });

  describe('empty/short query handling', () => {
    it('returns no hits for a blank query and never touches the database', async () => {
      const result = await service.searchMessages('me', '   ');
      expect(result).toEqual({ query: '', hits: [], conversations: [] });
      expect(messages.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('echoes back the trimmed query', async () => {
      const result = await service.searchMessages('me', '  hello  ');
      expect(result.query).toBe('hello');
    });
  });

  describe('text matching (ENG-268 accent/case folding)', () => {
    it('matches via the shared foldedHaystack/foldedSearchTerm vocabulary that replaced the old bare ILIKE', async () => {
      await service.searchMessages('me', 'café');
      expect(qb.where).toHaveBeenCalledWith(
        `${foldedHaystack('m', ['body'])} LIKE ${foldedSearchTerm('pattern')} ESCAPE '\\'`,
        { pattern: `%${escapeLikeTerm('café')}%` },
      );
      // The `.where()` SQL is entirely the folded expression: `ILIKE` is gone.
      const [whereSql] = qb.where.mock.calls[0] as [string, unknown];
      expect(whereSql).toEqual(expect.stringMatching(/^translate\(lower\(/));
    });

    it('escapes LIKE metacharacters in the query before folding, so % and _ stay literal', async () => {
      await service.searchMessages('me', '50%_off');
      expect(qb.where).toHaveBeenCalledWith(
        `${foldedHaystack('m', ['body'])} LIKE ${foldedSearchTerm('pattern')} ESCAPE '\\'`,
        { pattern: `%${escapeLikeTerm('50%_off')}%` },
      );
    });

    it('is the one and only `.where()` call, so every remaining predicate chains as `.andWhere()`', async () => {
      await service.searchMessages('me', 'hi');
      expect(qb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('limit capping', () => {
    it('defaults to DEFAULT_SEARCH_LIMIT when no limit is given', async () => {
      await service.searchMessages('me', 'hi');
      expect(qb.take).toHaveBeenCalledWith(DEFAULT_SEARCH_LIMIT);
    });

    it('caps an over-large limit at MAX_SEARCH_LIMIT', async () => {
      await service.searchMessages('me', 'hi', 9999);
      expect(qb.take).toHaveBeenCalledWith(MAX_SEARCH_LIMIT);
    });

    it('honours a limit under the cap as-is', async () => {
      await service.searchMessages('me', 'hi', 5);
      expect(qb.take).toHaveBeenCalledWith(5);
    });
  });

  describe('participation scoping', () => {
    it('scopes to the caller with one EXISTS binding userId, including the cleared floor and left ceiling', async () => {
      await service.searchMessages('me', 'hi');
      const call = findAndWhereCall(qb, (sql) =>
        sql.includes('conversation_participants'),
      );
      expect(call).toBeDefined();
      const [sql, params] = call!;
      expect(sql).toContain('"p"."conversation_id" = m.conversation_id');
      expect(sql).toContain('"p"."user_id" = :userId');
      expect(sql).toContain(
        'p.cleared_at IS NULL OR m.created_at > p.cleared_at',
      );
      expect(sql).toContain('p.left_at IS NULL OR m.created_at <= p.left_at');
      expect(params).toEqual({ userId: 'me' });
    });

    it('runs no join, so pagination stays a single query', async () => {
      await service.searchMessages('me', 'hi');
      expect(qb.innerJoin).not.toHaveBeenCalled();
      expect(messages.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('narrows to one conversation when conversationId is given', async () => {
      await service.searchMessages('me', 'hi', undefined, 'c1');
      expect(qb.andWhere).toHaveBeenCalledWith(
        'm.conversation_id = :conversationId',
        { conversationId: 'c1' },
      );
    });

    it('adds an always-true clause when conversationId is omitted, so the search stays cross-conversation', async () => {
      await service.searchMessages('me', 'hi');
      expect(qb.andWhere).toHaveBeenCalledWith('1=1', {});
    });
  });

  describe('visibility predicates', () => {
    it('excludes moderator-taken-down messages via the shared predicate', async () => {
      await service.searchMessages('me', 'hi');
      expect(qb.andWhere).toHaveBeenCalledWith(
        notModeratedMessagePredicate('m'),
        { messageSubjectType: MESSAGE_SUBJECT_TYPE },
      );
    });

    it('excludes messages the caller hid from their own view (PRD-227)', async () => {
      await service.searchMessages('me', 'hi');
      const call = findAndWhereCall(qb, (sql) => sql.includes('message_hides'));
      expect(call).toBeDefined();
      const [sql, params] = call!;
      expect(sql).toContain('"mh"."message_id" = m.id');
      expect(sql).toContain('"mh"."user_id" = :userId');
      expect(params).toEqual({ userId: 'me' });
    });

    it('applies the group-only sender block filter (PRD-354), scoped off for non-group rows via unless', async () => {
      await service.searchMessages('me', 'hi');
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        qb,
        'me',
        '"m"."sender_id"',
        {
          unless: expect.stringContaining('"sbfc"."kind" = \'group\''),
        },
      );
    });
  });

  describe('conversation grouping', () => {
    it('files a group hit under the group’s own identity, with otherParticipant null', async () => {
      qb.getMany.mockResolvedValueOnce([
        buildMessageRow({ id: 'm1', conversationId: 'c1', senderId: 'u2' }),
      ]);
      conversations.find.mockResolvedValueOnce([
        buildConversation({
          id: 'c1',
          kind: ConversationKind.Group,
          isOfficial: false,
          title: 'Book club',
          avatarUrl: 'https://cdn.example.com/group.png',
        }),
      ]);
      participants.find.mockResolvedValueOnce([
        { conversationId: 'c1', userId: 'u3' },
      ]);
      profiles.find.mockResolvedValueOnce([buildProfile('u2')]);

      const result = await service.searchMessages('me', 'hello');
      expect(result.conversations).toEqual([
        {
          conversationId: 'c1',
          otherParticipant: null,
          isOfficial: false,
          kind: 'group',
          title: 'Book club',
          avatarUrl: 'https://cdn.example.com/group.png',
        },
      ]);
    });

    it('files a DM hit under the counterpart, with kind direct and null title/avatar', async () => {
      qb.getMany.mockResolvedValueOnce([
        buildMessageRow({ id: 'm1', conversationId: 'c1', senderId: 'u2' }),
      ]);
      conversations.find.mockResolvedValueOnce([
        buildConversation({
          id: 'c1',
          kind: ConversationKind.Direct,
          isOfficial: false,
        }),
      ]);
      // Task 13c: every seat of the thread, the caller's own included, each
      // with the profile identity it speaks for.
      participants.find.mockResolvedValueOnce([
        { conversationId: 'c1', userId: 'me', identityId: 'identity-me' },
        { conversationId: 'c1', userId: 'u3', identityId: 'identity-u3' },
      ]);
      identities.getByIds.mockResolvedValueOnce([
        { id: 'identity-me', kind: IdentityKind.Profile },
        { id: 'identity-u3', kind: IdentityKind.Profile },
      ]);
      profiles.find.mockResolvedValueOnce([
        buildProfile('u2'),
        buildProfile('u3', {
          slug: 'other',
          firstName: 'Other',
          lastName: 'One',
        }),
      ]);

      const result = await service.searchMessages('me', 'hello');
      expect(result.conversations).toEqual([
        {
          conversationId: 'c1',
          otherParticipant: {
            handle: 'other',
            displayName: 'Other One',
            avatarUrl: null,
          },
          isOfficial: false,
          kind: 'direct',
          title: null,
          avatarUrl: null,
        },
      ]);
    });

    it('files an official-thread hit as direct, with otherParticipant, title and avatar all null', async () => {
      qb.getMany.mockResolvedValueOnce([
        buildMessageRow({ id: 'm1', conversationId: 'c1', senderId: 'u2' }),
      ]);
      conversations.find.mockResolvedValueOnce([
        buildConversation({
          id: 'c1',
          kind: ConversationKind.Direct,
          isOfficial: true,
        }),
      ]);
      participants.find.mockResolvedValueOnce([]);
      profiles.find.mockResolvedValueOnce([buildProfile('u2')]);

      const result = await service.searchMessages('me', 'hello');
      expect(result.conversations).toEqual([
        {
          conversationId: 'c1',
          otherParticipant: null,
          isOfficial: true,
          kind: 'direct',
          title: null,
          avatarUrl: null,
        },
      ]);
    });
  });

  describe('hit mapping', () => {
    it('carries kind and the resolved attachment on an image hit', async () => {
      qb.getMany.mockResolvedValueOnce([
        buildMessageRow({
          id: 'm1',
          conversationId: 'c1',
          senderId: 'u2',
          body: 'check this photo',
          kind: MessageKind.Image,
          attachment: {
            url: 'https://cdn.example.com/photo.jpg',
            previewUrl: 'https://cdn.example.com/photo-preview.jpg',
            width: 800,
            height: 600,
            provider: 'upload',
          },
        }),
      ]);
      conversations.find.mockResolvedValueOnce([
        buildConversation({ id: 'c1' }),
      ]);
      participants.find.mockResolvedValueOnce([
        { conversationId: 'c1', userId: 'u3' },
      ]);
      profiles.find.mockResolvedValueOnce([buildProfile('u2')]);

      const result = await service.searchMessages('me', 'photo');
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]).toMatchObject({
        id: 'm1',
        conversationId: 'c1',
        kind: 'image',
        attachment: {
          url: 'https://cdn.example.com/photo.jpg',
          previewUrl: 'https://cdn.example.com/photo-preview.jpg',
          width: 800,
          height: 600,
          provider: 'upload',
        },
      });
    });

    it('carries a null attachment on a plain-text hit', async () => {
      qb.getMany.mockResolvedValueOnce([
        buildMessageRow({
          id: 'm1',
          conversationId: 'c1',
          senderId: 'u2',
          body: 'just words',
        }),
      ]);
      conversations.find.mockResolvedValueOnce([
        buildConversation({ id: 'c1' }),
      ]);
      participants.find.mockResolvedValueOnce([
        { conversationId: 'c1', userId: 'u3' },
      ]);
      profiles.find.mockResolvedValueOnce([buildProfile('u2')]);

      const result = await service.searchMessages('me', 'words');
      expect(result.hits[0]?.kind).toBe('user');
      expect(result.hits[0]?.attachment).toBeNull();
    });
  });
});
