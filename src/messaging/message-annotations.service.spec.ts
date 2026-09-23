import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message, MessageKind } from './entities/message.entity';
import { LINK_BODY_PATTERN } from './conversation-media.service';
import { StarredMessagesFilterType } from './dto/starred-messages.query';
import {
  MessageAnnotationsService,
  PIN_LIMIT_REACHED_CODE,
} from './message-annotations.service';
import { encodeMessageHistoryCursor } from './message-history-cursor';
import { MessagingCoreService } from './messaging-core.service';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_PINNED_MESSAGES,
  MAX_SEARCH_LIMIT,
} from './messaging.constants';

/**
 * Chainable stand-in for the one reactors QueryBuilder `listMessageReactors`
 * runs. Every builder method returns the same object; `getMany` is the
 * terminal awaited call each test configures.
 */
interface ReactorsQueryMock {
  innerJoinAndMapOne: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  setParameter: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getMany: jest.Mock;
}

function makeReactorsQuery(): ReactorsQueryMock {
  const query = {} as ReactorsQueryMock;
  const self = (): ReactorsQueryMock => query;
  query.innerJoinAndMapOne = jest.fn(self);
  query.where = jest.fn(self);
  query.orderBy = jest.fn(self);
  query.setParameter = jest.fn(self);
  query.addOrderBy = jest.fn(self);
  query.limit = jest.fn(self);
  query.getMany = jest.fn().mockResolvedValue([]);
  return query;
}

