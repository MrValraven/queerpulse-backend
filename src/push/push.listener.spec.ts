import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { MessageKind } from '../messaging/entities/message.entity';
import { MessageCreatedEvent } from '../messaging/messaging.events';
import { MessageView } from '../messaging/message-response';
import { PushMessageListener } from './push.listener';
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

function makeEvent(overrides: Partial<MessageView> = {}): MessageCreatedEvent {
  const message: MessageView = {
    id: 'm1',
    conversationId: 'conv-1',
    senderId: 'sender-1',
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
      sender: { handle: 'alex', displayName: 'Alex Doe', avatarUrl: null },
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
  participants: { userId: string; muted: boolean }[];
  online: string[];
  isOfficial?: boolean;
  blocked?: string[];
  muters?: string[];
  pushDisabled?: string[];
  // Raw stored avatar for the sender's profile (undefined = no avatar). An
  // absolute https URL is a public avatar; a storage key resolves to our
  // auth-gated `/files/*` route and must NOT become the push icon.
  senderAvatarUrl?: string;
}) {
  const conversationsRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: 'conv-1',
      isOfficial: opts.isOfficial ?? false,
      pairKey: opts.isOfficial ? null : 'sender-1:recipient-1',
    }),
  };
  const participantsRepo = {
    find: jest.fn().mockResolvedValue(opts.participants),
  };
  const profilesRepo = {
    findOne: jest.fn().mockResolvedValue({
      userId: 'sender-1',
      firstName: 'Alex',
      lastName: 'Doe',
      slug: 'alex',
      avatarUrl: opts.senderAvatarUrl ?? null,
    }),
  };
  const presence = {
    isOnline: (userId: string) => opts.online.includes(userId),
  };
  const push = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
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
  const listener = new PushMessageListener(
    conversationsRepo as never,
    participantsRepo as never,
    profilesRepo as never,
    presence as never,
    push as never,
    blockFilter as never,
    notificationPreferences as never,
  );
  return {
    listener,
    push,
    participantsRepo,
    conversationsRepo,
    blockFilter,
    notificationPreferences,
  };
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

it('excludes muted participants at the query level', async () => {
  const { listener, participantsRepo } = build({
    participants: [{ userId: 'recipient-1', muted: false }],
    online: [],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(participantsRepo.find).toHaveBeenCalledWith({
    where: { conversationId: 'conv-1', muted: false },
  });
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
