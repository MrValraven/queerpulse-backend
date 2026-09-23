import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { encodeCursor } from '../common/cursor-pagination';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { ConnectionsService } from '../connections/connections.service';
import { IdentitiesService } from '../identities/identities.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { PreferencesService } from '../preferences/preferences.service';
import { BlockFilterService } from '../social/block-filter.service';
import { StorageService } from '../storage/storage.service';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { ConversationsService } from './conversations.service';
import { ListConversationsQuery } from './dto/list-conversations.query';
import { SearchMessagesQuery } from './dto/search-messages.query';
import { StarredMessagesQuery } from './dto/starred-messages.query';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message } from './entities/message.entity';
import { GroupInvitesService } from './group-invites.service';
import { GroupsService } from './groups.service';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessageRequestsService } from './message-requests.service';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';
import { MessagingService } from './messaging.service';

/**
 * Task 24: `?as=<identityId>` scopes the inbox, search and starred lists to
 * one mailbox. The invariant every case below protects: a filtered list is
 * the unfiltered one plus exactly one more predicate on the caller's own
 * seat (`identity_id = :mailboxIdentityId`), so it is always a subset of the
 * merged view. Omitting `as` leaves every query exactly as it was.
 *
 * These are query-shape checks over mocked repositories. The row-level
 * behaviour (which threads come back, pagination across a mailbox, the
 * union invariant) was exercised against a throwaway Postgres; see the
 * task report.
 */

const USER_ID = 'user-1';
const MAILBOX_IDENTITY_ID = '6f1c2d3e-4b5a-4c6d-8e7f-001122334455';
const MAILBOX_PREDICATE = 'participant.identity_id = :mailboxIdentityId';
// Task 24 cleanup: the read routes keep the `IDENTITY_NOT_STAFF` code
// `assertMayActAs` uses, with a message written for a read.
const NOT_STAFF_BODY = {
  code: 'IDENTITY_NOT_STAFF',
  message: 'You cannot read this mailbox',
};

interface ChainableBuilder {
  [method: string]: jest.Mock;
}

// `noUncheckedIndexedAccess` adds `| undefined` to every read through
// `ChainableBuilder`'s index signature, so tests would need a defined-check
// on every chained mock call. Each builder mock instead carries an explicit,
// non-optional property per method it exposes (still backed by the same
// dynamically-built object at runtime), which TypeScript resolves ahead of
// the index signature.
interface ConversationParticipantsBuilderMock extends ChainableBuilder {
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  addSelect: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  getRawAndEntities: jest.Mock;
}

interface MessageSearchBuilderMock extends ChainableBuilder {
  where: jest.Mock;
  andWhere: jest.Mock;
  innerJoin: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  getMany: jest.Mock;
}

interface StarredMessageBuilderMock extends ChainableBuilder {
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  addSelect: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getRawAndEntities: jest.Mock;
}

function makeChainableBuilder(
  methodNames: ReadonlyArray<string>,
  terminal: Record<string, unknown>,
): ChainableBuilder {
  const builder: ChainableBuilder = {};
  for (const methodName of methodNames) {
    builder[methodName] = jest.fn(() => builder);
  }
  for (const [methodName, value] of Object.entries(terminal)) {
    builder[methodName] = jest.fn().mockResolvedValue(value);
  }
  return builder;
}

function sqlOfCalls(mock: jest.Mock): string[] {
  return (mock.mock.calls as unknown[][]).map((call) => String(call[0]));
}

async function refusalBodyOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return {
      status: (error as { getStatus: () => number }).getStatus(),
      body: (error as { getResponse: () => unknown }).getResponse(),
    };
  }
  throw new Error('expected a refusal');
}

