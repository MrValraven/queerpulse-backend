import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { IdentityKind } from '../identities/entities/identity.entity';
import { ConversationMuteMode } from '../messaging/entities/conversation-participant.entity';
import { ConversationKind } from '../messaging/entities/conversation.entity';
import { MessageKind } from '../messaging/entities/message.entity';
import { MessageCreatedEvent } from '../messaging/messaging.events';
import { MessageView } from '../messaging/message-response';
import {
  PUSH_MIN_INTERVAL_MS,
  PUSH_QUIET_REPEAT_WINDOW_MS,
  PushMessageListener,
} from './push.listener';
import { PushPayload } from './push.service';

// The listener resolves the sender's display name via `requireAuthorSummary`,
// which runs every avatar through `toImageUrl`. A storage-key avatar needs the
// module-level API base URL (normally set once at bootstrap by `CommonModule`)
// or `toImageUrl` throws — the same wiring the real app has. Set it here so the
// storage-key case exercises the listener's icon logic instead of failing to
// resolve the sender name.
beforeAll(() => {
  setImageUrlBase('https://api.queerpulse.app');
});

afterAll(() => {
  resetImageUrlBaseForTesting();
});

// The pacing cases pin `Date.now`; never let one leak into the next test.
afterEach(() => {
  jest.restoreAllMocks();
});

function makeEvent(overrides: Partial<MessageView> = {}): MessageCreatedEvent {
  const message: MessageView = {
    id: 'm1',
    conversationId: 'conv-1',
    senderId: 'sender-1',
    // Task 11: unused by this listener, which never reads identity
    // attribution, present only so `MessageView`'s shape is satisfied.
    senderIdentityId: 'sender-identity-1',
    body: 'hey there',
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
    conversationId: 'conv-1',
    message,
    // The push listener only reads `message`, but MessageCreatedEvent now also
    // carries the hydrated frontend-contract `response` the gateway relays as
    // `message:new`. Supply a consistent one so the fixture matches the current
    // event contract.
    response: {
      id: message.id,
      conversationId: message.conversationId,
      body: message.body,
      sender: {
        handle: 'alex',
        displayName: 'Alex Doe',
        pronouns: null,
        avatarUrl: null,
      },
      createdAt: message.createdAt.toISOString(),
      editedAt: null,
      reactions: [],
      deletedAt: null,
      deliveredAt: null,
      clientMessageId: null,
      forwarded: false,
      pinnedAt: null,
      starred: false,
      canPin: true,
      canEdit: false,
      canDelete: false,
      canReport: false,
      replyTo: null,
      kind: 'user',
      systemEvent: null,
      attachment: null,
    },
  };
}

