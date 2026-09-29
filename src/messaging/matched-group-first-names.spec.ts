import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import type { MessagingPrivacyDTO } from '../preferences/preferences-response';
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
import { Message, MessageKind } from './entities/message.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import {
  buildReplyTo,
  buildSystemEvent,
  displayNameFor,
  memberNameOptionsFor,
  requireAuthorSummary,
} from './message-response';
import { MessagingCoreService } from './messaging-core.service';

/**
 * PRD-423: a matched Go together group chat (`isGoTogetherChat` set) hands
 * every member the other members' first names only, the same restraint the
 * group card shows before anyone meets. Pronouns stay. A normal group keeps
 * each member's full name.
 */

const CONVERSATION_ID = 'conversation-1';
const MATCH_GROUP_ID = 'match-group-1';
const ANA_ID = 'ana-1';
const BEA_ID = 'bea-1';
const ANA_IDENTITY_ID = 'identity-ana';
const BEA_IDENTITY_ID = 'identity-bea';

const ANA_PROFILE = {
  userId: ANA_ID,
  firstName: 'Ana',
  lastName: 'Sousa',
  // Signup builds a slug from the full name (`users.service.ts`).
  slug: 'ana-sousa',
  pronouns: 'she/her',
  avatarUrl: null,
  photoVisible: true,
} as unknown as Profile;
const BEA_PROFILE = {
  userId: BEA_ID,
  firstName: 'Bea',
  lastName: 'Lopes',
  slug: 'bea-lopes',
  pronouns: 'they/them',
  avatarUrl: null,
  photoVisible: true,
} as unknown as Profile;

const PROFILE_BY_USER = new Map<string, Profile>([
  [ANA_ID, ANA_PROFILE],
  [BEA_ID, BEA_PROFILE],
]);

const MATCHED_NAMES = memberNameOptionsFor({
  isGoTogetherChat: true,
  eventMatchGroupId: MATCH_GROUP_ID,
});
const NORMAL_GROUP_NAMES = memberNameOptionsFor({ eventMatchGroupId: null });

function seat(userId: string, identityId: string): ConversationParticipant {
  return {
    id: `seat-${userId}`,
    conversationId: CONVERSATION_ID,
    userId,
    identityId,
    role: ConversationRole.Member,
    leftAt: null,
    removedAt: null,
    clearedAt: null,
    historyFloorAt: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
  } as unknown as ConversationParticipant;
}

const SEATS = [seat(ANA_ID, ANA_IDENTITY_ID), seat(BEA_ID, BEA_IDENTITY_ID)];

