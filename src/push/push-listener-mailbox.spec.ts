import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { ConversationKind } from '../messaging/entities/conversation.entity';
import { MessageKind } from '../messaging/entities/message.entity';
import { MessageCreatedEvent } from '../messaging/messaging.events';
import { MessageView } from '../messaging/message-response';
import { PushMessageListener } from './push.listener';
import { PushPayload } from './push.service';

/**
 * Task 13d: push for a business mailbox thread. The customer sees the
 * business and never learns which or how many humans answer for it, and a
 * block between the customer and staff member X removes X's own access
 * while the customer's experience stays the same.
 *
 * Seats: `customer` on its own profile identity, and the staff `tiago`,
 * `ana` and `rui` on the shared listing identity of "Casa Lisboa". The real
 * `IdentityAttributionService` decides the staff first name, so these cases
 * exercise the same gate the in-app sender uses.
 */
const CUSTOMER_USER_ID = 'customer';
const MAILBOX_IDENTITY_ID = 'mailbox-identity';
const BUSINESS_NAME = 'Casa Lisboa';
const BUSINESS_AVATAR_URL = 'https://cdn.example.com/casa-lisboa.jpg';
const STAFF_USER_IDS = ['tiago', 'ana', 'rui'];

beforeAll(() => {
  setImageUrlBase('https://api.queerpulse.app');
});

afterAll(() => {
  resetImageUrlBaseForTesting();
});

const PROFILES: Record<
  string,
  { firstName: string; lastName: string; slug: string; avatarUrl: string }
> = {
  customer: {
    firstName: 'Marta',
    lastName: 'Silva',
    slug: 'marta',
    avatarUrl: 'https://cdn.example.com/marta.jpg',
  },
  tiago: {
    firstName: 'Tiago',
    lastName: 'Costa',
    slug: 'tiago',
    avatarUrl: 'https://cdn.example.com/tiago.jpg',
  },
  ana: {
    firstName: 'Ana',
    lastName: 'Reis',
    slug: 'ana',
    avatarUrl: 'https://cdn.example.com/ana.jpg',
  },
  rui: {
    firstName: 'Rui',
    lastName: 'Lopes',
    slug: 'rui',
    avatarUrl: 'https://cdn.example.com/rui.jpg',
  },
};

function makeEvent(senderId: string): MessageCreatedEvent {
  const message: MessageView = {
    id: 'message-1',
    conversationId: 'conversation-1',
    senderId,
    senderIdentityId:
      senderId === CUSTOMER_USER_ID ? 'profile-customer' : MAILBOX_IDENTITY_ID,
    body: 'We have a table for you at eight',
    createdAt: new Date(),
    editedAt: null,
    deletedAt: null,
    replyToId: null,
    clientMessageId: null,
    forwarded: false,
    kind: MessageKind.User,
    systemEvent: null,
    attachment: null,
  };
  return {
    conversationId: 'conversation-1',
    message,
    response: {} as MessageCreatedEvent['response'],
  };
}