describe('mailbox list filter (Task 24)', () => {
  describe('the query DTOs', () => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const cases: ReadonlyArray<[string, new () => object, object]> = [
      ['ListConversationsQuery', ListConversationsQuery, {}],
      ['SearchMessagesQuery', SearchMessagesQuery, { q: 'hello' }],
      ['StarredMessagesQuery', StarredMessagesQuery, {}],
    ];

    it.each(cases)(
      '%s accepts a uuid `as`',
      async (_name, metatype, baseQuery) => {
        const metadata: ArgumentMetadata = { type: 'query', metatype };
        const transformed = (await pipe.transform(
          { ...baseQuery, as: MAILBOX_IDENTITY_ID },
          metadata,
        )) as { as?: string };
        expect(transformed.as).toBe(MAILBOX_IDENTITY_ID);
      },
    );

    it.each(cases)(
      '%s refuses an `as` that is not a uuid with a 400',
      async (_name, metatype, baseQuery) => {
        const metadata: ArgumentMetadata = { type: 'query', metatype };
        const refusal = await refusalBodyOf(
          pipe.transform({ ...baseQuery, as: 'not-a-uuid' }, metadata),
        );
        expect(refusal).toMatchObject({ status: 400 });
      },
    );
  });

  describe('ConversationsService.listConversations', () => {
    let service: ConversationsService;
    let participantsBuilder: ConversationParticipantsBuilderMock;
    let identities: { isAllowedToActAs: jest.Mock };

    beforeEach(() => {
      participantsBuilder = makeChainableBuilder(
        [
          'where',
          'andWhere',
          'setParameter',
          'addSelect',
          'orderBy',
          'addOrderBy',
          'take',
        ],
        { getRawAndEntities: { entities: [], raw: [] } },
      ) as unknown as ConversationParticipantsBuilderMock;
      identities = { isAllowedToActAs: jest.fn().mockResolvedValue(true) };
      service = new ConversationsService(
        {} as Repository<Conversation>,
        {
          createQueryBuilder: jest.fn(() => participantsBuilder),
        } as unknown as Repository<ConversationParticipant>,
        {} as Repository<Profile>,
        {} as MessagingCoreService,
        {} as BlockFilterService,
        { emit: jest.fn() } as unknown as EventEmitter2,
        {} as DataSource,
        {} as MediaCropService,
        {} as ConnectionsService,
        {} as PreferencesService,
        identities as unknown as IdentitiesService,
        {} as never,
      );
    });

    it('omitted: no mailbox predicate and no authorization call (the merged inbox, unchanged)', async () => {
      await service.listConversations(USER_ID, {});

      expect(identities.isAllowedToActAs).not.toHaveBeenCalled();
      expect(sqlOfCalls(participantsBuilder.andWhere)).not.toContain(
        MAILBOX_PREDICATE,
      );
    });

    it("present: narrows the caller's own seat to that mailbox, binding the id", async () => {
      await service.listConversations(USER_ID, {
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
      });

      expect(identities.isAllowedToActAs).toHaveBeenCalledWith(
        USER_ID,
        MAILBOX_IDENTITY_ID,
      );
      expect(participantsBuilder.andWhere).toHaveBeenCalledWith(
        MAILBOX_PREDICATE,
        { mailboxIdentityId: MAILBOX_IDENTITY_ID },
      );
      // Every existing predicate still runs beside it: the filtered list is
      // the merged one plus this single predicate.
      const merged = makeChainableBuilder(
        [
          'where',
          'andWhere',
          'setParameter',
          'addSelect',
          'orderBy',
          'addOrderBy',
          'take',
        ],
        { getRawAndEntities: { entities: [], raw: [] } },
      ) as unknown as ConversationParticipantsBuilderMock;
      (
        service as unknown as {
          participants: { createQueryBuilder: jest.Mock };
        }
      ).participants.createQueryBuilder.mockReturnValueOnce(merged);
      await service.listConversations(USER_ID, {});
      expect(sqlOfCalls(participantsBuilder.andWhere)).toEqual([
        ...sqlOfCalls(merged.andWhere),
        MAILBOX_PREDICATE,
      ]);
    });

    it('present: the predicate lands before the keyset seek and the take, so pagination walks only this mailbox', async () => {
      const cursor = encodeCursor({
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        id: 'participant-9',
      });
      await service.listConversations(USER_ID, {
        cursor,
        limit: 5,
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
      });

      const andWhereSql = sqlOfCalls(participantsBuilder.andWhere);
      const mailboxIndex = andWhereSql.indexOf(MAILBOX_PREDICATE);
      const cursorIndex = andWhereSql.findIndex((sql) =>
        sql.includes(':cursorParticipantId'),
      );
      expect(mailboxIndex).toBeGreaterThanOrEqual(0);
      expect(cursorIndex).toBeGreaterThan(mailboxIndex);
      const mailboxCallOrder =
        participantsBuilder.andWhere.mock.invocationCallOrder[mailboxIndex]!;
      expect(
        participantsBuilder.take.mock.invocationCallOrder[0],
      ).toBeGreaterThan(mailboxCallOrder);
      expect(participantsBuilder.take).toHaveBeenCalledWith(6);
    });

    it('refuses a mailbox the caller does not staff, and an unknown identity, with the identical IDENTITY_NOT_STAFF "You cannot read this mailbox" body before any query', async () => {
      identities.isAllowedToActAs.mockResolvedValue(false);

      const notStaff = await refusalBodyOf(
        service.listConversations(USER_ID, {
          mailboxIdentityId: MAILBOX_IDENTITY_ID,
        }),
      );
      const unknownIdentity = await refusalBodyOf(
        service.listConversations(USER_ID, {
          mailboxIdentityId: '00000000-0000-4000-8000-000000000000',
        }),
      );

      expect(notStaff).toEqual({ status: 403, body: NOT_STAFF_BODY });
      expect(unknownIdentity).toEqual(notStaff);
      expect(participantsBuilder.where).not.toHaveBeenCalled();
    });
  });

  describe('ConversationsService.assertMayReadMailbox', () => {
    it("uses the read test, so a removed persona's staff are allowed", async () => {
      // `isAllowedToActAs` answers true for a removed persona's staff (its
      // staff set is unchanged); `assertMayActAs` would refuse them with
      // IDENTITY_REMOVED, so it must not be the gate for a read.
      const identities = {
        isAllowedToActAs: jest.fn().mockResolvedValue(true),
        assertMayActAs: jest.fn().mockRejectedValue(new Error('removed')),
      };
      const service = new ConversationsService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        identities as unknown as IdentitiesService,
        {} as never,
      );

      await expect(
        service.assertMayReadMailbox(USER_ID, MAILBOX_IDENTITY_ID),
      ).resolves.toBeUndefined();
      expect(identities.assertMayActAs).not.toHaveBeenCalled();
    });
  });

  describe('MessagesService.searchMessages', () => {
    let service: MessagesService;
    let searchBuilder: MessageSearchBuilderMock;

    beforeEach(() => {
      searchBuilder = makeChainableBuilder(
        ['where', 'andWhere', 'innerJoin', 'orderBy', 'addOrderBy', 'take'],
        { getMany: [] },
      ) as unknown as MessageSearchBuilderMock;
      service = new MessagesService(
        {} as Repository<Conversation>,
        {} as Repository<ConversationParticipant>,
        {
          createQueryBuilder: jest.fn(() => searchBuilder),
        } as unknown as Repository<Message>,
        {} as Repository<Profile>,
        {} as MessagingCoreService,
        { emit: jest.fn() } as unknown as EventEmitter2,
        {} as ConnectionsService,
        {
          excludeBlocked: jest.fn((builder: unknown) => builder),
        } as unknown as BlockFilterService,
        {} as UsersService,
        {} as MentionNotificationService,
        {} as StorageService,
      );
    });

    function participationCall(): [string, Record<string, unknown>] {
      const calls = searchBuilder.andWhere.mock.calls as [
        string,
        Record<string, unknown>,
      ][];
      const call = calls.find(([sql]) =>
        sql.includes('FROM "conversation_participants" "p"'),
      );
      if (!call) {
        throw new Error('no participation EXISTS');
      }
      return call;
    }

    it('omitted: the participation EXISTS carries no mailbox predicate', async () => {
      await service.searchMessages(USER_ID, 'hello');

      const [sql, parameters] = participationCall();
      expect(sql).not.toContain('identity_id');
      expect(parameters).toEqual({ userId: USER_ID });
    });

    it('present: narrows inside the participation EXISTS, leaving the builder join-free', async () => {
      await service.searchMessages(
        USER_ID,
        'hello',
        undefined,
        undefined,
        MAILBOX_IDENTITY_ID,
      );

      const [sql, parameters] = participationCall();
      expect(sql).toContain('AND "p"."identity_id" = :mailboxIdentityId');
      expect(sql).toContain('"p"."user_id" = :userId');
      expect(sql).toContain('p.cleared_at');
      expect(sql).toContain('p.left_at');
      expect(parameters).toEqual({
        userId: USER_ID,
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
      });
      expect(searchBuilder.innerJoin).not.toHaveBeenCalled();
    });

    it('present with `conversationId`: both narrowings apply together', async () => {
      await service.searchMessages(
        USER_ID,
        'hello',
        undefined,
        'personal-thread',
        MAILBOX_IDENTITY_ID,
      );

      expect(participationCall()[0]).toContain(':mailboxIdentityId');
      expect(searchBuilder.andWhere).toHaveBeenCalledWith(
        'm.conversation_id = :conversationId',
        { conversationId: 'personal-thread' },
      );
    });
  });

  describe('MessageAnnotationsService.listStarredMessages', () => {
    let service: MessageAnnotationsService;
    let starredBuilder: StarredMessageBuilderMock;

    beforeEach(() => {
      starredBuilder = makeChainableBuilder(
        [
          'innerJoin',
          'leftJoin',
          'where',
          'andWhere',
          'addSelect',
          'orderBy',
          'addOrderBy',
          'limit',
        ],
        { getRawAndEntities: { entities: [], raw: [] } },
      ) as unknown as StarredMessageBuilderMock;
      service = new MessageAnnotationsService(
        {} as Repository<Conversation>,
        {} as Repository<ConversationParticipant>,
        {
          createQueryBuilder: jest.fn(() => starredBuilder),
        } as unknown as Repository<Message>,
        {} as Repository<MessageReaction>,
        {} as Repository<ConversationPinnedMessage>,
        {} as Repository<MessageStar>,
        {} as Repository<MessageHide>,
        {} as Repository<Profile>,
        {} as MessagingCoreService,
        { emit: jest.fn() } as unknown as EventEmitter2,
      );
    });

    function participantJoin(): unknown[] {
      const call = (starredBuilder.innerJoin.mock.calls as unknown[][]).find(
        (args) => args[1] === 'p',
      );
      if (!call) {
        throw new Error('no participant join');
      }
      return call;
    }

    it('omitted: the participant join carries no mailbox predicate', async () => {
      await service.listStarredMessages(USER_ID, {});

      const [entity, , condition, parameters] = participantJoin();
      expect(entity).toBe(ConversationParticipant);
      expect(condition).toBe(
        'p.conversation_id = m.conversation_id AND p.user_id = :userId',
      );
      expect(parameters).toEqual({ userId: USER_ID });
    });

    it("present: narrows the participant join to the caller's own mailbox seat", async () => {
      await service.listStarredMessages(USER_ID, {
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
      });

      const [, , condition, parameters] = participantJoin();
      expect(condition).toBe(
        'p.conversation_id = m.conversation_id AND p.user_id = :userId AND p.identity_id = :mailboxIdentityId',
      );
      expect(parameters).toEqual({
        userId: USER_ID,
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
      });
    });
  });

  describe('MessagingService facade', () => {
    let facade: MessagingService;
    let conversationsService: { assertMayReadMailbox: jest.Mock };
    let messagesService: { searchMessages: jest.Mock };
    let annotationsService: { listStarredMessages: jest.Mock };

    beforeEach(() => {
      conversationsService = {
        assertMayReadMailbox: jest.fn().mockResolvedValue(undefined),
      };
      messagesService = {
        searchMessages: jest
          .fn()
          .mockResolvedValue({ query: 'hello', hits: [], conversations: [] }),
      };
      annotationsService = {
        listStarredMessages: jest.fn().mockResolvedValue({
          items: [],
          conversations: [],
          nextCursor: null,
          hasMore: false,
        }),
      };
      facade = new MessagingService(
        conversationsService as unknown as ConversationsService,
        messagesService as unknown as MessagesService,
        annotationsService as unknown as MessageAnnotationsService,
        {} as GroupsService,
        {} as GroupInvitesService,
        {} as MessageRequestsService,
      );
    });

    it('search: authorizes the mailbox, then passes it through', async () => {
      await facade.searchMessages(
        USER_ID,
        'hello',
        10,
        undefined,
        MAILBOX_IDENTITY_ID,
      );

      expect(conversationsService.assertMayReadMailbox).toHaveBeenCalledWith(
        USER_ID,
        MAILBOX_IDENTITY_ID,
      );
      expect(messagesService.searchMessages).toHaveBeenCalledWith(
        USER_ID,
        'hello',
        10,
        undefined,
        MAILBOX_IDENTITY_ID,
      );
    });

    it('starred: authorizes the mailbox, then passes it through', async () => {
      await facade.listStarredMessages(USER_ID, {
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
      });

      expect(conversationsService.assertMayReadMailbox).toHaveBeenCalledWith(
        USER_ID,
        MAILBOX_IDENTITY_ID,
      );
      expect(annotationsService.listStarredMessages).toHaveBeenCalledWith(
        USER_ID,
        { mailboxIdentityId: MAILBOX_IDENTITY_ID },
      );
    });

    it('a refusal stops the request before any query runs', async () => {
      conversationsService.assertMayReadMailbox.mockRejectedValue(
        new Error('IDENTITY_NOT_STAFF'),
      );

      await expect(
        facade.searchMessages(
          USER_ID,
          'hello',
          undefined,
          undefined,
          MAILBOX_IDENTITY_ID,
        ),
      ).rejects.toThrow('IDENTITY_NOT_STAFF');
      await expect(
        facade.listStarredMessages(USER_ID, {
          mailboxIdentityId: MAILBOX_IDENTITY_ID,
        }),
      ).rejects.toThrow('IDENTITY_NOT_STAFF');
      expect(messagesService.searchMessages).not.toHaveBeenCalled();
      expect(annotationsService.listStarredMessages).not.toHaveBeenCalled();
    });

    it('omitted: no authorization call on either route', async () => {
      await facade.searchMessages(USER_ID, 'hello');
      await facade.listStarredMessages(USER_ID, {});

      expect(conversationsService.assertMayReadMailbox).not.toHaveBeenCalled();
    });
  });
});
