import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, FindOperator, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import type { MessagingPrivacyDTO } from '../preferences/preferences-response';
import { BlockFilterService } from '../social/block-filter.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { StorageService } from '../storage/storage.service';
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
import { MessageAnnotationsService } from './message-annotations.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * SEC-26: a member blocked either way with the viewer in a group reads the
 * same over REST as over the live socket. The roster carries none of their
 * watermarks (`buildMemberSummaries`), and their reactions stay out of the
 * reaction counts (`reactionSummariesByMessage`) and the "who reacted" list
 * (`listMessageReactors`). A direct thread is left as it was.
 */

const VIEWER_ID = 'viewer-user';
const BLOCKED_ID = 'blocked-user';
const FRIEND_ID = 'friend-user';
const GROUP_ID = 'group-1';
const DIRECT_ID = 'direct-1';
const GROUP_MESSAGE_ID = 'group-message';
const DIRECT_MESSAGE_ID = 'direct-message';
const READ_AT = new Date('2026-11-20T10:00:00.000Z');
const READ_INSTANT = new Date('2026-11-20T10:00:05.000Z');
const DELIVERED_AT = new Date('2026-11-20T09:59:00.000Z');

interface ConversationRow {
  id: string;
  kind: ConversationKind;
  isOfficial: boolean;
}

interface MessageRow {
  id: string;
  conversationId: string;
}

interface ReactionRow {
  messageId: string;
  userId: string;
  key: MessageReactionKey;
}

interface CoreDoubles {
  conversations: ConversationRow[];
  participants: ConversationParticipant[];
  messages: MessageRow[];
  reactions: ReactionRow[];
  blockedUserIds: Set<string>;
  blockedUserIdsCalls: Array<[string, string[]]>;
}

function profile(userId: string, firstName: string): Profile {
  return {
    userId,
    firstName,
    lastName: 'Lopes',
    slug: `${firstName.toLowerCase()}-lopes`,
    pronouns: null,
    avatarUrl: null,
    photoVisible: true,
  } as unknown as Profile;
}

function seat(
  userId: string,
  deliveredAt: Date | null = DELIVERED_AT,
): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId: GROUP_ID,
    userId,
    identityId: `identity-${userId}`,
    role: ConversationRole.Member,
    leftAt: null,
    removedAt: null,
    clearedAt: null,
    historyFloorAt: null,
    absenceStartedAt: null,
    absenceEndedAt: null,
    lastReadAt: READ_AT,
    lastReadInstant: READ_INSTANT,
    deliveredAt,
  } as unknown as ConversationParticipant;
}

const PROFILE_BY_USER = new Map<string, Profile>([
  [VIEWER_ID, profile(VIEWER_ID, 'Vera')],
  [BLOCKED_ID, profile(BLOCKED_ID, 'Bruno')],
  [FRIEND_ID, profile(FRIEND_ID, 'Filipa')],
]);

/** The values a `where` condition names (`In([...])` or one string), or
 *  null when the condition is absent. */
function valuesOf(condition: unknown): string[] | null {
  if (condition instanceof FindOperator) {
    return condition.value as string[];
  }
  return typeof condition === 'string' ? [condition] : null;
}

/** The ids a `where.id` names, or null when there is none. */
function idsOf(where: { id?: unknown } | undefined): string[] | null {
  return valuesOf(where?.id);
}