function build(
  options: {
    claimedByUserId?: string | null;
    isThreadOpened?: boolean;
    /** Pairs blocked either way, as `[blockerId, blockedId]`. */
    blockPairs?: [string, string][];
    /** Task 14: `identity_blocks` rows, as `[blockerUserId, identityId]`. */
    identityBlockPairs?: [string, string][];
    /** Person-level mutes, as `[muterId, mutedId]`. */
    mutePairs?: [string, string][];
    /** Accepted personal connections, either order. */
    connectedPairs?: [string, string][];
    shouldShowStaffNames?: boolean;
    businessAvatarUrl?: string | null;
    /** Extra seats, e.g. a second profile seat that breaks the partition. */
    extraSeats?: { userId: string; identityId: string }[];
    /** Identity ids `getByIds` leaves unresolved. */
    unresolvedIdentityIds?: string[];
  } = {},
) {
  const blockPairs = options.blockPairs ?? [];
  const identityBlockPairs = options.identityBlockPairs ?? [];
  const mutePairs = options.mutePairs ?? [];
  const connectedPairs = options.connectedPairs ?? [];
  const unresolvedIdentityIds = new Set(options.unresolvedIdentityIds ?? []);
  const seats = [
    { userId: CUSTOMER_USER_ID, identityId: 'profile-customer' },
    ...STAFF_USER_IDS.map((userId) => ({
      userId,
      identityId: MAILBOX_IDENTITY_ID,
    })),
    ...(options.extraSeats ?? []),
  ];
  const mailboxIdentity = {
    id: MAILBOX_IDENTITY_ID,
    kind: IdentityKind.Listing,
    shouldShowStaffNames: options.shouldShowStaffNames ?? false,
  };
  const conversationsRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'conversation-1',
      kind: ConversationKind.Direct,
      isOfficial: false,
      title: null,
      claimedByUserId: options.claimedByUserId ?? null,
      openedAt: options.isThreadOpened === false ? null : new Date(),
    }),
  };
  const participantsRepository = {
    find: jest.fn(
      (findOptions: { where?: { userId?: { value?: string[] } } }) => {
        const allowedUserIds = findOptions?.where?.userId?.value;
        return Promise.resolve(
          seats
            .filter(
              (seat) => !allowedUserIds || allowedUserIds.includes(seat.userId),
            )
            .map((seat) => ({
              ...seat,
              leftAt: null,
              muted: false,
              mutedUntil: null,
              muteMode: undefined,
            })),
        );
      },
    ),
  };
  const profilesRepository = {
    findOne: jest.fn((findOptions: { where: { userId: string } }) => {
      const profile = PROFILES[findOptions.where.userId];
      return Promise.resolve(
        profile ? { userId: findOptions.where.userId, ...profile } : null,
      );
    }),
  };
  const identities = {
    getByIds: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        [...new Set(identityIds)]
          .filter((identityId) => !unresolvedIdentityIds.has(identityId))
          .map((identityId) =>
            identityId === MAILBOX_IDENTITY_ID
              ? mailboxIdentity
              : { id: identityId, kind: IdentityKind.Profile },
          ),
      ),
    ),
    getById: jest.fn((identityId: string) =>
      Promise.resolve(
        identityId === MAILBOX_IDENTITY_ID ? mailboxIdentity : null,
      ),
    ),
    describeIdentities: jest.fn(() =>
      Promise.resolve(
        new Map([
          [
            MAILBOX_IDENTITY_ID,
            {
              displayName: BUSINESS_NAME,
              handle: 'casa-lisboa',
              avatarUrl:
                options.businessAvatarUrl === undefined
                  ? BUSINESS_AVATAR_URL
                  : options.businessAvatarUrl,
            },
          ],
        ]),
      ),
    ),
    staffUserIds: jest.fn(() => Promise.resolve(STAFF_USER_IDS)),
  };
  const identityAttribution = new IdentityAttributionService(
    { find: jest.fn().mockResolvedValue([]) } as never,
    identities as never,
  );
  const blockFilter = {
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
    identityBlocksAmong: jest.fn(
      (blockerUserIds: string[], blockedIdentityIds: string[]) =>
        Promise.resolve(
          identityBlockPairs
            .filter(
              ([blockerUserId, identityId]) =>
                blockerUserIds.includes(blockerUserId) &&
                blockedIdentityIds.includes(identityId),
            )
            .map(([blockerUserId, identityId]) => ({
              blockerUserId,
              identityId,
            })),
        ),
    ),
    mutersOf: jest.fn((targetId: string, candidateIds: string[]) =>
      Promise.resolve(
        new Set(
          candidateIds.filter((candidateId) =>
            mutePairs.some(
              ([muterId, mutedId]) =>
                muterId === candidateId && mutedId === targetId,
            ),
          ),
        ),
      ),
    ),
  };
  const connections = {
    areConnected: jest.fn((firstUserId: string, secondUserId: string) =>
      Promise.resolve(
        connectedPairs.some(
          ([left, right]) =>
            (left === firstUserId && right === secondUserId) ||
            (left === secondUserId && right === firstUserId),
        ),
      ),
    ),
  };
  const previewPrivacy = {
    sendSplitByPreviewPreference: jest.fn().mockResolvedValue(undefined),
  };
  const listener = new PushMessageListener(
    conversationsRepository as never,
    participantsRepository as never,
    profilesRepository as never,
    { isOnline: () => false } as never,
    previewPrivacy as never,
    blockFilter as never,
    {
      recipientsPushEnabled: jest.fn((userIds: string[]) =>
        Promise.resolve(userIds),
      ),
    } as never,
    {
      recipientsOutsideQuietHours: jest.fn((userIds: string[]) =>
        Promise.resolve(userIds),
      ),
    } as never,
    connections as never,
    identities as never,
    identityAttribution,
  );
  return { listener, previewPrivacy };
}

