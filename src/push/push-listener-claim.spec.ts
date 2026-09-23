import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationKind } from '../messaging/entities/conversation.entity';
import { PushMessageListener } from './push.listener';

/**
 * Task 12, corrected by Task 13d: a claimed business mailbox thread narrows
 * the business's STAFF seats of `eligibleMessagePushRecipientUserIds` down to
 * the claimant, applied before the sender/leftAt/online/muted filter so an
 * online claimant still gets nothing, exactly like an online member on any
 * other thread. The customer seat is never narrowed.
 *
 * Built directly on the prototype (no `Test.createTestingModule`) since the
 * method under test only reaches the collaborators mocked below; everything
 * else the class constructor would otherwise wire up is irrelevant to this
 * filter.
 *
 * Seats: `customer` speaks for its own profile identity, and every staff
 * member speaks for the shared listing identity `mailbox-identity`.
 */
const CUSTOMER_USER_ID = 'customer';
const MAILBOX_IDENTITY_ID = 'mailbox-identity';

function makeListener(options: {
  staffUserIds: string[];
  claimedByUserId: string | null;
  onlineUserIds?: string[];
  leftUserIds?: string[];
  /** Pairs blocked either way, as `[blockerId, blockedId]`. */
  blockPairs?: [string, string][];
  /** An ordinary thread: these users, each on their own profile identity. */
  personalUserIds?: string[];
}) {
  const onlineUserIds = new Set(options.onlineUserIds ?? []);
  const leftUserIds = new Set(options.leftUserIds ?? []);
  const blockPairs = options.blockPairs ?? [];
  const seats = options.personalUserIds
    ? options.personalUserIds.map((userId) => ({
        userId,
        identityId: `profile-${userId}`,
      }))
    : [
        { userId: CUSTOMER_USER_ID, identityId: `profile-${CUSTOMER_USER_ID}` },
        ...options.staffUserIds.map((userId) => ({
          userId,
          identityId: MAILBOX_IDENTITY_ID,
        })),
      ];
  const listener = Object.create(
    PushMessageListener.prototype,
  ) as PushMessageListener;
  Object.assign(listener, {
    participants: {
      find: jest.fn().mockResolvedValue(
        seats.map((seat) => ({
          ...seat,
          leftAt: leftUserIds.has(seat.userId) ? new Date() : null,
          muted: false,
          mutedUntil: null,
          muteMode: undefined,
        })),
      ),
    },
    conversations: {
      findOne: jest.fn().mockResolvedValue({
        id: 'conversation-1',
        kind: ConversationKind.Direct,
        isOfficial: false,
        claimedByUserId: options.claimedByUserId,
      }),
    },
    identities: {
      getByIds: jest.fn((identityIds: string[]) =>
        Promise.resolve(
          [...new Set(identityIds)].map((identityId) => ({
            id: identityId,
            kind:
              identityId === MAILBOX_IDENTITY_ID
                ? IdentityKind.Listing
                : IdentityKind.Profile,
          })),
        ),
      ),
    },
    presence: {
      isOnline: jest.fn((userId: string) => onlineUserIds.has(userId)),
    },
    blockFilter: {
      identityBlocksAmong: jest.fn().mockResolvedValue([]),
      blockedUserIds: jest.fn((actorId: string, candidateIds: string[]) =>
        Promise.resolve(
          new Set(
            candidateIds.filter((candidateId) =>
              blockPairs.some(
                ([blockerId, blockedId]) =>
                  (blockerId === actorId && blockedId === candidateId) ||
                  (blockerId === candidateId && blockedId === actorId),
              ),
            ),
          ),
        ),
      ),
      mutersOf: jest.fn().mockResolvedValue(new Set<string>()),
    },
    notificationPreferences: {
      recipientsPushEnabled: jest.fn(async (userIds: string[]) => userIds),
    },
    notificationDelivery: {
      recipientsOutsideQuietHours: jest.fn(
        async (userIds: string[]) => userIds,
      ),
    },
  });
  return listener;
}

describe('eligibleMessagePushRecipientUserIds with a claim', () => {
  it('pushes to the customer and every other staff seat while the thread is unclaimed', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana', 'tiago'],
      claimedByUserId: null,
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'tiago',
    );

    expect(result).toEqual(new Set([CUSTOMER_USER_ID, 'rui', 'ana']));
  });

  it('pushes only to the claimant once the thread is claimed', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana', 'sofia', 'tiago'],
      claimedByUserId: 'rui',
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set(['rui']));
  });

  it('drops an online claimant and pushes no offline colleague in their place', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana'],
      claimedByUserId: 'rui',
      onlineUserIds: ['rui'],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set());
  });

  it('leaves an ordinary personal one-to-one thread unaffected', async () => {
    const listener = makeListener({
      staffUserIds: [],
      personalUserIds: ['marco', 'priya'],
      claimedByUserId: null,
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'marco',
    );

    expect(result).toEqual(new Set(['priya']));
  });

  it('pushes no staff once the claimant has left the mailbox, leaving the whole roster untouched', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana'],
      claimedByUserId: 'rui',
      leftUserIds: ['rui'],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set());
  });
});

describe('eligibleMessagePushRecipientUserIds with a claim and a STAFF sender (Task 13d)', () => {
  it('pushes the customer when the claimant replies on a claimed thread', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana', 'sofia'],
      claimedByUserId: 'rui',
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'rui',
    );

    expect(result).toEqual(new Set([CUSTOMER_USER_ID]));
  });

  it('pushes the customer and the claimant when a colleague replies on a claimed thread, and no other colleague', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana', 'sofia'],
      claimedByUserId: 'rui',
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'ana',
    );

    expect(result).toEqual(new Set([CUSTOMER_USER_ID, 'rui']));
  });

  it('still pushes only the claimant when the customer sends on a claimed thread', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana', 'sofia'],
      claimedByUserId: 'rui',
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set(['rui']));
  });
});

describe('eligibleMessagePushRecipientUserIds with a claim held by a blocked staff member (Task 13d)', () => {
  it('ignores the claim and pushes the remaining unblocked staff when the customer blocked the claimant', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana', 'sofia'],
      claimedByUserId: 'rui',
      blockPairs: [[CUSTOMER_USER_ID, 'rui']],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set(['ana', 'sofia']));
  });

  it('ignores the claim the same way when the claimant blocked the customer', async () => {
    const listener = makeListener({
      staffUserIds: ['rui', 'ana'],
      claimedByUserId: 'rui',
      blockPairs: [['rui', CUSTOMER_USER_ID]],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set(['ana']));
  });
});
