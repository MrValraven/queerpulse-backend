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
import { PUSH_MIN_INTERVAL_MS, PushMessageListener } from './push.listener';
import { PushPreviewPrivacyService } from './push-preview-privacy.service';
import { PushPayload } from './push.service';

/**
 * Task 22: a business reply's push names the staff member ("Tiago from Casa
 * Lisboa") in the customer's own payload, through `l10n.titleKey`/`params`,
 * ONLY when both the mailbox owner's switch (`shouldShowStaffNames`) and the
 * staff member's own preference (`identity_staff_preferences.shouldAllowNaming`)
 * allow it. The plain `title` always stays the business name, so a client
 * without the catalog key still shows today's title.
 *
 * Seats: `customer` on its own profile identity, `tiago` (the sender) on the
 * shared mailbox identity `mailbox-identity`. The real
 * `IdentityAttributionService` decides the staff first name, so these cases
 * exercise the same gate the in-app sender uses. Mailbox audience, block and
 * claim behaviour is covered in `push-listener-mailbox.spec.ts` and
 * `push-listener-claim.spec.ts`; this file covers only the attribution
 * decision layered on top of an already-eligible customer push.
 */
const CUSTOMER_USER_ID = 'customer';
const MAILBOX_IDENTITY_ID = 'mailbox-identity';
const BUSINESS_NAME = 'Casa Lisboa';
const BUSINESS_AVATAR_URL = 'https://cdn.example.com/casa-lisboa.jpg';
const SENDER_USER_ID = 'tiago';
const SENDER_FIRST_NAME = 'Tiago';
const STAFF_TITLE_KEY = 'push:messages.staffTitle';

const PROFILES: Record<string, { firstName: string; lastName: string }> = {
  [CUSTOMER_USER_ID]: { firstName: 'Marta', lastName: 'Silva' },
  [SENDER_USER_ID]: { firstName: SENDER_FIRST_NAME, lastName: 'Costa' },
};

beforeAll(() => {
  setImageUrlBase('https://api.queerpulse.app');
});