function build(opts: {
  participants: {
    userId: string;
    muted: boolean;
    mutedUntil?: Date | null;
    muteMode?: ConversationMuteMode;
  }[];
  online: string[];
  isOfficial?: boolean;
  blocked?: string[];
  muters?: string[];
  pushDisabled?: string[];
  // Recipients currently inside their quiet-hours window (empty = nobody).
  quietUserIds?: string[];
  // Raw stored avatar for the sender's profile (undefined = no avatar). An
  // absolute https URL is a public avatar; a storage key resolves to our
  // auth-gated `/files/*` route and must NOT become the push icon.
  senderAvatarUrl?: string;
  // Conversation shape (PRD-333). Defaults to a 1:1 DM.
  conversationKind?: ConversationKind;
  groupTitle?: string | null;
  // ENG-232: whether sender and recipient are accepted connections. Defaults
  // to connected, so the rich-payload cases above measure only what they mean.
  isConnected?: boolean;
  hasConnectionLookupFailure?: boolean;
  // PRD-336: member slug -> userId, for resolving an `@slug` mention in the
  // message body via `MemberLookup` (empty = no mention resolves to anyone,
  // which is what every non-mention test above relies on).
  mentionSlugUserIds?: Record<string, string>;
}) {
  const conversationKind = opts.conversationKind ?? ConversationKind.Direct;
  const conversationsRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: 'conv-1',
      isOfficial: opts.isOfficial ?? false,
      kind: conversationKind,
      title:
        conversationKind === ConversationKind.Group
          ? (opts.groupTitle ?? null)
          : null,
      pairKey:
        opts.isOfficial || conversationKind === ConversationKind.Group
          ? null
          : 'sender-1:recipient-1',
    }),
  };
  const connections = {
    areConnected: jest
      .fn()
      .mockImplementation(() =>
        opts.hasConnectionLookupFailure
          ? Promise.reject(new Error('connections lookup failed'))
          : Promise.resolve(opts.isConnected ?? true),
      ),
  };
  // Two different shapes call `find` here: `eligibleMessagePushRecipientUserIds`
  // (no `userId` filter, unless a caller narrows it) and, for a group,
  // `groupMentionedParticipantUserIds` (always filtered to a specific
  // `userId: In([...])`). Filtering by that when present keeps the two calls
  // from bleeding into each other, the same way the real repository would.
  const participantsRepo = {
    find: jest
      .fn()
      .mockImplementation(
        (options: { where?: { userId?: { value?: string[] } } }) => {
          const allowedUserIds = options?.where?.userId?.value;
          const rows = allowedUserIds
            ? opts.participants.filter((participant) =>
                allowedUserIds.includes(participant.userId),
              )
            : opts.participants;
          // Task 13d: every seat carries its own profile identity, so each
          // thread here reads as personal (`identities.getByIds` below).
          return Promise.resolve(
            rows.map((participant) => ({
              identityId: `profile-identity-${participant.userId}`,
              ...participant,
            })),
          );
        },
      ),
  };
  // `MemberLookup.userIdsForSlugs` (PRD-336's `@`-mention resolution) goes
  // through `createQueryBuilder().innerJoin().where().getMany()` rather than
  // a plain `find`, so it needs its own chainable stub. Only ever invoked
  // when a test's message body actually contains an `@slug` token.
  const mentionRows = Object.entries(opts.mentionSlugUserIds ?? {}).map(
    ([slug, userId]) => ({ slug, userId }),
  );
  const profilesRepo = {
    findOne: jest.fn().mockResolvedValue({
      userId: 'sender-1',
      firstName: 'Alex',
      lastName: 'Doe',
      slug: 'alex',
      avatarUrl: opts.senderAvatarUrl ?? null,
    }),
    createQueryBuilder: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(mentionRows),
    }),
  };
  const presence = {
    isOnline: (userId: string) => opts.online.includes(userId),
  };
  // Doubles as the `PushPreviewPrivacyService` the listener now sends through
  // (ID-13). `sendSplitByPreviewPreference` delegates straight to
  // `sendToUsers`, which is the real service's behaviour for a recipient who
  // has previews SHOWN, the case every assertion below is about, since they
  // all check the rich sender-name payload. The split itself, and what the
  // hidden-preview half receives, is covered in
  // `push-preview-privacy.service.spec.ts`.
  const push = {
    sendToUsers: jest.fn().mockResolvedValue(undefined),
    sendSplitByPreviewPreference: jest.fn(),
  };
  push.sendSplitByPreviewPreference.mockImplementation(
    (userIds: string[], payload: unknown): Promise<void> => {
      push.sendToUsers(userIds, payload);
      return Promise.resolve();
    },
  );
  const blockFilter = {
    blockedUserIds: jest
      .fn()
      .mockResolvedValue(new Set<string>(opts.blocked ?? [])),
    mutersOf: jest.fn().mockResolvedValue(new Set<string>(opts.muters ?? [])),
  };
  // Default: everyone still wants the "New message" push (no stored override) —
  // echo the input userIds back, unless a test disables specific recipients.
  const notificationPreferences = {
    recipientsPushEnabled: jest
      .fn()
      .mockImplementation((userIds: string[]) =>
        Promise.resolve(
          userIds.filter(
            (userId) => !(opts.pushDisabled ?? []).includes(userId),
          ),
        ),
      ),
  };
  // Quiet hours: by default nobody is inside a window, so every recipient
  // stays audible and these tests measure only what they mean to measure.
  const notificationDelivery = {
    recipientsOutsideQuietHours: jest
      .fn()
      .mockImplementation((userIds: string[]) =>
        Promise.resolve(
          userIds.filter(
            (userId) => !(opts.quietUserIds ?? []).includes(userId),
          ),
        ),
      ),
  };
  // Task 13d: every identity a seat names resolves as a profile identity, so
  // no thread in this file is a business mailbox. The mailbox cases live in
  // `push-listener-mailbox.spec.ts`.
  const identities = {
    getByIds: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        identityIds.map((identityId) => ({
          id: identityId,
          kind: IdentityKind.Profile,
        })),
      ),
    ),
    describeIdentities: jest.fn().mockResolvedValue(new Map()),
  };
  const identityAttribution = {
    buildStaffNameResolver: jest.fn(),
  };
  const listener = new PushMessageListener(
    conversationsRepo as never,
    participantsRepo as never,
    profilesRepo as never,
    presence as never,
    push as never,
    blockFilter as never,
    notificationPreferences as never,
    notificationDelivery as never,
    connections as never,
    identities as never,
    identityAttribution as never,
  );
  return {
    listener,
    push,
    participantsRepo,
    conversationsRepo,
    blockFilter,
    notificationPreferences,
    connections,
  };
}

