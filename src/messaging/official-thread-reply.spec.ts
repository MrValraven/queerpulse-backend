import { ForbiddenException } from '@nestjs/common';
import { UserStatus } from '../users/entities/user.entity';
import { ConversationKind } from './entities/conversation.entity';
import {
  MessagesService,
  OFFICIAL_THREAD_READ_ONLY_CODE,
} from './messages.service';

/**
 * PRD-372: who may write into an official thread. Its member replies, and
 * the QueerPulse Team's staff are seated BEFORE the reply is stored, so its
 * live frame and unread count reach them. A live staff seat replies as the
 * team. Every other seat keeps the coded refusal.
 */

const CONVERSATION_ID = 'official-thread';
const MEMBER_ID = 'member-user';
const MODERATOR_ID = 'moderator-user';
const OFFICIAL_IDENTITY_ID = 'official-identity';

function makeService(seat: {
  userId: string;
  identityId: string;
  leftAt?: Date | null;
}) {
  const calls: string[] = [];
  const officialMailboxSeats = {
    officialIdentityId: jest.fn().mockResolvedValue(OFFICIAL_IDENTITY_ID),
    seatStaffForMemberReply: jest.fn(() => {
      calls.push('seat');
      return Promise.resolve();
    }),
  };
  const core = {
    requireParticipant: jest
      .fn()
      .mockResolvedValue({ id: 'seat', leftAt: null, ...seat }),
    postMessage: jest.fn(() => {
      calls.push('post');
      return Promise.resolve({
        response: { id: 'message-1', kind: 'user', attachment: null },
        isNew: true,
      });
    }),
  };
  const service = new MessagesService(
    {
      findOne: jest.fn().mockResolvedValue({
        id: CONVERSATION_ID,
        kind: ConversationKind.Direct,
        isOfficial: true,
        officialMemberId: MEMBER_ID,
        isGoTogetherChat: false,
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    core as never,
    { emit: jest.fn() } as never,
    {} as never,
    {} as never,
    {
      findById: jest.fn().mockResolvedValue({ status: UserStatus.Active }),
      liftExpiredRestriction: jest.fn().mockResolvedValue(false),
    } as never,
    { notify: jest.fn() } as never,
    {} as never,
    officialMailboxSeats as never,
  );
  return { service, core, officialMailboxSeats, calls };
}

describe('MessagesService.sendMessageWithOutcome, official threads (PRD-372)', () => {
  it("seats the QueerPulse Team before storing the member's reply", async () => {
    const { service, officialMailboxSeats, calls } = makeService({
      userId: MEMBER_ID,
      identityId: 'member-profile-identity',
    });

    await service.sendMessageWithOutcome(CONVERSATION_ID, MEMBER_ID, 'Hello');

    expect(officialMailboxSeats.seatStaffForMemberReply).toHaveBeenCalledWith(
      CONVERSATION_ID,
    );
    expect(calls).toEqual(['seat', 'post']);
  });

  it('lets a live staff seat reply as the team, seating nobody', async () => {
    const { service, core, officialMailboxSeats } = makeService({
      userId: MODERATOR_ID,
      identityId: OFFICIAL_IDENTITY_ID,
    });

    await service.sendMessageWithOutcome(
      CONVERSATION_ID,
      MODERATOR_ID,
      'We can help with that.',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      OFFICIAL_IDENTITY_ID,
    );

    expect(officialMailboxSeats.seatStaffForMemberReply).not.toHaveBeenCalled();
    expect(core.postMessage).toHaveBeenCalled();
  });

  it.each([
    [
      'an ended staff seat',
      {
        userId: MODERATOR_ID,
        identityId: OFFICIAL_IDENTITY_ID,
        leftAt: new Date(),
      },
    ],
    [
      'a seat that is neither the member nor the team',
      { userId: 'someone-else', identityId: 'someone-else-profile' },
    ],
  ])('refuses %s with the coded refusal', async (_label, seat) => {
    const { service, core } = makeService(seat);

    const sending = service.sendMessageWithOutcome(
      CONVERSATION_ID,
      seat.userId,
      'Hello',
    );

    await expect(sending).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sending).rejects.toMatchObject({
      response: { code: OFFICIAL_THREAD_READ_ONLY_CODE },
    });
    expect(core.postMessage).not.toHaveBeenCalled();
  });
});
