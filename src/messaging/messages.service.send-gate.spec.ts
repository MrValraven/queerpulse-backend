import { IdentityKind } from '../identities/entities/identity.entity';
import { UserStatus } from '../users/entities/user.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationKind } from './entities/conversation.entity';
import { MessagesService } from './messages.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Task 13c fix round 1: live coverage of the ORDINARY one-to-one send gate
 * in `MessagesService.sendMessageWithOutcome`, rewritten by Task 13c. Its
 * only earlier coverage sits in `messaging.service.spec.ts`, whose module
 * cannot construct. Two members speaking as their own profiles.
 */

const CONVERSATION_ID = 'c-direct';
const MEMBER_ID = 'member-1';
const OTHER_MEMBER_ID = 'member-2';

function seat(userId: string): ConversationParticipant {
  return {
    userId,
    conversationId: CONVERSATION_ID,
    identityId: `identity-${userId}`,
    leftAt: null,
    clearedAt: null,
  } as unknown as ConversationParticipant;
}

function buildService(options: {
  initiatorUserId: string | null;
  openedAt?: Date | null;
  isBlocked?: boolean;
  isConnected?: boolean;
}) {
  const conversation = {
    id: CONVERSATION_ID,
    kind: ConversationKind.Direct,
    isOfficial: false,
    initiatorUserId: options.initiatorUserId,
    openedAt: options.openedAt ?? null,
  };
  const seats = [seat(MEMBER_ID), seat(OTHER_MEMBER_ID)];
  const participants = {
    find: jest.fn().mockResolvedValue(seats),
    findOne: jest.fn().mockResolvedValue(seats[1]),
  };
  const identities = {
    getByIds: jest.fn().mockResolvedValue(
      seats.map((each) => ({
        id: each.identityId,
        kind: IdentityKind.Profile,
      })),
    ),
  };
  const conversations = {
    findOne: jest.fn(() => Promise.resolve({ ...conversation })),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const core = {
    requireParticipant: jest.fn((_conversationId: string, userId: string) =>
      Promise.resolve(seats.find((each) => each.userId === userId)),
    ),
    loadDirectThreadSeats: (
      conversationId: string,
      callerSeat: ConversationParticipant,
    ) =>
      MessagingCoreService.prototype.loadDirectThreadSeats.call(
        { participants, identities },
        conversationId,
        callerSeat,
      ),
    postMessage: jest
      .fn()
      .mockResolvedValue({ response: { id: 'm-new' }, isNew: false }),
  };
  const service = Object.create(MessagesService.prototype) as MessagesService;
  Object.assign(service, {
    usersService: {
      findById: jest.fn().mockResolvedValue({ status: UserStatus.Active }),
      liftExpiredRestriction: jest.fn().mockResolvedValue(false),
    },
    core,
    conversations,
    participants,
    blockFilter: {
      isBlockedEitherWay: jest.fn().mockResolvedValue(options.isBlocked),
    },
    connectionsService: {
      areConnected: jest.fn().mockResolvedValue(options.isConnected ?? false),
    },
  });
  return { service, conversations, core };
}

describe('MessagesService.sendMessageWithOutcome, the ordinary one-to-one gate', () => {
  it('refuses a send when a block exists either way', async () => {
    const { service, core } = buildService({
      initiatorUserId: MEMBER_ID,
      openedAt: new Date('2026-01-01T00:00:00.000Z'),
      isBlocked: true,
      isConnected: true,
    });

    await expect(
      service.sendMessageWithOutcome(CONVERSATION_ID, MEMBER_ID, 'Hi'),
    ).rejects.toThrow('You cannot message this member');
    expect(core.postMessage).not.toHaveBeenCalled();
  });

  it('lets accepted connections send with no gate, leaving the opened state alone', async () => {
    const { service, conversations } = buildService({
      initiatorUserId: MEMBER_ID,
      isConnected: true,
    });

    await expect(
      service.sendMessageWithOutcome(CONVERSATION_ID, MEMBER_ID, 'Hi'),
    ).resolves.toMatchObject({ response: { id: 'm-new' } });
    expect(conversations.update).not.toHaveBeenCalled();
  });

  it('refuses the initiator of an unopened thread between members who are not connected', async () => {
    const { service, core } = buildService({ initiatorUserId: MEMBER_ID });

    await expect(
      service.sendMessageWithOutcome(CONVERSATION_ID, MEMBER_ID, 'Hi again'),
    ).rejects.toThrow('You can only message accepted connections');
    expect(core.postMessage).not.toHaveBeenCalled();
  });

  it("opens the thread on the other member's first reply", async () => {
    const { service, conversations } = buildService({
      initiatorUserId: MEMBER_ID,
    });

    await service.sendMessageWithOutcome(
      CONVERSATION_ID,
      OTHER_MEMBER_ID,
      'Hello back',
    );

    expect(conversations.update).toHaveBeenCalledWith(
      CONVERSATION_ID,
      expect.objectContaining({ openedAt: expect.any(Date) as Date }),
    );
  });

  it('refuses both members of an unopened thread with no known initiator', async () => {
    const { service } = buildService({ initiatorUserId: null });

    await expect(
      service.sendMessageWithOutcome(CONVERSATION_ID, OTHER_MEMBER_ID, 'Hi'),
    ).rejects.toThrow('You can only message accepted connections');
  });
});