describe('MessageAnnotationsService.listMessageReactors (PRD-352)', () => {
  const CONVERSATION_ID = 'c1';
  const MESSAGE_ID = 'm1';
  const VIEWER_ID = 'viewer';
  const MESSAGE_CREATED_AT = new Date('2026-09-01T10:00:00.000Z');

  let service: MessageAnnotationsService;
  let messages: { findOne: jest.Mock };
  let hides: { exist: jest.Mock };
  let reactions: { createQueryBuilder: jest.Mock };
  let core: {
    requireParticipant: jest.Mock;
    isMessageWithheldFromViewer: jest.Mock;
    loadReactorView: jest.Mock;
  };
  let reactorsQuery: ReactorsQueryMock;

  // `photoVisible: false` keeps `toVisibleAvatarUrl` off the image-url base,
  // which this spec never configures.
  function makeProfile(
    userId: string,
    firstName: string,
    lastName: string,
  ): Profile {
    return {
      userId,
      slug: firstName.toLowerCase(),
      firstName,
      lastName,
      pronouns: null,
      avatarUrl: null,
      photoVisible: false,
    } as unknown as Profile;
  }

  function makeReactionRow(
    userId: string,
    key: MessageReactionKey,
    profile: Profile,
  ) {
    return {
      id: `${userId}-${key}`,
      messageId: MESSAGE_ID,
      userId,
      key,
      profile,
    };
  }

  beforeEach(() => {
    reactorsQuery = makeReactorsQuery();
    messages = {
      findOne: jest.fn().mockResolvedValue({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        createdAt: MESSAGE_CREATED_AT,
        deletedAt: null,
      }),
    };
    hides = { exist: jest.fn().mockResolvedValue(false) };
    reactions = { createQueryBuilder: jest.fn(() => reactorsQuery) };
    core = {
      requireParticipant: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        clearedAt: null,
        leftAt: null,
      }),
      isMessageWithheldFromViewer: jest.fn().mockResolvedValue(false),
      // Task 13e: an ordinary thread, where every reactor is named.
      loadReactorView: jest.fn().mockResolvedValue({ shape: 'individuals' }),
    };
    service = new MessageAnnotationsService(
      {} as Repository<Conversation>,
      {} as Repository<ConversationParticipant>,
      messages as unknown as Repository<Message>,
      reactions as unknown as Repository<MessageReaction>,
      {} as Repository<ConversationPinnedMessage>,
      {} as Repository<MessageStar>,
      hides as unknown as Repository<MessageHide>,
      {} as Repository<Profile>,
      core as unknown as MessagingCoreService,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );
  });

  it('gives a participant every reactor, hand-mapped, from one joined query', async () => {
    const viewerProfile = makeProfile(VIEWER_ID, 'Rui', 'Costa');
    const otherProfile = makeProfile('other', 'Ana', 'Lima');
    reactorsQuery.getMany.mockResolvedValue([
      makeReactionRow(VIEWER_ID, MessageReactionKey.Love, viewerProfile),
      makeReactionRow('other', MessageReactionKey.Laugh, otherProfile),
    ]);

    const result = await service.listMessageReactors(
      CONVERSATION_ID,
      MESSAGE_ID,
      VIEWER_ID,
    );

    expect(core.requireParticipant).toHaveBeenCalledWith(
      CONVERSATION_ID,
      VIEWER_ID,
    );
    expect(reactions.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(reactorsQuery.innerJoinAndMapOne).toHaveBeenCalledWith(
      'reaction.profile',
      Profile,
      'profile',
      'profile.user_id = reaction.user_id',
    );
    expect(reactorsQuery.where).toHaveBeenCalledWith(
      'reaction.message_id = :messageId',
      { messageId: MESSAGE_ID },
    );
    expect(reactorsQuery.limit).toHaveBeenCalledWith(200);
    expect(result).toEqual({
      reactors: [
        {
          key: MessageReactionKey.Love,
          member: {
            handle: 'rui',
            displayName: 'Rui Costa',
            pronouns: null,
            avatarUrl: null,
          },
          isMine: true,
          reactedAt: null,
        },
        {
          key: MessageReactionKey.Laugh,
          member: {
            handle: 'ana',
            displayName: 'Ana Lima',
            pronouns: null,
            avatarUrl: null,
          },
          isMine: false,
          reactedAt: null,
        },
      ],
    });
  });

  it('refuses a non-participant before touching the message or its reactions', async () => {
    core.requireParticipant.mockRejectedValue(
      new ForbiddenException('You are not a participant'),
    );

    await expect(
      service.listMessageReactors(CONVERSATION_ID, MESSAGE_ID, 'stranger'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(messages.findOne).not.toHaveBeenCalled();
    expect(reactions.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('refuses a deleted message with a 404', async () => {
    // The default `findOne` (no `withDeleted`) skips a soft-deleted row.
    messages.findOne.mockResolvedValue(null);

    await expect(
      service.listMessageReactors(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(messages.findOne).toHaveBeenCalledWith({
      where: { id: MESSAGE_ID, conversationId: CONVERSATION_ID },
    });
    expect(reactions.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('refuses a message the caller hid for themselves', async () => {
    hides.exist.mockResolvedValue(true);

    await expect(
      service.listMessageReactors(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(hides.exist).toHaveBeenCalledWith({
      where: { userId: VIEWER_ID, messageId: MESSAGE_ID },
    });
    expect(reactions.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("refuses a message at or before the caller's clear point", async () => {
    core.requireParticipant.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      userId: VIEWER_ID,
      clearedAt: MESSAGE_CREATED_AT,
      leftAt: null,
    });

    await expect(
      service.listMessageReactors(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reactions.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('refuses a moderator-taken-down message', async () => {
    core.isMessageWithheldFromViewer.mockResolvedValue(true);

    await expect(
      service.listMessageReactors(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(core.isMessageWithheldFromViewer).toHaveBeenCalledWith(
      MESSAGE_ID,
      VIEWER_ID,
    );
    expect(reactions.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("orders the caller's own reactions first, then key order, then name, and keeps that order", async () => {
    const viewerProfile = makeProfile(VIEWER_ID, 'Rui', 'Costa');
    const firstProfile = makeProfile('first', 'Ana', 'Lima');
    const secondProfile = makeProfile('second', 'Bea', 'Sousa');
    reactorsQuery.getMany.mockResolvedValue([
      makeReactionRow(VIEWER_ID, MessageReactionKey.Sad, viewerProfile),
      makeReactionRow('first', MessageReactionKey.Love, firstProfile),
      makeReactionRow('second', MessageReactionKey.Love, secondProfile),
    ]);

    const result = await service.listMessageReactors(
      CONVERSATION_ID,
      MESSAGE_ID,
      VIEWER_ID,
    );

    expect(reactorsQuery.orderBy).toHaveBeenCalledWith(
      'CASE WHEN reaction.user_id = :viewerId THEN 0 ELSE 1 END',
      'ASC',
    );
    expect(reactorsQuery.setParameter).toHaveBeenCalledWith(
      'viewerId',
      VIEWER_ID,
    );
    expect(reactorsQuery.addOrderBy.mock.calls).toEqual([
      ['reaction.key', 'ASC'],
      ['profile.firstName', 'ASC'],
      ['profile.lastName', 'ASC'],
      ['reaction.userId', 'ASC'],
    ]);
    expect(
      result.reactors.map((reactor) => [reactor.member.handle, reactor.key]),
    ).toEqual([
      ['rui', MessageReactionKey.Sad],
      ['ana', MessageReactionKey.Love],
      ['bea', MessageReactionKey.Love],
    ]);
  });
});

/**
 * The takedown rule itself, run through a real `MessagingCoreService` (only its
 * repositories and `UsersService` are stand-ins), so the reactors route is
 * checked against the thread read path's split: a removal withholds the
 * message from everyone, a hide only from non-staff.
 */
describe('MessageAnnotationsService.listMessageReactors takedown visibility', () => {
  const CONVERSATION_ID = 'c1';
  const MESSAGE_ID = 'm1';
  const VIEWER_ID = 'viewer';
  const TAKEDOWN_AT = new Date('2026-09-02T10:00:00.000Z');

  let service: MessageAnnotationsService;
  let moderationStates: { findOne: jest.Mock };
  let usersService: { findById: jest.Mock };
  let reactions: { createQueryBuilder: jest.Mock };

  beforeEach(() => {
    moderationStates = { findOne: jest.fn().mockResolvedValue(null) };
    usersService = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: VIEWER_ID, role: UserRole.Member }),
    };
    reactions = { createQueryBuilder: jest.fn(() => makeReactorsQuery()) };
    const empty = {} as Record<string, never>;
    const core = new MessagingCoreService(
      empty as unknown as Repository<Conversation>,
      empty as unknown as Repository<ConversationParticipant>,
      empty as unknown as Repository<Message>,
      empty as unknown as Repository<MessageReaction>,
      empty as unknown as Repository<ConversationPinnedMessage>,
      empty as unknown as Repository<MessageStar>,
      empty as unknown as Repository<MessageHide>,
      moderationStates as unknown as Repository<ContentModeration>,
      empty as unknown as Repository<Profile>,
      empty as unknown as Repository<Sticker>,
      empty as unknown as DataSource,
      empty as unknown as EventEmitter2,
      usersService as unknown as UsersService,
      empty as unknown as IdentitiesService,
      // Task 11: unused by the reactors route under test here; a safe stand-in
      // so nothing crashes if a future path under test does reach it.
      {
        buildStaffNameResolver: jest
          .fn()
          .mockResolvedValue({ resolve: () => null }),
      } as unknown as IdentityAttributionService,
    );
    jest.spyOn(core, 'requireParticipant').mockResolvedValue({
      conversationId: CONVERSATION_ID,
      userId: VIEWER_ID,
      clearedAt: null,
      leftAt: null,
    } as unknown as ConversationParticipant);
    // Task 13e: an ordinary thread, where every reactor is named.
    jest
      .spyOn(core, 'loadReactorView')
      .mockResolvedValue({ shape: 'individuals' });
    service = new MessageAnnotationsService(
      {} as Repository<Conversation>,
      {} as Repository<ConversationParticipant>,
      {
        findOne: jest.fn().mockResolvedValue({
          id: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          createdAt: new Date('2026-09-01T10:00:00.000Z'),
          deletedAt: null,
        }),
      } as unknown as Repository<Message>,
      reactions as unknown as Repository<MessageReaction>,
      {} as Repository<ConversationPinnedMessage>,
      {} as Repository<MessageStar>,
      {
        exist: jest.fn().mockResolvedValue(false),
      } as unknown as Repository<MessageHide>,
      {} as Repository<Profile>,
      core,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );
  });

  it('opens a moderator-hidden message for staff, as the thread shows it to them', async () => {
    moderationStates.findOne.mockResolvedValue({
      hiddenAt: TAKEDOWN_AT,
      removedAt: null,
    });
    usersService.findById.mockResolvedValue({
      id: VIEWER_ID,
      role: UserRole.Moderator,
    });

    await expect(
      service.listMessageReactors(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).resolves.toEqual({ reactors: [] });
    expect(moderationStates.findOne).toHaveBeenCalledWith({
      where: { subjectType: 'message', subjectId: MESSAGE_ID },
    });
    expect(usersService.findById).toHaveBeenCalledWith(VIEWER_ID);
    expect(reactions.createQueryBuilder).toHaveBeenCalled();
  });

  it('still refuses a moderator-hidden message to a non-staff participant', async () => {
    moderationStates.findOne.mockResolvedValue({
      hiddenAt: TAKEDOWN_AT,
      removedAt: null,
    });

    await expect(
      service.listMessageReactors(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reactions.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('refuses a moderator-removed message even to staff', async () => {
    moderationStates.findOne.mockResolvedValue({
      hiddenAt: null,
      removedAt: TAKEDOWN_AT,
    });
    usersService.findById.mockResolvedValue({
      id: VIEWER_ID,
      role: UserRole.Admin,
    });

    await expect(
      service.listMessageReactors(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reactions.createQueryBuilder).not.toHaveBeenCalled();
  });
});

/**
 * ENG-240: group role gate, the pin cap, and the no-op-insert/delete guard on
 * `MESSAGE_PINNED`. `core.requireActiveParticipant` is stubbed to return the
 * viewer's own participant row (with `role`), mirroring how the real
 * `MessagingCoreService` method resolves it.
 */
describe('MessageAnnotationsService pins (ENG-240)', () => {
  const CONVERSATION_ID = 'c1';
  const MESSAGE_ID = 'm1';
  const VIEWER_ID = 'viewer';

  let service: MessageAnnotationsService;
  let conversations: { findOne: jest.Mock };
  let messages: { findOne: jest.Mock };
  let pins: {
    exist: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };
  let core: {
    requireActiveParticipant: jest.Mock;
    requireParticipant: jest.Mock;
    toMessageResponses: jest.Mock;
    assertMaySendAs: jest.Mock;
  };

  /**
   * Chainable stand-in for the `pins.createQueryBuilder().insert()...` chain.
   * `raw` drives the real code's no-op check (`inserted.raw.length > 0`):
   * an empty array mirrors what Postgres' `RETURNING` reports when
   * `ON CONFLICT DO NOTHING` suppressed the row. `identifiers` is populated
   * alongside for realism only: TypeORM always fills it from the values
   * passed in, insert or no-op alike, which is exactly why the real code no
   * longer reads it.
   */
  function makeInsertQuery(raw: Array<{ id: string }>) {
    const query = {} as Record<string, jest.Mock>;
    const self = () => query;
    query.insert = jest.fn(self);
    query.into = jest.fn(self);
    query.values = jest.fn(self);
    query.orIgnore = jest.fn(self);
    query.execute = jest.fn().mockResolvedValue({ identifiers: raw, raw });
    return query;
  }

  function buildService(role: ConversationRole, kind: ConversationKind) {
    conversations = {
      findOne: jest.fn().mockResolvedValue({ id: CONVERSATION_ID, kind }),
    };
    messages = {
      findOne: jest.fn().mockResolvedValue({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        deletedAt: null,
      }),
    };
    pins = {
      exist: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => makeInsertQuery([{ id: 'pin-1' }])),
    };
    eventEmitter = { emit: jest.fn() };
    core = {
      requireActiveParticipant: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        role,
        identityId: 'identity-viewer',
        leftAt: null,
        clearedAt: null,
      }),
      requireParticipant: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        identityId: 'identity-viewer',
        leftAt: null,
        clearedAt: null,
      }),
      toMessageResponses: jest.fn().mockResolvedValue([]),
      // Task 7: this suite exercises the pin-role gate, so the identity
      // guard is stubbed to always allow and stays out of its way.
      assertMaySendAs: jest.fn().mockResolvedValue(undefined),
    };
    service = new MessageAnnotationsService(
      conversations as unknown as Repository<Conversation>,
      {} as Repository<ConversationParticipant>,
      messages as unknown as Repository<Message>,
      {} as unknown as Repository<MessageReaction>,
      pins as unknown as Repository<ConversationPinnedMessage>,
      {} as Repository<MessageStar>,
      {
        find: jest.fn().mockResolvedValue([]),
      } as unknown as Repository<MessageHide>,
      {} as Repository<Profile>,
      core as unknown as MessagingCoreService,
      eventEmitter as unknown as EventEmitter2,
    );
  }

  it('refuses a GROUP member (neither owner nor admin) from pinning', async () => {
    buildService(ConversationRole.Member, ConversationKind.Group);

    await expect(
      service.pinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pins.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('refuses a GROUP member (neither owner nor admin) from unpinning', async () => {
    buildService(ConversationRole.Member, ConversationKind.Group);

    await expect(
      service.unpinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pins.delete).not.toHaveBeenCalled();
  });

  it('allows a GROUP admin to pin and emits MESSAGE_PINNED on a real insert', async () => {
    buildService(ConversationRole.Admin, ConversationKind.Group);

    await service.pinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID);

    expect(pins.createQueryBuilder).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'message.pinned',
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        pinned: true,
      }),
    );
  });

  it('a DM member (not owner/admin, not a group) may still pin', async () => {
    buildService(ConversationRole.Member, ConversationKind.Direct);

    await service.pinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID);

    expect(pins.createQueryBuilder).toHaveBeenCalled();
  });

  it('refuses a NEW pin with a coded ConflictException once the conversation already holds MAX_PINNED_MESSAGES', async () => {
    buildService(ConversationRole.Owner, ConversationKind.Group);
    pins.count.mockResolvedValue(MAX_PINNED_MESSAGES);

    await expect(
      service.pinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: PIN_LIMIT_REACHED_CODE }),
    });
    await expect(
      service.pinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(pins.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('exempts an idempotent re-pin of an already-pinned message from the cap check by skipping the insert entirely', async () => {
    buildService(ConversationRole.Owner, ConversationKind.Group);
    pins.exist.mockResolvedValue(true);
    pins.count.mockResolvedValue(MAX_PINNED_MESSAGES);

    await service.pinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID);

    expect(pins.count).not.toHaveBeenCalled();
    expect(pins.createQueryBuilder).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('does not emit MESSAGE_PINNED when the insert is a no-op (orIgnore conflict)', async () => {
    buildService(ConversationRole.Owner, ConversationKind.Group);
    pins.createQueryBuilder.mockReturnValue(makeInsertQuery([]));

    await service.pinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('does not emit MESSAGE_PINNED when unpin deletes nothing (affected 0)', async () => {
    buildService(ConversationRole.Owner, ConversationKind.Group);
    pins.delete.mockResolvedValue({ affected: 0 });

    await service.unpinMessage(CONVERSATION_ID, MESSAGE_ID, VIEWER_ID);

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it("bounds listPinnedMessages' initial pins query to take: MAX_PINNED_MESSAGES", async () => {
    buildService(ConversationRole.Member, ConversationKind.Direct);
    const pinsFind = jest.fn().mockResolvedValue([]);
    (pins as unknown as { find: jest.Mock }).find = pinsFind;

    await service.listPinnedMessages(CONVERSATION_ID, VIEWER_ID);

    expect(pinsFind).toHaveBeenCalledWith(
      expect.objectContaining({ take: MAX_PINNED_MESSAGES }),
    );
  });
});

/**
 * PRD-374: spec coverage for the `q`/`type`/`cursor` additions to
 * `listStarredMessages`. Scoped narrowly to the query-building itself: the
 * pre-existing guards (clearedAt, leftAt, moderation, message_hides) are
 * unchanged and already exercised by the method's own doc comment lineage;
 * this block only asserts the NEW predicates and the paging envelope.
 */
describe('MessageAnnotationsService.listStarredMessages (PRD-374)', () => {
  const VIEWER_ID = 'viewer';

  interface StarredQueryBuilder {
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

  function makeStarredQuery(): StarredQueryBuilder {
    const starredQuery = {} as StarredQueryBuilder;
    const self = (): StarredQueryBuilder => starredQuery;
    starredQuery.innerJoin = jest.fn(self);
    starredQuery.leftJoin = jest.fn(self);
    starredQuery.where = jest.fn(self);
    starredQuery.andWhere = jest.fn(self);
    starredQuery.addSelect = jest.fn(self);
    starredQuery.orderBy = jest.fn(self);
    starredQuery.addOrderBy = jest.fn(self);
    starredQuery.limit = jest.fn(self);
    starredQuery.getRawAndEntities = jest
      .fn()
      .mockResolvedValue({ entities: [], raw: [] });
    return starredQuery;
  }

  /** Finds the one `andWhere` call whose SQL fragment satisfies `matcher`, so
   *  the assertion stays keyed to what the clause says regardless of which
   *  call index it happens to land at. */
  function findAndWhereCall(
    starredQuery: StarredQueryBuilder,
    matcher: (sql: string) => boolean,
  ): [string, Record<string, unknown>] | undefined {
    const calls = starredQuery.andWhere.mock.calls as [
      string,
      Record<string, unknown>,
    ][];
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

  let service: MessageAnnotationsService;
  let starredQuery: StarredQueryBuilder;
  let messages: { createQueryBuilder: jest.Mock };
  let stars: { find: jest.Mock };
  let conversations: { find: jest.Mock };
  let participants: { find: jest.Mock };
  let profiles: { find: jest.Mock };

  beforeEach(() => {
    starredQuery = makeStarredQuery();
    messages = { createQueryBuilder: jest.fn(() => starredQuery) };
    stars = { find: jest.fn().mockResolvedValue([]) };
    conversations = { find: jest.fn().mockResolvedValue([]) };
    participants = { find: jest.fn().mockResolvedValue([]) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    service = new MessageAnnotationsService(
      conversations as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      messages as unknown as Repository<Message>,
      {} as Repository<MessageReaction>,
      {} as Repository<ConversationPinnedMessage>,
      stars as unknown as Repository<MessageStar>,
      {
        find: jest.fn().mockResolvedValue([]),
      } as unknown as Repository<MessageHide>,
      profiles as unknown as Repository<Profile>,
      // Task 13c: the starred list renders its senders and counterparts
      // through the real `MessagingCoreService.loadMessageListContext`,
      // reading the same participant and profile stand-ins as this service.
      Object.assign(Object.create(MessagingCoreService.prototype), {
        participants,
        profiles,
        identities: {
          getByIds: jest.fn().mockResolvedValue([]),
          describeIdentities: jest.fn().mockResolvedValue(new Map()),
        },
        identityAttribution: {
          buildStaffNameResolver: jest
            .fn()
            .mockResolvedValue({ resolve: () => null }),
        },
      }) as MessagingCoreService,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );
  });

  describe('limit', () => {
    it('fetches DEFAULT_SEARCH_LIMIT + 1 rows when no limit is given', async () => {
      await service.listStarredMessages(VIEWER_ID);
      expect(starredQuery.limit).toHaveBeenCalledWith(DEFAULT_SEARCH_LIMIT + 1);
    });

    it('caps an over-large limit at MAX_SEARCH_LIMIT + 1', async () => {
      await service.listStarredMessages(VIEWER_ID, { limit: 9999 });
      expect(starredQuery.limit).toHaveBeenCalledWith(MAX_SEARCH_LIMIT + 1);
    });
  });

  describe('q', () => {
    it('adds no predicate for an omitted query', async () => {
      await service.listStarredMessages(VIEWER_ID);
      expect(
        findAndWhereCall(starredQuery, (sql) => sql.includes('qPattern')),
      ).toBeUndefined();
    });

    it('adds no predicate for a whitespace-only query', async () => {
      await service.listStarredMessages(VIEWER_ID, { q: '   ' });
      expect(
        findAndWhereCall(starredQuery, (sql) => sql.includes('qPattern')),
      ).toBeUndefined();
    });

    it('trims and LIKE-escapes the term into one bound, accent-folded OR clause matching body, attachment, sender, group title and DM counterpart', async () => {
      await service.listStarredMessages(VIEWER_ID, { q: '  50%off  ' });
      const call = findAndWhereCall(starredQuery, (sql) =>
        sql.includes('qPattern'),
      );
      expect(call).toBeDefined();
      const [sql, params] = call!;
      // Folding happens in SQL (`translate(lower(...))`), so the bound
      // parameter itself stays the plain LIKE-escaped pattern: escaping
      // survives the fold untouched since `\`, `%`, and `_` sit outside the
      // accented-letter/case pairs `translate`/`lower` ever touch.
      expect(params).toEqual({ qPattern: '%50\\%off%' });
      // Every branch runs through `foldedHaystack`/`foldedTextExpression`
      // (`translate(lower(...))`), so each of these stable substrings names
      // the column being matched without pinning the exact fold expression
      // search-text.ts builds it into.
      expect(sql).toContain('"m"."body"');
      expect(sql).toContain(`coalesce(m.attachment ->> 'caption', '')`);
      expect(sql).toContain(`coalesce(m.attachment ->> 'fileName', '')`);
      expect(sql).toContain('"sender_profile"."user_id" = m.sender_id');
      expect(sql).toContain('"sender_profile"."first_name"');
      expect(sql).toContain('"sender_profile"."last_name"');
      expect(sql).toContain("c.kind = 'group'");
      expect(sql).toContain('"c"."title"');
      expect(sql).toContain("c.kind <> 'group'");
      expect(sql).toContain('"op"."user_id" <> :userId');
      expect(sql).toContain('"other_profile"."user_id" = "op"."user_id"');
      expect(sql).toContain('"other_profile"."first_name"');
      expect(sql).toContain('"other_profile"."last_name"');
    });

    it('quotes every mixed-case alias reference across every andWhere/innerJoin/leftJoin clause the method builds, so Postgres resolves each one to the identical name declared in its FROM clause', async () => {
      // One call exercising every SQL-building branch at once (q, a type
      // filter, and a cursor), so the guard below covers the cursor/type
      // predicates and the base joins too, alongside the `q` clause: a
      // mixed-case alias introduced anywhere else in the method is an
      // identical bug, whichever branch it lands in.
      await service.listStarredMessages(VIEWER_ID, {
        q: 'joao',
        type: StarredMessagesFilterType.Links,
        cursor: encodeMessageHistoryCursor(
          '2026-06-01T00:00:00.000000Z',
          '11111111-1111-1111-1111-111111111111',
        ),
      });
      const sqlFragments: string[] = [
        ...(starredQuery.andWhere.mock.calls as [string, unknown][]).map(
          ([sql]) => sql,
        ),
        ...(
          starredQuery.innerJoin.mock.calls as [unknown, unknown, string][]
        ).map(([, , sql]) => sql),
        ...(
          starredQuery.leftJoin.mock.calls as [unknown, unknown, string][]
        ).map(([, , sql]) => sql),
      ];
      expect(sqlFragments.length).toBeGreaterThan(0);
      // The historical shape of this bug: a `FROM "profiles" "senderProfile"`
      // paired with a later bare `senderProfile.first_name` reference, which
      // Postgres lower-cases to `senderprofile` and can no longer resolve.
      // Both names are absent here since every alias below is lowercase
      // snake_case, but the general pattern is the real guard: any mixed-case
      // identifier reference not immediately preceded by a closing quote has
      // the identical failure shape, whatever alias introduces it next.
      // `(^|[^"])` (not a bare `[^"]`) so a fragment that STARTS with a bare
      // alias, with nothing at all before it, is caught too.
      for (const sql of sqlFragments) {
        expect(sql).not.toMatch(/(^|[^"])senderProfile\./);
        expect(sql).not.toMatch(/(^|[^"])opProfile\./);
        expect(sql).not.toMatch(
          /(^|[^"])\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\./,
        );
      }
    });
  });

  describe('type', () => {
    it('adds no kind predicate when type is omitted', async () => {
      await service.listStarredMessages(VIEWER_ID);
      expect(
        findAndWhereCall(starredQuery, (sql) => sql.includes('m.kind')),
      ).toBeUndefined();
    });

    it('photos matches image or gif kinds', async () => {
      await service.listStarredMessages(VIEWER_ID, {
        type: StarredMessagesFilterType.Photos,
      });
      expect(starredQuery.andWhere).toHaveBeenCalledWith(
        'm.kind IN (:...photoKinds)',
        { photoKinds: [MessageKind.Image, MessageKind.Gif] },
      );
    });

    it('documents matches the document kind', async () => {
      await service.listStarredMessages(VIEWER_ID, {
        type: StarredMessagesFilterType.Documents,
      });
      expect(starredQuery.andWhere).toHaveBeenCalledWith(
        'm.kind = :documentKind',
        { documentKind: MessageKind.Document },
      );
    });

    it('links matches ordinary text bubbles whose body carries an http(s):// or www. address, mirroring the conversation-media Links tab', async () => {
      await service.listStarredMessages(VIEWER_ID, {
        type: StarredMessagesFilterType.Links,
      });
      expect(starredQuery.andWhere).toHaveBeenCalledWith('m.kind = :textKind', {
        textKind: MessageKind.User,
      });
      expect(starredQuery.andWhere).toHaveBeenCalledWith(
        'm.body ~* :linkPattern',
        { linkPattern: LINK_BODY_PATTERN },
      );
    });
  });

  describe('cursor', () => {
    it('adds a keyset predicate on (s.created_at, m.id) for a valid cursor', async () => {
      const cursor = encodeMessageHistoryCursor(
        '2026-06-01T00:00:00.000000Z',
        '11111111-1111-1111-1111-111111111111',
      );
      await service.listStarredMessages(VIEWER_ID, { cursor });
      const call = findAndWhereCall(starredQuery, (sql) =>
        sql.includes('s.created_at, m.id'),
      );
      expect(call).toBeDefined();
      const [, params] = call!;
      expect(params).toEqual({
        cursorStarredAt: '2026-06-01T00:00:00.000000Z',
        cursorMessageId: '11111111-1111-1111-1111-111111111111',
      });
    });

    it('falls back to the first page for a cursor that fails to decode', async () => {
      await service.listStarredMessages(VIEWER_ID, { cursor: 'not-a-cursor' });
      expect(
        findAndWhereCall(starredQuery, (sql) =>
          sql.includes('s.created_at, m.id'),
        ),
      ).toBeUndefined();
    });
  });

  describe('paging envelope', () => {
    it('reports hasMore and a nextCursor built from the boundary row when an extra row comes back', async () => {
      const rows = [
        buildMessageRow({
          id: 'm3',
          createdAt: new Date('2026-06-03T00:00:00Z'),
        }),
        buildMessageRow({
          id: 'm2',
          createdAt: new Date('2026-06-02T00:00:00Z'),
        }),
      ];
      starredQuery.getRawAndEntities.mockResolvedValue({
        entities: rows,
        raw: [
          { m_id: 'm3', cursor_starred_at: '2026-06-03T00:00:00.000000Z' },
          { m_id: 'm2', cursor_starred_at: '2026-06-02T00:00:00.000000Z' },
        ],
      });

      const result = await service.listStarredMessages(VIEWER_ID, { limit: 1 });

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe('m3');
      expect(result.nextCursor).toBe(
        encodeMessageHistoryCursor('2026-06-03T00:00:00.000000Z', 'm3'),
      );
    });

    it('reports no more pages and a null nextCursor when the page is not full', async () => {
      const rows = [buildMessageRow({ id: 'm1' })];
      starredQuery.getRawAndEntities.mockResolvedValue({
        entities: rows,
        raw: [{ m_id: 'm1', cursor_starred_at: '2026-06-01T00:00:00.000000Z' }],
      });

      const result = await service.listStarredMessages(VIEWER_ID, {
        limit: 20,
      });

      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('returns an empty page without querying stars/conversations/profiles when nothing comes back', async () => {
      const result = await service.listStarredMessages(VIEWER_ID);

      expect(result).toEqual({
        items: [],
        conversations: [],
        nextCursor: null,
        hasMore: false,
      });
      expect(stars.find).not.toHaveBeenCalled();
      expect(conversations.find).not.toHaveBeenCalled();
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });
});
