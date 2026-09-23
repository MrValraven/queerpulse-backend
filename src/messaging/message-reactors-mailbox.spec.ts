import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message } from './entities/message.entity';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 13e: the "who reacted" sheet (`GET
 * /conversations/:id/messages/:messageId/reactions`) on a business mailbox
 * thread. A customer sees the business react, once per key, and never a
 * staff member; the business's own staff see each colleague. The seat rules
 * run through the real `MessagingCoreService.loadReactorView`.
 */

const CONVERSATION_ID = 'c-mailbox';
const MESSAGE_ID = 'm1';
const CUSTOMER_USER_ID = 'customer-marta';
const CUSTOMER_IDENTITY_ID = 'identity-marta';
const MAILBOX_IDENTITY_ID = 'identity-cafe-lisboa';

interface StaffMember {
  userId: string;
  firstName: string;
  lastName: string;
  handle: string;
  avatarUrl: string;
}

const TIAGO: StaffMember = {
  userId: 'staff-tiago',
  firstName: 'Tiago',
  lastName: 'Costa',
  handle: 'tiago-costa',
  avatarUrl: 'https://example.test/tiago.png',
};
const ANA: StaffMember = {
  userId: 'staff-ana',
  firstName: 'Ana',
  lastName: 'Sousa',
  handle: 'ana-sousa',
  avatarUrl: 'https://example.test/ana.png',
};
const STAFF = [TIAGO, ANA];

const STAFF_IDENTIFYING_STRINGS = STAFF.flatMap((member) => [
  member.userId,
  member.firstName,
  member.lastName,
  member.handle,
  member.avatarUrl,
]);

function staffStringsIn(value: unknown): string[] {
  const serialized = JSON.stringify(value);
  return STAFF_IDENTIFYING_STRINGS.filter((text) => serialized.includes(text));
}

function profileOf(member: StaffMember): Profile {
  return {
    userId: member.userId,
    slug: member.handle,
    firstName: member.firstName,
    lastName: member.lastName,
    pronouns: null,
    avatarUrl: member.avatarUrl,
    photoVisible: true,
  } as unknown as Profile;
}

const CUSTOMER_PROFILE = {
  userId: CUSTOMER_USER_ID,
  slug: 'marta-silva',
  firstName: 'Marta',
  lastName: 'Silva',
  pronouns: null,
  avatarUrl: null,
  photoVisible: false,
} as unknown as Profile;

function seat(userId: string, identityId: string): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId: CONVERSATION_ID,
    userId,
    identityId,
    clearedAt: null,
    leftAt: null,
  } as unknown as ConversationParticipant;
}

function reaction(userId: string, key: MessageReactionKey, profile: Profile) {
  return {
    id: `${userId}-${key}`,
    messageId: MESSAGE_ID,
    userId,
    key,
    profile,
  };
}