function messageRow(overrides: Partial<Message>): Message {
  return {
    id: 'message-1',
    conversationId: CONVERSATION_ID,
    senderId: ANA_ID,
    senderIdentityId: ANA_IDENTITY_ID,
    body: 'See you at the door',
    replyToId: null,
    createdAt: new Date('2026-09-29T10:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
    clientMessageId: null,
    forwarded: false,
    kind: MessageKind.User,
    systemEvent: null,
    attachment: null,
    ...overrides,
  } as unknown as Message;
}

const ANA_MESSAGE = messageRow({ id: 'message-ana' });
const BEA_REPLY = messageRow({
  id: 'message-bea-reply',
  senderId: BEA_ID,
  senderIdentityId: BEA_IDENTITY_ID,
  body: 'Great',
  replyToId: ANA_MESSAGE.id,
  createdAt: new Date('2026-09-29T10:01:00.000Z'),
});
const REMOVAL_PILL = messageRow({
  id: 'message-pill',
  kind: MessageKind.System,
  body: '',
  systemEvent: { type: 'member_removed', actorId: ANA_ID, targetId: BEA_ID },
  createdAt: new Date('2026-09-29T10:02:00.000Z'),
});

/** A real `MessagingCoreService` over stand-in repositories, reading one
 *  group conversation whose `eventMatchGroupId` the test chooses. The
 *  durable flag follows the link unless the test sets it apart. */
function buildCore(
  eventMatchGroupId: string | null,
  isGoTogetherChat = eventMatchGroupId !== null,
) {
  const empty = {} as Record<string, never>;
  const findNothing = { find: jest.fn().mockResolvedValue([]) };
  return new MessagingCoreService(
    {
      findOne: jest.fn().mockResolvedValue({
        id: CONVERSATION_ID,
        kind: ConversationKind.Group,
        isOfficial: false,
        isGoTogetherChat,
        eventMatchGroupId,
      }),
    } as unknown as Repository<Conversation>,
    {
      find: jest.fn().mockResolvedValue(SEATS),
    } as unknown as Repository<ConversationParticipant>,
    {
      find: jest.fn().mockResolvedValue([ANA_MESSAGE]),
    } as unknown as Repository<Message>,
    findNothing as unknown as Repository<MessageReaction>,
    findNothing as unknown as Repository<ConversationPinnedMessage>,
    findNothing as unknown as Repository<MessageStar>,
    findNothing as unknown as Repository<MessageHide>,
    findNothing as unknown as Repository<ContentModeration>,
    {
      find: jest.fn().mockResolvedValue([ANA_PROFILE, BEA_PROFILE]),
    } as unknown as Repository<Profile>,
    empty as unknown as Repository<Sticker>,
    empty as unknown as DataSource,
    empty as unknown as EventEmitter2,
    {
      findById: jest.fn().mockResolvedValue({ role: UserRole.Member }),
    } as unknown as UsersService,
    {
      getByIds: jest.fn().mockResolvedValue([
        { id: ANA_IDENTITY_ID, kind: IdentityKind.Profile },
        { id: BEA_IDENTITY_ID, kind: IdentityKind.Profile },
      ]),
      describeIdentities: jest.fn().mockResolvedValue(new Map()),
    } as unknown as IdentitiesService,
    {
      buildStaffNameResolver: jest
        .fn()
        .mockResolvedValue({ resolve: () => null }),
    } as unknown as IdentityAttributionService,
  );
}

async function readThreadAs(
  viewerId: string,
  eventMatchGroupId: string | null,
) {
  return buildCore(eventMatchGroupId).toMessageResponses(
    [ANA_MESSAGE, BEA_REPLY, REMOVAL_PILL],
    viewerId,
    false,
    ConversationKind.Group,
  );
}

describe('PRD-423: matched Go together chats show first names only', () => {
  describe('displayNameFor', () => {
    it('spells a matched chat member by first name and anyone else by full name', () => {
      expect(displayNameFor(ANA_PROFILE, MATCHED_NAMES)).toBe('Ana');
      expect(displayNameFor(ANA_PROFILE, NORMAL_GROUP_NAMES)).toBe('Ana Sousa');
      expect(displayNameFor(ANA_PROFILE)).toBe('Ana Sousa');
    });

    it('reads a conversation row without either Go together column as full names', () => {
      expect(memberNameOptionsFor(undefined).isMatchedGroup).toBe(false);
      expect(memberNameOptionsFor({}).isMatchedGroup).toBe(false);
      expect(
        memberNameOptionsFor({
          isGoTogetherChat: false,
          eventMatchGroupId: null,
        }).isMatchedGroup,
      ).toBe(false);
      expect(MATCHED_NAMES.isMatchedGroup).toBe(true);
    });

    it('keeps first names once the group row is gone and only the durable flag remains', () => {
      expect(
        memberNameOptionsFor({
          isGoTogetherChat: true,
          eventMatchGroupId: null,
        }).isMatchedGroup,
      ).toBe(true);
    });

    it('reads a row that selected only the group link as a matched chat', () => {
      expect(
        memberNameOptionsFor({ eventMatchGroupId: MATCH_GROUP_ID })
          .isMatchedGroup,
      ).toBe(true);
    });
  });

  describe('message author summaries', () => {
    it('names every author, reply quote and system pill by first name in a matched chat', async () => {
      const [anaMessage, beaReply, removalPill] = await readThreadAs(
        BEA_ID,
        MATCH_GROUP_ID,
      );

      expect(anaMessage!.sender.displayName).toBe('Ana');
      expect(anaMessage!.sender.pronouns).toBe('she/her');
      expect(beaReply!.sender.displayName).toBe('Bea');
      expect(beaReply!.replyTo?.senderName).toBe('Ana');
      expect(removalPill!.systemEvent?.actorName).toBe('Ana');
      expect(removalPill!.systemEvent?.targetName).toBe('Bea');
      // Every displayed name field, and only those: a handle is a slug, which
      // signup builds from the full name (see the fixtures above).
      const displayedNames = [
        anaMessage!.sender.displayName,
        beaReply!.sender.displayName,
        beaReply!.replyTo?.senderName,
        removalPill!.systemEvent?.actorName,
        removalPill!.systemEvent?.targetName,
      ].join(' ');
      expect(displayedNames).not.toMatch(/Sousa|Lopes/);
    });

    it('keeps first names in a dissolved chat whose group row was deleted', async () => {
      const [anaMessage, beaReply] = await buildCore(
        null,
        true,
      ).toMessageResponses(
        [ANA_MESSAGE, BEA_REPLY],
        BEA_ID,
        false,
        ConversationKind.Group,
      );

      expect(anaMessage!.sender.displayName).toBe('Ana');
      expect(beaReply!.replyTo?.senderName).toBe('Ana');
    });

    it('keeps full names in a normal group', async () => {
      const [anaMessage, beaReply, removalPill] = await readThreadAs(
        BEA_ID,
        null,
      );

      expect(anaMessage!.sender.displayName).toBe('Ana Sousa');
      expect(beaReply!.sender.displayName).toBe('Bea Lopes');
      expect(beaReply!.replyTo?.senderName).toBe('Ana Sousa');
      expect(removalPill!.systemEvent?.actorName).toBe('Ana Sousa');
      expect(removalPill!.systemEvent?.targetName).toBe('Bea Lopes');
    });

    it('reads the matched flag off a caller-supplied conversation row with no lookup of its own', async () => {
      const core = buildCore(null);
      const conversations = (
        core as unknown as { conversations: { findOne: jest.Mock } }
      ).conversations;

      const [anaMessage] = await core.toMessageResponses(
        [ANA_MESSAGE],
        BEA_ID,
        false,
        {
          kind: ConversationKind.Group,
          isGoTogetherChat: true,
          eventMatchGroupId: MATCH_GROUP_ID,
        },
      );

      expect(anaMessage!.sender.displayName).toBe('Ana');
      expect(conversations.findOne).not.toHaveBeenCalled();
    });

    it('spells the pure author helpers by the options they are handed', () => {
      expect(requireAuthorSummary(ANA_PROFILE, MATCHED_NAMES).displayName).toBe(
        'Ana',
      );
      expect(requireAuthorSummary(ANA_PROFILE).displayName).toBe('Ana Sousa');
      expect(
        buildReplyTo(
          ANA_MESSAGE.id,
          new Map([[ANA_MESSAGE.id, ANA_MESSAGE]]),
          PROFILE_BY_USER,
          new Set(),
          MATCHED_NAMES,
        )?.senderName,
      ).toBe('Ana');
      expect(
        buildSystemEvent(
          REMOVAL_PILL.systemEvent,
          PROFILE_BY_USER,
          ANA_ID,
          MATCHED_NAMES,
        )?.targetName,
      ).toBe('Bea');
    });
  });

  describe('participant list and inbox preview', () => {
    const core = buildCore(MATCH_GROUP_ID);
    const privacyByUser = new Map<string, MessagingPrivacyDTO>();

    it('lists a matched chat roster and avatar preview by first name', () => {
      const members = core.buildMemberSummaries(
        SEATS,
        PROFILE_BY_USER,
        BEA_ID,
        privacyByUser,
        MATCHED_NAMES,
      );
      const preview = core.buildMemberPreview(
        SEATS,
        PROFILE_BY_USER,
        MATCHED_NAMES,
      );

      expect(members.map((member) => member.name)).toEqual(['Ana', 'Bea']);
      expect(preview.map((member) => member.name)).toEqual(['Ana', 'Bea']);
    });

    it('keeps a normal group roster and avatar preview in full names', () => {
      const members = core.buildMemberSummaries(
        SEATS,
        PROFILE_BY_USER,
        BEA_ID,
        privacyByUser,
        NORMAL_GROUP_NAMES,
      );
      const preview = core.buildMemberPreview(SEATS, PROFILE_BY_USER);

      expect(members.map((member) => member.name)).toEqual([
        'Ana Sousa',
        'Bea Lopes',
      ]);
      expect(preview.map((member) => member.name)).toEqual([
        'Ana Sousa',
        'Bea Lopes',
      ]);
    });

    it('previews a matched chat inbox line under the sender first name', () => {
      const matchedPreview = core.buildLastMessagePreview(
        ANA_MESSAGE,
        CONVERSATION_ID,
        PROFILE_BY_USER,
        [],
        BEA_ID,
        undefined,
        undefined,
        MATCHED_NAMES,
      );
      const normalPreview = core.buildLastMessagePreview(
        ANA_MESSAGE,
        CONVERSATION_ID,
        PROFILE_BY_USER,
        [],
        BEA_ID,
      );

      expect(matchedPreview.sender.displayName).toBe('Ana');
      expect(normalPreview.sender.displayName).toBe('Ana Sousa');
    });
  });
});