/** Every send, flattened to one payload per recipient. */
function payloadByRecipient(previewPrivacy: {
  sendSplitByPreviewPreference: jest.Mock;
}): Map<string, PushPayload> {
  const calls = previewPrivacy.sendSplitByPreviewPreference.mock
    .calls as unknown as [string[], PushPayload][];
  const result = new Map<string, PushPayload>();
  for (const [userIds, payload] of calls) {
    for (const userId of userIds) {
      result.set(userId, payload);
    }
  }
  return result;
}

describe('mailbox push audience is block-aware (Task 13d)', () => {
  it('never pushes a staff member the customer blocked when a colleague replies', async () => {
    const { listener } = build({
      blockPairs: [[CUSTOMER_USER_ID, 'rui']],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'tiago',
    );

    expect(result).toEqual(new Set([CUSTOMER_USER_ID, 'ana']));
  });

  it('never pushes a staff member who blocked the customer when a colleague replies', async () => {
    const { listener } = build({
      blockPairs: [['rui', CUSTOMER_USER_ID]],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'tiago',
    );

    expect(result).toEqual(new Set([CUSTOMER_USER_ID, 'ana']));
  });

  it('pushes only the unblocked colleagues when a customer who blocked one staff member messages the business', async () => {
    const { listener } = build({
      blockPairs: [[CUSTOMER_USER_ID, 'rui']],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set(['tiago', 'ana']));
  });
});

describe('Task 14: a mailbox thread whose customer blocked the business', () => {
  it("pushes a customer's message on the blocked thread to nobody", async () => {
    const { listener } = build({
      identityBlockPairs: [[CUSTOMER_USER_ID, MAILBOX_IDENTITY_ID]],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set());
  });

  it('pushes nothing a staff member sends to the customer, or to a colleague, on the blocked thread', async () => {
    const { listener } = build({
      identityBlockPairs: [[CUSTOMER_USER_ID, MAILBOX_IDENTITY_ID]],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'tiago',
    );

    expect(result).toEqual(new Set());
  });

  it('pushes as before when the customer blocked a different business, and again after the unblock', async () => {
    const otherBusinessBlocked = build({
      identityBlockPairs: [[CUSTOMER_USER_ID, 'identity-other-business']],
    });
    const thisBusinessBlocked = build({
      identityBlockPairs: [[CUSTOMER_USER_ID, MAILBOX_IDENTITY_ID]],
    });
    const unblocked = build({ identityBlockPairs: [] });

    const results = await Promise.all(
      [otherBusinessBlocked, thisBusinessBlocked, unblocked].map(
        ({ listener }) =>
          listener.eligibleMessagePushRecipientUserIds(
            'conversation-1',
            'tiago',
          ),
      ),
    );

    expect(results).toEqual([
      new Set([CUSTOMER_USER_ID, 'ana', 'rui']),
      new Set(),
      new Set([CUSTOMER_USER_ID, 'ana', 'rui']),
    ]);
  });
});

describe('mailbox push person-level gate never keys on the human sender for the customer (Task 13d)', () => {
  it('still pushes the customer a reply from a staff member they muted as a person', async () => {
    const { listener } = build({
      mutePairs: [[CUSTOMER_USER_ID, 'tiago']],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'tiago',
    );

    expect(result).toContain(CUSTOMER_USER_ID);
  });

  it('pushes the customer the same set of replies whichever colleague wrote them', async () => {
    const { listener } = build({
      mutePairs: [[CUSTOMER_USER_ID, 'tiago']],
    });

    const tiagoReply = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'tiago',
    );
    const anaReply = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'ana',
    );

    expect(tiagoReply.has(CUSTOMER_USER_ID)).toBe(
      anaReply.has(CUSTOMER_USER_ID),
    );
  });
});

describe('a colleague reply pushes no seat sharing the sender business identity (CW-27)', () => {
  it('excludes every other staff seat on the business, not only the literal sender', async () => {
    const { listener, previewPrivacy } = build();

    await listener.handleMessageCreated(makeEvent('tiago'));

    const payloads = payloadByRecipient(previewPrivacy);
    expect(payloads.has('ana')).toBe(false);
    expect(payloads.has('rui')).toBe(false);
  });

  it('still pushes the customer for that same reply', async () => {
    const { listener, previewPrivacy } = build();

    await listener.handleMessageCreated(makeEvent('tiago'));

    const payloads = payloadByRecipient(previewPrivacy);
    expect(payloads.has(CUSTOMER_USER_ID)).toBe(true);
  });
});

describe('mailbox thread that cannot be partitioned fails closed (Task 13d)', () => {
  it('pushes nobody when the thread seats two customers', async () => {
    const { listener } = build({
      extraSeats: [{ userId: 'second-customer', identityId: 'profile-second' }],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      'tiago',
    );

    expect(result).toEqual(new Set());
  });

  it('pushes nobody when a seat identity does not resolve', async () => {
    const { listener } = build({
      unresolvedIdentityIds: [MAILBOX_IDENTITY_ID],
    });

    const result = await listener.eligibleMessagePushRecipientUserIds(
      'conversation-1',
      CUSTOMER_USER_ID,
    );

    expect(result).toEqual(new Set());
  });
});

describe('mailbox push content renders the business (Task 13d)', () => {
  it('titles a staff reply to the customer with the business and uses the business avatar, naming no staff member', async () => {
    // Connected as people, so the pre-task path would show full copy.
    const { listener, previewPrivacy } = build({
      connectedPairs: [[CUSTOMER_USER_ID, 'tiago']],
    });

    await listener.handleMessageCreated(makeEvent('tiago'));

    const customerPayload =
      payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(customerPayload?.title).toBe(BUSINESS_NAME);
    expect(customerPayload?.icon).toBe(BUSINESS_AVATAR_URL);
    expect(JSON.stringify(customerPayload)).not.toMatch(/Tiago|Costa/);
  });

  // Task 22: the plain title still names the business alone, so a client
  // with no attribution catalog entry renders exactly today's title. The
  // staff first name now travels separately, in `l10n`, only when both
  // attribution switches allow it. Staff-attribution edge cases (opt-out,
  // the owner switch off, the audience guard) live in
  // `push-listener-staff-attribution.spec.ts`.
  it('keeps the plain title the business name alone and carries the staff first name in l10n when both attribution switches allow it', async () => {
    const { listener, previewPrivacy } = build({
      shouldShowStaffNames: true,
      connectedPairs: [[CUSTOMER_USER_ID, 'tiago']],
    });

    await listener.handleMessageCreated(makeEvent('tiago'));

    const customerPayload =
      payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(customerPayload?.title).toBe(BUSINESS_NAME);
    expect(customerPayload?.l10n?.titleKey).toBe('push:messages.staffTitle');
    expect(customerPayload?.l10n?.params).toMatchObject({
      name: 'Tiago',
      business: BUSINESS_NAME,
    });
  });

  it("titles a colleague's reply with the business name alone for the customer, the only seat still pushed (CW-27: a colleague's seat shares the sender's business identity and is never pushed)", async () => {
    const { listener, previewPrivacy } = build({
      connectedPairs: [
        [CUSTOMER_USER_ID, 'ana'],
        ['rui', 'ana'],
        ['tiago', 'ana'],
      ],
    });

    await listener.handleMessageCreated(makeEvent('ana'));

    const payloads = payloadByRecipient(previewPrivacy);
    expect(payloads.get(CUSTOMER_USER_ID)?.title).toBe(BUSINESS_NAME);
    expect(payloads.get(CUSTOMER_USER_ID)?.icon).toBe(BUSINESS_AVATAR_URL);
    expect(payloads.has('rui')).toBe(false);
    expect(payloads.has('tiago')).toBe(false);
  });

  it('omits the icon when the business avatar is our own auth-gated files URL', async () => {
    const { listener, previewPrivacy } = build({
      connectedPairs: [[CUSTOMER_USER_ID, 'tiago']],
      businessAvatarUrl:
        'https://api.queerpulse.app/files/avatars/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg',
    });

    await listener.handleMessageCreated(makeEvent('tiago'));

    const customerPayload =
      payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(customerPayload?.title).toBe(BUSINESS_NAME);
    expect(customerPayload).not.toHaveProperty('icon');
  });

  it("keeps the customer's own profile name on the customer's message to the claimant", async () => {
    const { listener, previewPrivacy } = build({
      claimedByUserId: 'rui',
      connectedPairs: [[CUSTOMER_USER_ID, 'rui']],
    });

    await listener.handleMessageCreated(makeEvent(CUSTOMER_USER_ID));

    expect(payloadByRecipient(previewPrivacy).get('rui')?.title).toBe(
      'Marta Silva',
    );
  });
});

describe('mailbox push copy follows the business relationship (Task 13d)', () => {
  it('sends the customer full copy for every colleague alike, whatever personal connection they hold to one of them', async () => {
    const tiagoRun = build({
      connectedPairs: [[CUSTOMER_USER_ID, 'tiago']],
    });
    await tiagoRun.listener.handleMessageCreated(makeEvent('tiago'));
    const anaRun = build({
      connectedPairs: [[CUSTOMER_USER_ID, 'tiago']],
    });
    await anaRun.listener.handleMessageCreated(makeEvent('ana'));

    const tiagoPayload = payloadByRecipient(tiagoRun.previewPrivacy).get(
      CUSTOMER_USER_ID,
    );
    const anaPayload = payloadByRecipient(anaRun.previewPrivacy).get(
      CUSTOMER_USER_ID,
    );
    expect(tiagoPayload?.body).toBe('We have a table for you at eight');
    expect(anaPayload?.body).toBe('We have a table for you at eight');
    expect(anaPayload?.title).toBe(tiagoPayload?.title);
  });

  it('sends every recipient the generic copy while the mailbox thread has not opened, even one personally connected to the sender', async () => {
    const { listener, previewPrivacy } = build({
      isThreadOpened: false,
      connectedPairs: [[CUSTOMER_USER_ID, 'tiago']],
    });

    await listener.handleMessageCreated(makeEvent('tiago'));

    const payloads = payloadByRecipient(previewPrivacy);
    expect(payloads.get(CUSTOMER_USER_ID)?.l10n?.titleKey).toBeDefined();
    expect(payloads.get(CUSTOMER_USER_ID)).not.toHaveProperty('icon');
    expect(JSON.stringify(payloads.get(CUSTOMER_USER_ID))).not.toContain(
      BUSINESS_NAME,
    );
  });
});