const DIRECT_PARTICIPANTS = [
  { userId: 'sender-1', muted: false },
  { userId: 'recipient-1', muted: false },
];

const GROUP_PARTICIPANTS = [
  { userId: 'sender-1', muted: false },
  { userId: 'recipient-1', muted: false },
  { userId: 'recipient-2', muted: false },
];

/** The `callIndex`-th `sendToUsers` call, failing loudly when it never happened. */
function sentCall(
  push: { sendToUsers: jest.Mock },
  callIndex: number,
): { userIds: string[]; payload: PushPayload } {
  const calls: unknown[] = push.sendToUsers.mock.calls;
  const call = calls[callIndex] as [string[], PushPayload] | undefined;
  if (!call) throw new Error(`sendToUsers call ${callIndex} never happened`);
  return { userIds: call[0], payload: call[1] };
}

function sentPayload(
  push: { sendToUsers: jest.Mock },
  callIndex: number,
): PushPayload {
  return sentCall(push, callIndex).payload;
}

it('pushes to an offline recipient with the sender name + preview', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
  });
  await listener.handleMessageCreated(makeEvent());
  // One batched call carrying every deliverable recipient — not one call per
  // recipient — since `sendToUsers` resolves every subscription in a single
  // `IN (...)` query instead of one `find` per recipient.
  expect(push.sendToUsers).toHaveBeenCalledTimes(1);
  const [userIds, payload] = push.sendToUsers.mock.calls[0] as [
    string[],
    PushPayload,
  ];
  expect(userIds).toEqual(['recipient-1']);
  expect(payload.title).toBe('Alex Doe');
  expect(payload.body).toBe('hey there');
  expect(payload.data.url).toBe('/messages?c=conv-1');
});

it("sets timestamp to the message's own createdAt (not delivery time)", async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
  });
  const createdAt = new Date('2026-01-15T12:00:00.000Z');
  await listener.handleMessageCreated(makeEvent({ createdAt }));
  const [, payload] = push.sendToUsers.mock.calls[0] as [string[], PushPayload];
  expect(payload.timestamp).toBe(createdAt.getTime());
});

it('skips a recipient who is online', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: ['recipient-1'],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(push.sendToUsers).not.toHaveBeenCalled();
});

it('never pushes to the sender', async () => {
  const { listener, push } = build({
    participants: [{ userId: 'sender-1', muted: false }],
    online: [],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(push.sendToUsers).not.toHaveBeenCalled();
});

it('excludes a participant with an indefinite mute (PRD-349)', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: true, mutedUntil: null },
    ],
    online: [],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(push.sendToUsers).not.toHaveBeenCalled();
});

it('excludes a participant whose timed mute has not expired yet (PRD-349)', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      {
        userId: 'recipient-1',
        muted: true,
        mutedUntil: new Date(Date.now() + 60_000),
      },
    ],
    online: [],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(push.sendToUsers).not.toHaveBeenCalled();
});

it('pushes to a participant whose timed mute already expired (PRD-349)', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      {
        userId: 'recipient-1',
        muted: true,
        mutedUntil: new Date(Date.now() - 60_000),
      },
    ],
    online: [],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(push.sendToUsers).toHaveBeenCalledTimes(1);
  const [userIds] = push.sendToUsers.mock.calls[0] as [string[], PushPayload];
  expect(userIds).toEqual(['recipient-1']);
});

