// The listener imports `ChatGateway` as its injection token, which loads the
// ESM-only `cookie` package and Sentry; stubbed the way the gateway's own
// specs stub them.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { IdentityKind } from '../identities/entities/identity.entity';
import { MAILBOX_STAFFING_FRAME } from '../identities/identity-staffing.events';
import {
  CONVERSATION_CLAIM_FRAME,
  ConversationClaimChangedEvent,
} from '../messaging/conversation-claim';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { MailboxStaffRelayListener } from './mailbox-staff-relay.listener';

/**
 * Task 19: the `conversation:claim` frame names staff, so it reaches the
 * thread's reachable STAFF seats only, each through its own `user:` room.
 * The namespace stand-in records every room each emit targeted, so a test
 * can assert both who received the frame and that nobody else did.
 */

const CONVERSATION_ID = 'conversation-1';
const CUSTOMER_USER_ID = 'customer-1';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const MAILBOX_IDENTITY_ID = 'identity-mailbox';
const CHANGED_AT = new Date('2026-03-01T09:00:00.000Z');

function seat(
  userId: string,
  identityId: string,
  leftAt: Date | null = null,
): ConversationParticipant {
  return { userId, identityId, leftAt } as ConversationParticipant;
}

function profileOf(userId: string) {
  return {
    userId,
    slug: `${userId}-handle`,
    firstName: userId,
    lastName: 'Staff',
    pronouns: null,
    photoVisible: false,
    avatarUrl: null,
  };
}

function claimEvent(
  overrides: Partial<ConversationClaimChangedEvent> = {},
): ConversationClaimChangedEvent {
  return {
    conversationId: CONVERSATION_ID,
    mailboxIdentityId: MAILBOX_IDENTITY_ID,
    change: 'claimed',
    isImplicit: false,
    actorUserId: 'rui',
    claimedByUserId: 'rui',
    previousClaimantUserId: null,
    changedAt: CHANGED_AT,
    ...overrides,
  };
}

function makeListener(options: {
  seats: ConversationParticipant[];
  blockedWithCustomerUserIds?: string[];
  hasCustomerBlockedBusiness?: boolean;
  isNamespaceMissing?: boolean;
}) {
  const emits: Array<{ rooms: string[]; frameName: string; frame: unknown }> =
    [];
  const namespace = {
    to: jest.fn((room: string | string[]) => {
      const rooms = Array.isArray(room) ? [...room] : [room];
      const target = {
        to: (nextRoom: string | string[]) => {
          rooms.push(...(Array.isArray(nextRoom) ? nextRoom : [nextRoom]));
          return target;
        },
        except: () => target,
        emit: (frameName: string, frame: unknown) => {
          emits.push({ rooms, frameName, frame });
          return true;
        },
      };
      return target;
    }),
  };
  const chatGateway = {
    namespace: options.isNamespaceMissing ? undefined : namespace,
  };
  const conversationParticipants = {
    find: jest.fn().mockResolvedValue(options.seats),
  };
  const profiles = {
    find: jest.fn(({ where }: { where: { userId: { value: string[] } } }) =>
      Promise.resolve(where.userId.value.map(profileOf)),
    ),
  };
  const identities = {
    getByIds: jest.fn().mockResolvedValue([
      { id: CUSTOMER_IDENTITY_ID, kind: IdentityKind.Profile },
      { id: MAILBOX_IDENTITY_ID, kind: IdentityKind.Listing },
    ]),
  };
  const blockedWithCustomer = new Set(options.blockedWithCustomerUserIds);
  const blockFilter = {
    blockedUserIds: jest.fn((_userId: string, candidateUserIds: string[]) =>
      Promise.resolve(
        new Set(
          candidateUserIds.filter((candidate) =>
            blockedWithCustomer.has(candidate),
          ),
        ),
      ),
    ),
    identityBlocksAmong: jest.fn().mockResolvedValue(
      options.hasCustomerBlockedBusiness
        ? [
            {
              blockerUserId: CUSTOMER_USER_ID,
              identityId: MAILBOX_IDENTITY_ID,
            },
          ]
        : [],
    ),
  };
  const listener = new MailboxStaffRelayListener(
    chatGateway as never,
    conversationParticipants as never,
    profiles as never,
    identities as never,
    blockFilter as never,
  );
  const targetedRooms = () => emits.flatMap((emit) => emit.rooms);
  return { listener, emits, targetedRooms, profiles, namespace };
}

const standardSeats = [
  seat(CUSTOMER_USER_ID, CUSTOMER_IDENTITY_ID),
  seat('rui', MAILBOX_IDENTITY_ID),
  seat('ana', MAILBOX_IDENTITY_ID),
  seat('blocked-staff', MAILBOX_IDENTITY_ID),
  seat('departed-staff', MAILBOX_IDENTITY_ID, new Date('2026-02-01')),
];