function buildCore(doubles: CoreDoubles): MessagingCoreService {
  const empty = {} as Record<string, never>;
  const blockFilter = {
    blockedUserIds: jest.fn((actorId: string, candidateIds: string[]) => {
      doubles.blockedUserIdsCalls.push([actorId, candidateIds]);
      return Promise.resolve(
        new Set(candidateIds.filter((id) => doubles.blockedUserIds.has(id))),
      );
    }),
  };
  const findNothing = { find: jest.fn().mockResolvedValue([]) };
  return new MessagingCoreService(
    {
      findOne: jest.fn((options: { where?: { id?: unknown } }) => {
        const ids = idsOf(options.where);
        return Promise.resolve(
          doubles.conversations.find(
            (conversation) => !ids || ids.includes(conversation.id),
          ) ?? null,
        );
      }),
      find: jest.fn(
        (options: { where?: { id?: unknown; kind?: ConversationKind } }) => {
          const ids = idsOf(options.where);
          return Promise.resolve(
            doubles.conversations.filter(
              (conversation) =>
                (!ids || ids.includes(conversation.id)) &&
                (!options.where?.kind ||
                  conversation.kind === options.where.kind),
            ),
          );
        },
      ),
    } as unknown as Repository<Conversation>,
    {
      find: jest.fn((options: { where?: { conversationId?: unknown } }) => {
        const conversationIds = valuesOf(options.where?.conversationId);
        return Promise.resolve(
          doubles.participants.filter(
            (participant) =>
              !conversationIds ||
              conversationIds.includes(participant.conversationId),
          ),
        );
      }),
    } as unknown as Repository<ConversationParticipant>,
    {
      find: jest.fn((options: { where?: { id?: unknown } }) => {
        const ids = idsOf(options.where);
        return Promise.resolve(
          doubles.messages.filter(
            (message) => !ids || ids.includes(message.id),
          ),
        );
      }),
    } as unknown as Repository<Message>,
    {
      find: jest.fn().mockResolvedValue(doubles.reactions),
    } as unknown as Repository<MessageReaction>,
    findNothing as unknown as Repository<ConversationPinnedMessage>,
    findNothing as unknown as Repository<MessageStar>,
    findNothing as unknown as Repository<MessageHide>,
    findNothing as unknown as Repository<ContentModeration>,
    {
      find: jest.fn().mockResolvedValue([...PROFILE_BY_USER.values()]),
    } as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    empty as unknown as DataSource,
    empty as unknown as EventEmitter2,
    {
      findById: jest.fn().mockResolvedValue({ role: UserRole.Member }),
    } as unknown as UsersService,
    {
      getByIds: jest.fn().mockResolvedValue([]),
      describeIdentities: jest.fn().mockResolvedValue(new Map()),
    } as unknown as IdentitiesService,
    {
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
    } as unknown as IdentityAttributionService,
    empty as unknown as StorageService,
    blockFilter as unknown as BlockFilterService,
  );
}

function freshDoubles(): CoreDoubles {
  return {
    conversations: [
      { id: GROUP_ID, kind: ConversationKind.Group, isOfficial: false },
      { id: DIRECT_ID, kind: ConversationKind.Direct, isOfficial: false },
    ],
    participants: [],
    messages: [
      { id: GROUP_MESSAGE_ID, conversationId: GROUP_ID },
      { id: DIRECT_MESSAGE_ID, conversationId: DIRECT_ID },
    ],
    reactions: [],
    blockedUserIds: new Set([BLOCKED_ID]),
    blockedUserIdsCalls: [],
  };
}

describe('SEC-26: group roster watermarks for a blocked member', () => {
  const seats = [seat(VIEWER_ID), seat(BLOCKED_ID), seat(FRIEND_ID)];
  const privacyByUser = new Map<string, MessagingPrivacyDTO>();

  it('withholds read, read-instant and delivered watermarks on a blocked row', () => {
    const members = buildCore(freshDoubles()).buildMemberSummaries(
      seats,
      PROFILE_BY_USER,
      VIEWER_ID,
      privacyByUser,
      new Set([BLOCKED_ID]),
    );
    const blockedRow = members.find((member) => member.id === BLOCKED_ID);

    expect(blockedRow).toMatchObject({
      name: 'Bruno Lopes',
      lastReadAt: null,
      lastReadInstant: null,
      deliveredAt: null,
    });
  });

  it('keeps every watermark on an unblocked row and on the viewer row', () => {
    const members = buildCore(freshDoubles()).buildMemberSummaries(
      seats,
      PROFILE_BY_USER,
      VIEWER_ID,
      privacyByUser,
      new Set([BLOCKED_ID]),
    );

    for (const userId of [VIEWER_ID, FRIEND_ID]) {
      expect(members.find((member) => member.id === userId)).toMatchObject({
        lastReadAt: READ_AT.toISOString(),
        lastReadInstant: READ_INSTANT.toISOString(),
        deliveredAt: DELIVERED_AT.toISOString(),
      });
    }
  });
});