it('pushes to an unmuted participant', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(push.sendToUsers).toHaveBeenCalledTimes(1);
  const [userIds] = push.sendToUsers.mock.calls[0] as [string[], PushPayload];
  expect(userIds).toEqual(['recipient-1']);
});

it('never pushes to a recipient blocked either way relative to the sender (P0)', async () => {
  const { listener, push, blockFilter } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
    blocked: ['recipient-1'],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('sender-1', [
    'recipient-1',
  ]);
  expect(push.sendToUsers).not.toHaveBeenCalled();
});

it('never pushes to a recipient who muted the sender at the person level (P1-3)', async () => {
  const { listener, push, blockFilter } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
    muters: ['recipient-1'],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(blockFilter.mutersOf).toHaveBeenCalledWith('sender-1', [
    'recipient-1',
  ]);
  expect(push.sendToUsers).not.toHaveBeenCalled();
});

it('never pushes to a recipient who turned the New message push category off', async () => {
  const { listener, push, notificationPreferences } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
    pushDisabled: ['recipient-1'],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledWith(
    ['recipient-1'],
    'new_messages',
  );
  expect(push.sendToUsers).not.toHaveBeenCalled();
});

it('sends a rich DM push: avatar icon, view action, renotify, vibrate', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
    // An absolute public https avatar (e.g. a Google-OAuth avatar) — fetchable
    // by a push client, so it becomes the notification icon.
    senderAvatarUrl: 'https://lh3.googleusercontent.com/a/alex.png',
  });
  await listener.handleMessageCreated(makeEvent());
  const [, payload] = push.sendToUsers.mock.calls[0] as [string[], PushPayload];
  expect(payload).toMatchObject({
    title: 'Alex Doe',
    icon: 'https://lh3.googleusercontent.com/a/alex.png',
    actions: [{ action: 'view', title: 'View' }],
    renotify: true,
    vibrate: [80, 40, 80],
    data: { conversationId: 'conv-1', url: '/messages?c=conv-1' },
  });
  expect(payload.icon).toMatch(/^https:\/\//);
});

it('omits icon when the sender has no avatar', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
    // No avatar stored — nothing safe to show, so `icon` must be absent entirely
    // (not present-and-undefined), while the other rich fields still ship.
  });
  await listener.handleMessageCreated(makeEvent());
  const [, payload] = push.sendToUsers.mock.calls[0] as [string[], PushPayload];
  expect(payload).not.toHaveProperty('icon');
  expect(payload.actions).toEqual([{ action: 'view', title: 'View' }]);
});

it('omits icon for a storage-key avatar (our /files/* route, not a direct public URL)', async () => {
  const { listener, push } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
    // A storage key resolves through `toImageUrl` to our own `GET /files/*`
    // redirect route, not a direct absolute-https asset — we send only the
    // latter, so a storage-key avatar must never become the icon.
    senderAvatarUrl:
      'avatars/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg',
  });
  await listener.handleMessageCreated(makeEvent());
  const [, payload] = push.sendToUsers.mock.calls[0] as [string[], PushPayload];
  expect(payload).not.toHaveProperty('icon');
});

it('never pushes for an official (non-DM) conversation', async () => {
  const { listener, push, participantsRepo } = build({
    participants: [
      { userId: 'sender-1', muted: false },
      { userId: 'recipient-1', muted: false },
    ],
    online: [],
    isOfficial: true,
  });
  await listener.handleMessageCreated(makeEvent());
  expect(push.sendToUsers).not.toHaveBeenCalled();
  // Bails before the participant query — no unnecessary work for group threads.
  expect(participantsRepo.find).not.toHaveBeenCalled();
});