describe('MailboxStaffRelayListener: conversation:claim', () => {
  it('reaches every reachable staff user room and no other room', async () => {
    const { listener, emits, targetedRooms } = makeListener({
      seats: standardSeats,
      blockedWithCustomerUserIds: ['blocked-staff'],
    });

    await listener.handleConversationClaimChanged(claimEvent());

    expect(targetedRooms().sort()).toEqual(['user:ana', 'user:rui']);
    expect(targetedRooms()).not.toContain(`user:${CUSTOMER_USER_ID}`);
    expect(targetedRooms()).not.toContain(CONVERSATION_ID);
    expect(targetedRooms()).not.toContain('user:blocked-staff');
    expect(targetedRooms()).not.toContain('user:departed-staff');
    expect(
      emits.every((emit) => emit.frameName === CONVERSATION_CLAIM_FRAME),
    ).toBe(true);
  });

  it('renders the actor, claimant and previous claimant from one profile read', async () => {
    const { listener, emits, profiles } = makeListener({
      seats: standardSeats,
    });

    await listener.handleConversationClaimChanged(
      claimEvent({ change: 'taken_over', previousClaimantUserId: 'ana' }),
    );

    expect(profiles.find).toHaveBeenCalledTimes(1);
    expect(emits[0]!.frame).toEqual({
      conversationId: CONVERSATION_ID,
      mailboxIdentityId: MAILBOX_IDENTITY_ID,
      change: 'taken_over',
      isImplicit: false,
      actor: expect.objectContaining({ handle: 'rui-handle' }),
      claimedByUserId: 'rui',
      claimedBy: expect.objectContaining({ handle: 'rui-handle' }),
      previousClaimant: expect.objectContaining({ handle: 'ana-handle' }),
      claimedAt: CHANGED_AT.toISOString(),
      changedAt: CHANGED_AT.toISOString(),
    });
  });

  it('renders a system release with no actor and no claimant', async () => {
    const { listener, emits } = makeListener({ seats: standardSeats });

    await listener.handleConversationClaimChanged(
      claimEvent({
        change: 'released',
        actorUserId: null,
        claimedByUserId: null,
        previousClaimantUserId: 'departed-staff',
      }),
    );

    expect(emits[0]!.frame).toEqual(
      expect.objectContaining({
        change: 'released',
        actor: null,
        claimedByUserId: null,
        claimedBy: null,
        claimedAt: null,
        previousClaimant: expect.objectContaining({
          handle: 'departed-staff-handle',
        }),
      }),
    );
  });

  it('reaches nobody when the customer blocked the business', async () => {
    const { listener, emits } = makeListener({
      seats: standardSeats,
      hasCustomerBlockedBusiness: true,
    });

    await listener.handleConversationClaimChanged(claimEvent());

    expect(emits).toEqual([]);
  });

  it('reaches nobody on a thread whose mailbox is some other identity', async () => {
    const { listener, emits } = makeListener({ seats: standardSeats });

    await listener.handleConversationClaimChanged(
      claimEvent({ mailboxIdentityId: 'identity-other' }),
    );

    expect(emits).toEqual([]);
  });

  it('logs and swallows a failure', async () => {
    const { listener } = makeListener({ seats: standardSeats });
    Object.assign(listener, {
      conversationParticipants: {
        find: jest.fn().mockRejectedValue(new Error('database down')),
      },
    });

    await expect(
      listener.handleConversationClaimChanged(claimEvent()),
    ).resolves.toBeUndefined();
  });

  it('does nothing when the gateway has no namespace yet', async () => {
    const { listener } = makeListener({
      seats: standardSeats,
      isNamespaceMissing: true,
    });

    await expect(
      listener.handleConversationClaimChanged(claimEvent()),
    ).resolves.toBeUndefined();
  });
});

/**
 * Task 25: the `mailbox:staffing` frame announces a change to who staffs a
 * mailbox, so it reaches the affected member's own `user:` room and nobody
 * else: no colleague, no conversation room, no customer.
 */
describe('MailboxStaffRelayListener: mailbox:staffing', () => {
  it("reaches the affected member's user room and no other room", () => {
    const { listener, emits, targetedRooms, namespace } = makeListener({
      seats: standardSeats,
    });

    listener.handleIdentityStaffingChanged({
      identityId: MAILBOX_IDENTITY_ID,
      userId: 'new-colleague',
      isStaff: true,
    });

    expect(targetedRooms()).toEqual(['user:new-colleague']);
    expect(namespace.to).toHaveBeenCalledTimes(1);
    for (const colleagueRoom of ['user:rui', 'user:ana']) {
      expect(targetedRooms()).not.toContain(colleagueRoom);
    }
    expect(targetedRooms()).not.toContain(`user:${CUSTOMER_USER_ID}`);
    expect(targetedRooms()).not.toContain(CONVERSATION_ID);
    expect(emits).toEqual([
      {
        rooms: ['user:new-colleague'],
        frameName: MAILBOX_STAFFING_FRAME,
        frame: { identityId: MAILBOX_IDENTITY_ID, isStaff: true },
      },
    ]);
  });

  it('tells a departing member they lost the mailbox, in their room alone', () => {
    const { listener, emits } = makeListener({ seats: standardSeats });

    listener.handleIdentityStaffingChanged({
      identityId: MAILBOX_IDENTITY_ID,
      userId: 'ana',
      isStaff: false,
    });

    expect(emits).toEqual([
      {
        rooms: ['user:ana'],
        frameName: MAILBOX_STAFFING_FRAME,
        frame: { identityId: MAILBOX_IDENTITY_ID, isStaff: false },
      },
    ]);
  });

  it('does nothing when the gateway has no namespace yet', () => {
    const { listener } = makeListener({
      seats: standardSeats,
      isNamespaceMissing: true,
    });

    expect(() =>
      listener.handleIdentityStaffingChanged({
        identityId: MAILBOX_IDENTITY_ID,
        userId: 'ana',
        isStaff: true,
      }),
    ).not.toThrow();
  });
});