describe('SEC-26: group reaction counts from a blocked reactor', () => {
  it('leaves a blocked reactor out of a group message count', async () => {
    const doubles = freshDoubles();
    doubles.reactions = [
      {
        messageId: GROUP_MESSAGE_ID,
        userId: BLOCKED_ID,
        key: MessageReactionKey.Love,
      },
      {
        messageId: GROUP_MESSAGE_ID,
        userId: FRIEND_ID,
        key: MessageReactionKey.Love,
      },
      {
        messageId: GROUP_MESSAGE_ID,
        userId: VIEWER_ID,
        key: MessageReactionKey.Laugh,
      },
    ];

    const summaries = await buildCore(doubles).reactionSummariesByMessage(
      [GROUP_MESSAGE_ID],
      VIEWER_ID,
    );
    const byKey = new Map(
      (summaries.get(GROUP_MESSAGE_ID) ?? []).map((summary) => [
        summary.key,
        summary,
      ]),
    );

    expect(byKey.get(MessageReactionKey.Love)).toMatchObject({
      count: 1,
      mine: false,
    });
    expect(byKey.get(MessageReactionKey.Laugh)).toMatchObject({
      count: 1,
      mine: true,
    });
    expect(doubles.blockedUserIdsCalls).toEqual([
      [VIEWER_ID, [BLOCKED_ID, FRIEND_ID]],
    ]);
  });

  it('keeps every reaction on a direct thread message', async () => {
    const doubles = freshDoubles();
    doubles.reactions = [
      {
        messageId: DIRECT_MESSAGE_ID,
        userId: BLOCKED_ID,
        key: MessageReactionKey.Love,
      },
    ];

    const summaries = await buildCore(doubles).reactionSummariesByMessage(
      [DIRECT_MESSAGE_ID],
      VIEWER_ID,
    );
    const love = (summaries.get(DIRECT_MESSAGE_ID) ?? []).find(
      (summary) => summary.key === MessageReactionKey.Love,
    );

    expect(love?.count).toBe(1);
  });

  it('skips the block read when only the viewer reacted', async () => {
    const doubles = freshDoubles();
    doubles.reactions = [
      {
        messageId: GROUP_MESSAGE_ID,
        userId: VIEWER_ID,
        key: MessageReactionKey.Love,
      },
    ];

    await buildCore(doubles).reactionSummariesByMessage(
      [GROUP_MESSAGE_ID],
      VIEWER_ID,
    );

    expect(doubles.blockedUserIdsCalls).toEqual([]);
  });
});

describe('SEC-26: the "who reacted" list in a group', () => {
  function buildAnnotations(
    doubles: CoreDoubles,
    conversationKind: ConversationKind,
  ): MessageAnnotationsService {
    const core = buildCore(doubles);
    const viewerSeat = seat(VIEWER_ID);
    jest.spyOn(core, 'requireParticipant').mockResolvedValue(viewerSeat);
    jest.spyOn(core, 'isMessageWithheldFromViewer').mockResolvedValue(false);
    jest
      .spyOn(core, 'loadReactorView')
      .mockResolvedValue(
        conversationKind === ConversationKind.Group
          ? { shape: 'individuals', isGroup: true }
          : { shape: 'individuals' },
      );
    const reactionRows = doubles.reactions.map((row) => ({
      ...row,
      profile: PROFILE_BY_USER.get(row.userId),
    }));
    const reactorsQuery: Record<string, jest.Mock> = {};
    for (const method of [
      'innerJoinAndMapOne',
      'where',
      'orderBy',
      'setParameter',
      'addOrderBy',
      'limit',
    ]) {
      reactorsQuery[method] = jest.fn(() => reactorsQuery);
    }
    reactorsQuery.getMany = jest.fn(() => Promise.resolve(reactionRows));
    const empty = {} as Record<string, never>;
    return new MessageAnnotationsService(
      empty as unknown as Repository<Conversation>,
      empty as unknown as Repository<ConversationParticipant>,
      {
        findOne: jest.fn().mockResolvedValue({
          id: GROUP_MESSAGE_ID,
          conversationId: GROUP_ID,
          createdAt: new Date('2026-11-20T08:00:00.000Z'),
          deletedAt: null,
        }),
      } as unknown as Repository<Message>,
      {
        createQueryBuilder: jest.fn(() => reactorsQuery),
      } as unknown as Repository<MessageReaction>,
      empty as unknown as Repository<ConversationPinnedMessage>,
      empty as unknown as Repository<MessageStar>,
      {
        exist: jest.fn().mockResolvedValue(false),
      } as unknown as Repository<MessageHide>,
      empty as unknown as Repository<Profile>,
      core,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );
  }

  function reactionsBy(userIds: string[]): ReactionRow[] {
    return userIds.map((userId) => ({
      messageId: GROUP_MESSAGE_ID,
      userId,
      key: MessageReactionKey.Love,
    }));
  }

  it('leaves a blocked reactor out of a group list', async () => {
    const doubles = freshDoubles();
    doubles.reactions = reactionsBy([VIEWER_ID, BLOCKED_ID, FRIEND_ID]);

    const response = await buildAnnotations(
      doubles,
      ConversationKind.Group,
    ).listMessageReactors(GROUP_ID, GROUP_MESSAGE_ID, VIEWER_ID);

    expect(
      response.reactors.map((reactor) => reactor.member.displayName),
    ).toEqual(['Vera Lopes', 'Filipa Lopes']);
  });

  it('keeps every reactor outside a group', async () => {
    const doubles = freshDoubles();
    doubles.reactions = reactionsBy([VIEWER_ID, BLOCKED_ID]);

    const response = await buildAnnotations(
      doubles,
      ConversationKind.Direct,
    ).listMessageReactors(GROUP_ID, GROUP_MESSAGE_ID, VIEWER_ID);

    expect(response.reactors).toHaveLength(2);
    expect(doubles.blockedUserIdsCalls).toEqual([]);
  });
});