describe('MessageAnnotationsService.listMessageReactors on a business mailbox thread (Task 13e)', () => {
  let identityKinds: Map<string, IdentityKind>;
  let reactionRows: ReturnType<typeof reaction>[];

  beforeEach(() => {
    identityKinds = new Map([
      [MAILBOX_IDENTITY_ID, IdentityKind.Listing],
      [CUSTOMER_IDENTITY_ID, IdentityKind.Profile],
    ]);
    // In the order the query returns them: the caller's own first.
    reactionRows = [
      reaction(CUSTOMER_USER_ID, MessageReactionKey.Love, CUSTOMER_PROFILE),
      reaction(TIAGO.userId, MessageReactionKey.Love, profileOf(TIAGO)),
      reaction(ANA.userId, MessageReactionKey.Love, profileOf(ANA)),
      reaction(ANA.userId, MessageReactionKey.Laugh, profileOf(ANA)),
    ];
  });

  function buildService(callerUserId: string): MessageAnnotationsService {
    const seats = [
      seat(TIAGO.userId, MAILBOX_IDENTITY_ID),
      seat(CUSTOMER_USER_ID, CUSTOMER_IDENTITY_ID),
      seat(ANA.userId, MAILBOX_IDENTITY_ID),
    ];
    const callerSeat = seats.find(
      (candidate) => candidate.userId === callerUserId,
    )!;
    const empty = {} as Record<string, never>;
    const identities = {
      getByIds: jest.fn((identityIds: string[]) =>
        Promise.resolve(
          identityIds
            .filter((identityId) => identityKinds.has(identityId))
            .map((identityId) => ({
              id: identityId,
              kind: identityKinds.get(identityId),
            })),
        ),
      ),
      describeIdentities: jest.fn().mockResolvedValue(
        new Map([
          [
            MAILBOX_IDENTITY_ID,
            {
              displayName: 'Cafe Lisboa',
              handle: 'cafe-lisboa',
              avatarUrl: 'https://example.test/cafe.png',
            },
          ],
        ]),
      ),
    };
    const core = new MessagingCoreService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: CONVERSATION_ID,
          kind: ConversationKind.Direct,
          isOfficial: false,
        }),
      } as unknown as Repository<Conversation>,
      {
        find: jest.fn().mockResolvedValue(seats),
      } as unknown as Repository<ConversationParticipant>,
      empty as unknown as Repository<Message>,
      empty as unknown as Repository<MessageReaction>,
      empty as unknown as Repository<ConversationPinnedMessage>,
      empty as unknown as Repository<MessageStar>,
      empty as unknown as Repository<MessageHide>,
      empty as unknown as Repository<ContentModeration>,
      empty as unknown as Repository<Profile>,
      empty as unknown as Repository<Sticker>,
      empty as unknown as DataSource,
      empty as unknown as EventEmitter2,
      empty as unknown as UsersService,
      identities as unknown as IdentitiesService,
      empty as unknown as IdentityAttributionService,
    );
    jest.spyOn(core, 'requireParticipant').mockResolvedValue(callerSeat);
    jest.spyOn(core, 'isMessageWithheldFromViewer').mockResolvedValue(false);
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
    return new MessageAnnotationsService(
      empty as unknown as Repository<Conversation>,
      empty as unknown as Repository<ConversationParticipant>,
      {
        findOne: jest.fn().mockResolvedValue({
          id: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          createdAt: new Date('2026-09-22T10:00:00.000Z'),
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

  it('shows the customer the business once per key, and no staff member at all', async () => {
    const response = await buildService(CUSTOMER_USER_ID).listMessageReactors(
      CONVERSATION_ID,
      MESSAGE_ID,
      CUSTOMER_USER_ID,
    );

    expect(staffStringsIn(response)).toEqual([]);
    expect(
      response.reactors.map((reactor) => [
        reactor.key,
        reactor.member.displayName,
        reactor.isMine,
      ]),
    ).toEqual([
      [MessageReactionKey.Love, 'Marta Silva', true],
      [MessageReactionKey.Love, 'Cafe Lisboa', false],
      [MessageReactionKey.Laugh, 'Cafe Lisboa', false],
    ]);
  });

  it("shows the business's own staff each colleague who reacted", async () => {
    const response = await buildService(ANA.userId).listMessageReactors(
      CONVERSATION_ID,
      MESSAGE_ID,
      ANA.userId,
    );

    expect(
      response.reactors.map((reactor) => reactor.member.displayName),
    ).toEqual(['Marta Silva', 'Tiago Costa', 'Ana Sousa', 'Ana Sousa']);
  });

  it("lists only the customer's own reactions when a seat identity does not resolve", async () => {
    identityKinds.delete(MAILBOX_IDENTITY_ID);

    const response = await buildService(CUSTOMER_USER_ID).listMessageReactors(
      CONVERSATION_ID,
      MESSAGE_ID,
      CUSTOMER_USER_ID,
    );

    expect(staffStringsIn(response)).toEqual([]);
    expect(response.reactors).toHaveLength(1);
    expect(response.reactors[0]!.isMine).toBe(true);
  });
});