describe('group message shape (PRD-333)', () => {
  it('titles the push with the group and prefixes the body with the sender', async () => {
    const { listener, push } = build({
      participants: GROUP_PARTICIPANTS,
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
    });
    await listener.handleMessageCreated(
      makeEvent({ body: 'the terrace is booked' }),
    );
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const [userIds, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(userIds).toEqual(['recipient-1', 'recipient-2']);
    expect(payload.title).toBe('Terrace crew');
    expect(payload.body).toBe('Alex Doe: the terrace is booked');
    expect(payload.data).toEqual({
      conversationId: 'conv-1',
      url: '/messages?c=conv-1',
      isGroup: true,
    });
    expect(payload).not.toHaveProperty('l10n');
  });

  it('falls back to the DM shape, without isGroup, for a group with a blank title', async () => {
    const { listener, push, connections } = build({
      participants: GROUP_PARTICIPANTS,
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: '   ',
    });
    await listener.handleMessageCreated(makeEvent());
    const payload = sentPayload(push, 0);
    expect(payload.title).toBe('Alex Doe');
    expect(payload.body).toBe('hey there');
    expect(payload.data).not.toHaveProperty('isGroup');
    // A group is never subject to the stranger rule (ENG-232).
    expect(connections.areConnected).not.toHaveBeenCalled();
  });

  it('never sets isGroup on a DM push', async () => {
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    await listener.handleMessageCreated(makeEvent());
    const payload = sentPayload(push, 0);
    expect(payload.data).not.toHaveProperty('isGroup');
  });
});

describe('participant column selection (ENG-239)', () => {
  it('selects only userId, identityId, leftAt, muted, mutedUntil and muteMode off the participants query', async () => {
    const { listener, participantsRepo } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    await listener.handleMessageCreated(makeEvent());
    expect(participantsRepo.find).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1' },
      select: {
        userId: true,
        // Task 13d: the seat identity tells a mailbox thread apart.
        identityId: true,
        leftAt: true,
        muted: true,
        mutedUntil: true,
        muteMode: true,
      },
    });
  });
});