describe('SEC-26: group reactor view', () => {
  it('marks a group reactor view as a group', async () => {
    const view = await buildCore(freshDoubles()).loadReactorView(
      GROUP_ID,
      seat(VIEWER_ID),
    );

    expect(view).toMatchObject({ shape: 'individuals', isGroup: true });
  });
});

describe('SEC-26: delivered ticks in a group with a blocked member', () => {
  const SENT_AT = new Date('2026-11-20T09:00:00.000Z');

  function ownMessage(): Message {
    return {
      id: 'own-message',
      conversationId: GROUP_ID,
      senderId: VIEWER_ID,
      senderIdentityId: `identity-${VIEWER_ID}`,
      body: 'See you all at the door',
      replyToId: null,
      createdAt: SENT_AT,
      editedAt: null,
      deletedAt: null,
      clientMessageId: null,
      forwarded: false,
      kind: MessageKind.User,
      systemEvent: null,
      attachment: null,
    } as unknown as Message;
  }

  /** A group of the viewer and two members: the friend has acked the
   *  message, the other member has acked nothing. */
  function doublesWithOtherMember(otherMemberId: string): CoreDoubles {
    const doubles = freshDoubles();
    doubles.participants = [
      seat(VIEWER_ID),
      seat(FRIEND_ID, DELIVERED_AT),
      seat(otherMemberId, null),
    ];
    return doubles;
  }

  it('counts the message delivered once every member outside the block has it', async () => {
    const doubles = doublesWithOtherMember(BLOCKED_ID);

    const [response] = await buildCore(doubles).toMessageResponses(
      [ownMessage()],
      VIEWER_ID,
      false,
      ConversationKind.Group,
    );

    expect(response?.deliveredAt).toBe(DELIVERED_AT.toISOString());
    expect(doubles.blockedUserIdsCalls).toContainEqual([
      VIEWER_ID,
      [FRIEND_ID, BLOCKED_ID],
    ]);
  });

  it('keeps one tick while an unblocked member has not received it', async () => {
    const doubles = doublesWithOtherMember('other-member');

    const [response] = await buildCore(doubles).toMessageResponses(
      [ownMessage()],
      VIEWER_ID,
      false,
      ConversationKind.Group,
    );

    expect(response?.deliveredAt).toBeNull();
  });

  it('skips the block read on a page with no message from the viewer', async () => {
    const doubles = doublesWithOtherMember(BLOCKED_ID);
    const friendMessage: Message = {
      ...ownMessage(),
      senderId: FRIEND_ID,
      senderIdentityId: `identity-${FRIEND_ID}`,
    };

    await buildCore(doubles).toMessageResponses(
      [friendMessage],
      VIEWER_ID,
      false,
      ConversationKind.Group,
    );

    expect(doubles.blockedUserIdsCalls).toEqual([]);
  });
});