afterAll(() => {
  resetImageUrlBaseForTesting();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeEvent(overrides: Partial<MessageView> = {}): MessageCreatedEvent {
  const message: MessageView = {
    id: 'message-1',
    conversationId: 'conversation-1',
    senderId: SENDER_USER_ID,
    senderIdentityId: MAILBOX_IDENTITY_ID,
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
    ...overrides,
  };
  return {
    conversationId: message.conversationId,
    message,
    response: {} as MessageCreatedEvent['response'],
  };
}

/** Wraps a resolved value in one extra microtask hop, so a mocked lookup
 *  never resolves synchronously in the same tick it was called. */
function onLaterTick<T>(value: T): Promise<T> {
  return Promise.resolve().then(() => Promise.resolve(value));
}

function build(
  options: {
    shouldShowStaffNames?: boolean;
    isSenderOptedOut?: boolean;
    isThreadOpened?: boolean;
    shouldDelayIdentityResolution?: boolean;
  } = {},
) {
  const seats = [
    { userId: CUSTOMER_USER_ID, identityId: 'profile-customer' },
    { userId: SENDER_USER_ID, identityId: MAILBOX_IDENTITY_ID },
  ];
  const mailboxIdentity = {
    id: MAILBOX_IDENTITY_ID,
    kind: IdentityKind.Listing,
    shouldShowStaffNames: options.shouldShowStaffNames ?? true,
  };
  const conversationsRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'conversation-1',
      kind: ConversationKind.Direct,
      isOfficial: false,
      title: null,
      claimedByUserId: null,
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
  const maybeDelayed = <T>(value: T): Promise<T> =>
    options.shouldDelayIdentityResolution
      ? onLaterTick(value)
      : Promise.resolve(value);
  const identities = {
    getByIds: jest.fn((identityIds: string[]) =>
      maybeDelayed(
        [...new Set(identityIds)].map((identityId) =>
          identityId === MAILBOX_IDENTITY_ID
            ? mailboxIdentity
            : { id: identityId, kind: IdentityKind.Profile },
        ),
      ),
    ),
    getById: jest.fn((identityId: string) =>
      maybeDelayed(identityId === MAILBOX_IDENTITY_ID ? mailboxIdentity : null),
    ),
    describeIdentities: jest.fn(() =>
      maybeDelayed(
        new Map([
          [
            MAILBOX_IDENTITY_ID,
            {
              displayName: BUSINESS_NAME,
              handle: 'casa-lisboa',
              avatarUrl: BUSINESS_AVATAR_URL,
            },
          ],
        ]),
      ),
    ),
    staffUserIds: jest.fn(() => maybeDelayed([SENDER_USER_ID])),
  };
  const preferenceRows = options.isSenderOptedOut
    ? [
        {
          identityId: MAILBOX_IDENTITY_ID,
          userId: SENDER_USER_ID,
          shouldAllowNaming: false,
        },
      ]
    : [];
  const identityAttribution = new IdentityAttributionService(
    { find: jest.fn(() => maybeDelayed(preferenceRows)) } as never,
    identities as never,
  );
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    mutersOf: jest.fn().mockResolvedValue(new Set<string>()),
    identityBlocksAmong: jest.fn().mockResolvedValue([]),
  };
  const connections = {
    areConnected: jest.fn().mockResolvedValue(true),
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

/** Builds a listener wired to the REAL `PushPreviewPrivacyService`, so the
 *  redacted, hidden-preview payload it produces for a recipient is
 *  inspected directly. `memberPreferencesRows` empty means every recipient
 *  fails closed to hidden (`DEFAULT_HIDE_PUSH_PREVIEWS`). */
function buildWithRealPreviewPrivacy(
  memberPreferencesRows: { userId: string; hidePushPreviews: boolean }[] = [],
) {
  const seats = [
    { userId: CUSTOMER_USER_ID, identityId: 'profile-customer' },
    { userId: SENDER_USER_ID, identityId: MAILBOX_IDENTITY_ID },
  ];
  const mailboxIdentity = {
    id: MAILBOX_IDENTITY_ID,
    kind: IdentityKind.Listing,
    shouldShowStaffNames: true,
  };
  const conversationsRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: 'conversation-1',
      kind: ConversationKind.Direct,
      isOfficial: false,
      title: null,
      claimedByUserId: null,
      openedAt: new Date(),
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
        [...new Set(identityIds)].map((identityId) =>
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
              avatarUrl: BUSINESS_AVATAR_URL,
            },
          ],
        ]),
      ),
    ),
    staffUserIds: jest.fn(() => Promise.resolve([SENDER_USER_ID])),
  };
  const identityAttribution = new IdentityAttributionService(
    { find: jest.fn().mockResolvedValue([]) } as never,
    identities as never,
  );
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    mutersOf: jest.fn().mockResolvedValue(new Set<string>()),
    identityBlocksAmong: jest.fn().mockResolvedValue([]),
  };
  const connections = { areConnected: jest.fn().mockResolvedValue(true) };
  const pushService = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
  const memberPreferences = {
    find: jest.fn().mockResolvedValue(memberPreferencesRows),
  };
  const previewPrivacy = new PushPreviewPrivacyService(
    memberPreferences as never,
    pushService as never,
  );
  const listener = new PushMessageListener(
    conversationsRepository as never,
    participantsRepository as never,
    profilesRepository as never,
    { isOnline: () => false } as never,
    previewPrivacy,
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
  return { listener, pushService };
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

/** The private audience shape `resolveMessagePushRecipients` returns, typed
 *  here only so test 4 can spy on the private method without a cast to
 *  `any`. */
interface AudienceResolvingListener {
  resolveMessagePushRecipients(
    conversationId: string,
    senderId: string,
    candidateUserIds?: string[],
    senderIdentityId?: string | null,
  ): Promise<{
    recipientUserIds: Set<string>;
    mailbox?: { mailboxIdentityId: string; customerUserId: string };
  }>;
}

describe('Task 22: staff attribution switch gate', () => {
  it('names the staff member in l10n, business name in title, when the owner switch is on and the sender has not opted out', async () => {
    const { listener, previewPrivacy } = build();

    await listener.handleMessageCreated(makeEvent());

    const payload = payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(payload?.title).toBe(BUSINESS_NAME);
    expect(payload?.l10n?.titleKey).toBe(STAFF_TITLE_KEY);
    expect(payload?.l10n?.params).toEqual({
      name: SENDER_FIRST_NAME,
      business: BUSINESS_NAME,
    });
  });

  it('carries no titleKey and no name when the owner switch is off', async () => {
    const { listener, previewPrivacy } = build({ shouldShowStaffNames: false });

    await listener.handleMessageCreated(makeEvent());

    const payload = payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(payload?.title).toBe(BUSINESS_NAME);
    expect(payload).not.toHaveProperty('l10n');
    expect(JSON.stringify(payload)).not.toContain(SENDER_FIRST_NAME);
  });

  it('carries no titleKey and no name when the sender opted out of naming', async () => {
    const { listener, previewPrivacy } = build({ isSenderOptedOut: true });

    await listener.handleMessageCreated(makeEvent());

    const payload = payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(payload?.title).toBe(BUSINESS_NAME);
    expect(payload).not.toHaveProperty('l10n');
    expect(JSON.stringify(payload)).not.toContain(SENDER_FIRST_NAME);
  });
});

describe('Task 22: the audience guard never hands attribution to a reader beyond the customer', () => {
  it('carries no titleKey and no name when the push audience unexpectedly includes a staff seat beside the customer', async () => {
    const { listener, previewPrivacy } = build();
    const audienceListener = listener as unknown as AudienceResolvingListener;
    const originalResolve =
      audienceListener.resolveMessagePushRecipients.bind(audienceListener);
    jest
      .spyOn(audienceListener, 'resolveMessagePushRecipients')
      .mockImplementation(async (...args) => {
        const [conversationId, senderId, candidateUserIds, senderIdentityId] =
          args as [
            string,
            string,
            string[] | undefined,
            string | null | undefined,
          ];
        const result = await originalResolve(
          conversationId,
          senderId,
          candidateUserIds,
          senderIdentityId,
        );
        return {
          ...result,
          recipientUserIds: new Set([
            ...result.recipientUserIds,
            'other-staff-member',
          ]),
        };
      });

    await listener.handleMessageCreated(makeEvent());

    const payload = payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(payload).not.toHaveProperty('l10n');
    expect(JSON.stringify(payload)).not.toContain(SENDER_FIRST_NAME);
  });
});

describe('Task 22: no name reaches a payload the customer never gets to see', () => {
  it('carries no name anywhere in the stranger copy while the mailbox thread has not opened', async () => {
    const { listener, previewPrivacy } = build({ isThreadOpened: false });

    await listener.handleMessageCreated(makeEvent());

    const payload = payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(JSON.stringify(payload)).not.toContain(SENDER_FIRST_NAME);
  });

  it('carries no name anywhere in the redacted copy for a recipient hiding lock-screen previews', async () => {
    const { listener, pushService } = buildWithRealPreviewPrivacy([]);

    await listener.handleMessageCreated(makeEvent());

    const calls = pushService.sendToUsers.mock.calls as unknown as [
      string[],
      PushPayload,
    ][];
    const hiddenCall = calls.find(([userIds]) =>
      userIds.includes(CUSTOMER_USER_ID),
    );
    expect(hiddenCall).toBeDefined();
    const [, payload] = hiddenCall as [string[], PushPayload];
    expect(JSON.stringify(payload)).not.toContain(SENDER_FIRST_NAME);
  });
});

describe('Task 22: an image reply keeps its bodyKey and gains the title key', () => {
  it('merges titleKey/params in with bodyKey, keeping bodyKey', async () => {
    const { listener, previewPrivacy } = build();

    await listener.handleMessageCreated(
      makeEvent({
        kind: MessageKind.Image,
        body: 'Foto',
        attachment: {
          url: 'https://cdn.example.com/photo.jpg',
          previewUrl: 'https://cdn.example.com/photo-preview.jpg',
          width: 800,
          height: 600,
          provider: 'upload',
        },
      }),
    );

    const payload = payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(payload?.l10n?.bodyKey).toBe('push:messages.attachment.photo');
    expect(payload?.l10n?.titleKey).toBe(STAFF_TITLE_KEY);
    expect(payload?.l10n?.params).toEqual({
      name: SENDER_FIRST_NAME,
      business: BUSINESS_NAME,
    });
  });
});

describe('Task 22: pacing still reserves before any await, even with a slow attribution resolver', () => {
  const START_MS = 1_800_000_000_000;

  it('suppresses a second reply inside the minimum interval although the attribution lookups settle on a later tick', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
    const { listener, previewPrivacy } = build({
      shouldDelayIdentityResolution: true,
    });

    await listener.handleMessageCreated(makeEvent({ id: 'message-1' }));
    nowSpy.mockReturnValue(START_MS + PUSH_MIN_INTERVAL_MS - 1);
    await listener.handleMessageCreated(makeEvent({ id: 'message-2' }));

    expect(previewPrivacy.sendSplitByPreviewPreference).toHaveBeenCalledTimes(
      1,
    );
    const payload = payloadByRecipient(previewPrivacy).get(CUSTOMER_USER_ID);
    expect(payload?.l10n?.titleKey).toBe(STAFF_TITLE_KEY);
  });
});