describe('mentions-only mute (PRD-349)', () => {
  it('excludes a mentions-only participant from a PLAIN message push', async () => {
    const { listener, push } = build({
      participants: [
        { userId: 'sender-1', muted: false },
        {
          userId: 'recipient-1',
          muted: false,
          muteMode: ConversationMuteMode.MentionsOnly,
        },
      ],
      online: [],
    });
    await listener.handleMessageCreated(makeEvent());
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it('excludes a mentions-only participant even when muted is also false and mutedUntil is in the past', async () => {
    // muteMode wins independent of the ordinary muted/mutedUntil ladder, per
    // ConversationParticipant.muteMode's own doc.
    const { listener, push } = build({
      participants: [
        { userId: 'sender-1', muted: false },
        {
          userId: 'recipient-1',
          muted: false,
          mutedUntil: new Date(Date.now() - 60_000),
          muteMode: ConversationMuteMode.MentionsOnly,
        },
      ],
      online: [],
    });
    await listener.handleMessageCreated(makeEvent());
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it('eligibleMessagePushRecipientUserIds excludes a mentions-only participant unconditionally', async () => {
    const { listener } = build({
      participants: [
        { userId: 'sender-1', muted: false },
        {
          userId: 'recipient-1',
          muted: false,
          muteMode: ConversationMuteMode.MentionsOnly,
        },
      ],
      online: [],
    });
    const eligible = await listener.eligibleMessagePushRecipientUserIds(
      'conv-1',
      'sender-1',
    );
    expect(eligible).toEqual(new Set());
  });

  it('never sends a mentions-only GROUP member the plain OR the merged mention push, even when the message mentions them: they fall through to the standalone mention push path instead (PushNotificationListener.pushMention, which asks eligibleMessagePushRecipientUserIds the identical question and finds them uncovered, verified by the two assertions above)', async () => {
    const { listener, push } = build({
      participants: [
        { userId: 'sender-1', muted: false },
        {
          userId: 'recipient-1',
          muted: false,
          muteMode: ConversationMuteMode.MentionsOnly,
        },
        { userId: 'recipient-2', muted: false },
      ],
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
      mentionSlugUserIds: { ana: 'recipient-1' },
    });
    await listener.handleMessageCreated(
      makeEvent({ body: '@ana are we still on for Saturday?' }),
    );
    // Only recipient-2 (the ordinary group copy) is sent FROM THIS LISTENER.
    // recipient-1 gets zero pushes here, proving no double-send from this
    // listener's own merge, and is left for `pushMention`'s standalone send.
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const [userIds, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(userIds).toEqual(['recipient-2']);
    expect(payload).not.toHaveProperty('l10n');
  });
});

describe('attachment copy (ENG-227)', () => {
  it("ignores the sender's placeholder body and sends kind copy for an uncaptioned DM photo", async () => {
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    await listener.handleMessageCreated(
      makeEvent({
        kind: MessageKind.Image,
        // A PT sender's client placeholder: must never reach the lock screen.
        body: 'Foto',
        attachment: {
          url: 'message-images/sender-1/photo.jpg',
          previewUrl: 'message-images/sender-1/photo.jpg',
          width: 800,
          height: 600,
          provider: 'upload',
        },
      }),
    );
    const payload = sentPayload(push, 0);
    expect(payload.title).toBe('Alex Doe');
    expect(payload.body).toBe('Photo');
    expect(payload.l10n).toEqual({
      bodyKey: 'push:messages.attachment.photo',
    });
  });

  it('treats a whitespace-only caption as no caption', async () => {
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    await listener.handleMessageCreated(
      makeEvent({
        kind: MessageKind.Document,
        body: 'Ficheiro',
        attachment: {
          url: 'message-documents/sender-1/lease.pdf',
          fileName: 'lease.pdf',
          byteSize: 1_000,
          contentType: 'application/pdf',
          provider: 'upload',
          caption: '   ',
        },
      }),
    );
    const payload = sentPayload(push, 0);
    expect(payload.body).toBe('Document');
    expect(payload.l10n).toEqual({
      bodyKey: 'push:messages.attachment.document',
    });
  });

  it('sends group kind copy with the sender name as a param for an uncaptioned group GIF', async () => {
    const { listener, push } = build({
      participants: GROUP_PARTICIPANTS,
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
    });
    await listener.handleMessageCreated(
      makeEvent({
        kind: MessageKind.Gif,
        body: 'GIF',
        attachment: {
          url: 'https://static.klipy.com/wave.gif',
          previewUrl: 'https://static.klipy.com/wave-small.gif',
          width: 320,
          height: 240,
          provider: 'klipy',
        },
      }),
    );
    const payload = sentPayload(push, 0);
    expect(payload.title).toBe('Terrace crew');
    expect(payload.body).toBe('Alex Doe: GIF');
    expect(payload.l10n).toEqual({
      bodyKey: 'push:messages.group.attachment.gif',
      params: { name: 'Alex Doe' },
    });
    expect(payload.data.isGroup).toBe(true);
  });

  it('previews the caption, without kind copy, when the member typed one', async () => {
    const { listener, push } = build({
      participants: GROUP_PARTICIPANTS,
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
    });
    await listener.handleMessageCreated(
      makeEvent({
        kind: MessageKind.Document,
        body: 'Ficheiro',
        attachment: {
          url: 'message-documents/sender-1/lease.pdf',
          fileName: 'lease.pdf',
          byteSize: 1_000,
          contentType: 'application/pdf',
          provider: 'upload',
          caption: '  lease for the flat  ',
        },
      }),
    );
    const payload = sentPayload(push, 0);
    expect(payload.body).toBe('Alex Doe: lease for the flat');
    expect(payload).not.toHaveProperty('l10n');
  });
});

describe('per-recipient push pacing (ENG-230)', () => {
  const START_MS = 1_800_000_000_000;

  it('suppresses a second push inside the minimum interval', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    await listener.handleMessageCreated(makeEvent());
    nowSpy.mockReturnValue(START_MS + PUSH_MIN_INTERVAL_MS - 1);
    await listener.handleMessageCreated(makeEvent({ id: 'm2' }));
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
  });

  it('sends a quiet repeat (renotify false, no vibrate) inside the repeat window', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    await listener.handleMessageCreated(makeEvent());
    nowSpy.mockReturnValue(START_MS + PUSH_MIN_INTERVAL_MS);
    await listener.handleMessageCreated(makeEvent({ id: 'm2' }));
    const firstPayload = sentPayload(push, 0);
    const secondPayload = sentPayload(push, 1);
    expect(firstPayload.renotify).toBe(true);
    expect(firstPayload.vibrate).toEqual([80, 40, 80]);
    expect(secondPayload.renotify).toBe(false);
    expect(secondPayload).not.toHaveProperty('vibrate');
  });

  it('buzzes again once the repeat window has passed', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    await listener.handleMessageCreated(makeEvent());
    nowSpy.mockReturnValue(START_MS + PUSH_QUIET_REPEAT_WINDOW_MS);
    await listener.handleMessageCreated(makeEvent({ id: 'm2' }));
    const secondPayload = sentPayload(push, 1);
    expect(secondPayload.renotify).toBe(true);
    expect(secondPayload.vibrate).toEqual([80, 40, 80]);
  });

  it('paces each conversation separately', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(START_MS);
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    await listener.handleMessageCreated(makeEvent());
    await listener.handleMessageCreated({
      ...makeEvent({ id: 'm2', conversationId: 'conv-2' }),
      conversationId: 'conv-2',
    });
    expect(push.sendToUsers).toHaveBeenCalledTimes(2);
    const secondPayload = sentPayload(push, 1);
    expect(secondPayload.tag).toBe('conv-2');
    expect(secondPayload.renotify).toBe(true);
  });

  it('splits a group into a fresh batch and a quiet batch, sent one after the other', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
    // recipient-2 is online for the first message, so only recipient-1 is
    // pushed and paced; both are offline for the second.
    const online = ['recipient-2'];
    const { listener, push } = build({
      participants: GROUP_PARTICIPANTS,
      online,
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
    });
    await listener.handleMessageCreated(makeEvent());
    online.length = 0;
    nowSpy.mockReturnValue(START_MS + 10_000);
    await listener.handleMessageCreated(makeEvent({ id: 'm2' }));

    expect(push.sendSplitByPreviewPreference).toHaveBeenCalledTimes(3);
    const freshCall = sentCall(push, 1);
    const quietCall = sentCall(push, 2);
    expect(freshCall.userIds).toEqual(['recipient-2']);
    expect(freshCall.payload.renotify).toBe(true);
    expect(quietCall.userIds).toEqual(['recipient-1']);
    expect(quietCall.payload.renotify).toBe(false);
    expect(quietCall.payload).not.toHaveProperty('vibrate');
  });

  it('releases the reservation when a send fails, so the next message still buzzes', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(START_MS);
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
    });
    push.sendSplitByPreviewPreference.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      listener.handleMessageCreated(makeEvent()),
    ).resolves.toBeUndefined();
    nowSpy.mockReturnValue(START_MS + 1_000);
    await listener.handleMessageCreated(makeEvent({ id: 'm2' }));
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const payload = sentPayload(push, 0);
    expect(payload.renotify).toBe(true);
    expect(payload.vibrate).toEqual([80, 40, 80]);
  });
});

describe('cold DM from a non-connection (ENG-232)', () => {
  it('sends the generic message copy with no icon, actions or params', async () => {
    const { listener, push, connections } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
      isConnected: false,
      senderAvatarUrl: 'https://lh3.googleusercontent.com/a/alex.png',
    });
    await listener.handleMessageCreated(makeEvent());
    expect(connections.areConnected).toHaveBeenCalledWith(
      'sender-1',
      'recipient-1',
    );
    const payload = sentPayload(push, 0);
    expect(payload.title).toBe('QueerPulse');
    expect(payload.body).toBe('You have a new message.');
    expect(payload.l10n).toEqual({
      titleKey: 'push:preview.hidden.title',
      bodyKey: 'push:preview.hidden.message',
    });
    expect(payload).not.toHaveProperty('icon');
    expect(payload).not.toHaveProperty('actions');
    expect(payload.data).toEqual({
      conversationId: 'conv-1',
      url: '/messages?c=conv-1',
    });
    expect(payload.renotify).toBe(true);
  });

  it('never sends a stranger an attachment kind word', async () => {
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
      isConnected: false,
    });
    await listener.handleMessageCreated(
      makeEvent({
        kind: MessageKind.Image,
        body: 'Photo',
        attachment: {
          url: 'message-images/sender-1/photo.jpg',
          previewUrl: 'message-images/sender-1/photo.jpg',
          width: 800,
          height: 600,
          provider: 'upload',
        },
      }),
    );
    const payload = sentPayload(push, 0);
    expect(payload.body).toBe('You have a new message.');
  });

  it('fails private when the connection lookup throws', async () => {
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
      hasConnectionLookupFailure: true,
    });
    await listener.handleMessageCreated(makeEvent());
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const payload = sentPayload(push, 0);
    expect(payload.title).toBe('QueerPulse');
    expect(payload).not.toHaveProperty('icon');
  });
});

describe('group mention fold (PRD-336)', () => {
  it('sends exactly one push to a mentioned, pushable recipient, mention-aware and on the thread tag', async () => {
    const { listener, push } = build({
      participants: GROUP_PARTICIPANTS,
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
      mentionSlugUserIds: { ana: 'recipient-1' },
    });
    await listener.handleMessageCreated(
      makeEvent({ body: '@ana are we still on for Saturday?' }),
    );
    // TWO batches (one per recipient), never a third, separately-tagged push
    // for the mentioned recipient. This is the fold this proves.
    expect(push.sendToUsers).toHaveBeenCalledTimes(2);
    const calls = push.sendToUsers.mock.calls as [string[], PushPayload][];
    const mentionCall = calls.find(([userIds]) =>
      userIds.includes('recipient-1'),
    );
    const plainCall = calls.find(([userIds]) =>
      userIds.includes('recipient-2'),
    );
    if (!mentionCall || !plainCall) {
      throw new Error('expected one call per recipient');
    }
    const [mentionUserIds, mentionPayload] = mentionCall;
    const [plainUserIds, plainPayload] = plainCall;
    // Each recipient appears in exactly ONE of the two batches.
    expect(mentionUserIds).toEqual(['recipient-1']);
    expect(plainUserIds).toEqual(['recipient-2']);
    // Same thread tag on both, so a service worker replaces rather than
    // stacks. This is never a second, `notification:<id>`-tagged push.
    expect(mentionPayload.tag).toBe('conv-1');
    expect(plainPayload.tag).toBe('conv-1');
    expect(mentionPayload.title).toBe('Terrace crew');
    expect(mentionPayload.body).toBe(
      'Alex Doe mentioned you: @ana are we still on for Saturday?',
    );
    expect(mentionPayload.l10n).toEqual({
      bodyKey: 'push:messages.group.mention.body',
      params: {
        name: 'Alex Doe',
        preview: '@ana are we still on for Saturday?',
      },
    });
    // The non-mentioned recipient still gets the ordinary group copy.
    expect(plainPayload.body).toBe(
      'Alex Doe: @ana are we still on for Saturday?',
    );
  });

  it('never folds a DM mention (no group title to carry the mention copy)', async () => {
    const { listener, push } = build({
      participants: DIRECT_PARTICIPANTS,
      online: [],
      mentionSlugUserIds: { ana: 'recipient-1' },
    });
    await listener.handleMessageCreated(
      makeEvent({ body: '@ana are you free tonight?' }),
    );
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const payload = sentPayload(push, 0);
    expect(payload.body).toBe('@ana are you free tonight?');
    expect(payload).not.toHaveProperty('l10n');
  });

  it('leaves a mentioned recipient who is NOT pushable (e.g. thread-muted) out of the mention fold entirely', async () => {
    const { listener, push } = build({
      participants: [
        { userId: 'sender-1', muted: false },
        { userId: 'recipient-1', muted: true, mutedUntil: null },
        { userId: 'recipient-2', muted: false },
      ],
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
      mentionSlugUserIds: { ana: 'recipient-1' },
    });
    await listener.handleMessageCreated(
      makeEvent({ body: '@ana are we still on for Saturday?' }),
    );
    // recipient-1 is thread-muted, so they are excluded from `pushable`
    // entirely (unchanged by PRD-336) and get no push of either shape here.
    // `PushNotificationListener.pushMention` is what still reaches them.
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    const [userIds, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(userIds).toEqual(['recipient-2']);
    expect(payload).not.toHaveProperty('l10n');
  });
});

describe('eligibleMessagePushRecipientUserIds (PRD-336)', () => {
  it('narrows to only the requested candidates when given', async () => {
    const { listener } = build({
      participants: GROUP_PARTICIPANTS,
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
    });
    const eligible = await listener.eligibleMessagePushRecipientUserIds(
      'conv-1',
      'sender-1',
      ['recipient-1'],
    );
    expect(eligible).toEqual(new Set(['recipient-1']));
  });

  it('excludes a recipient outside the narrowed candidate list even if they would otherwise be eligible', async () => {
    const { listener } = build({
      participants: GROUP_PARTICIPANTS,
      online: [],
      conversationKind: ConversationKind.Group,
      groupTitle: 'Terrace crew',
    });
    const eligible = await listener.eligibleMessagePushRecipientUserIds(
      'conv-1',
      'sender-1',
      ['recipient-2'],
    );
    expect(eligible).not.toContain('recipient-1');
  });
});
