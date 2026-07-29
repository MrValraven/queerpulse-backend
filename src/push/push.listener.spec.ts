import { MessageKind } from '../messaging/entities/message.entity';
import { MessageCreatedEvent } from '../messaging/messaging.events';
import { MessageView } from '../messaging/message-response';
import { PushMessageListener } from './push.listener';
import { PushPayload } from './push.service';

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
      replyTo: null,
      kind: 'user',
      systemEvent: null,
    },
  };
}

function build(opts: {
  participants: { userId: string; muted: boolean }[];
  online: string[];
  isOfficial?: boolean;
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
    }),
  };
  const presence = {
    isOnline: (userId: string) => opts.online.includes(userId),
  };
  const push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
  const listener = new PushMessageListener(
    conversationsRepo as never,
    participantsRepo as never,
    profilesRepo as never,
    presence as never,
    push as never,
  );
  return { listener, push, participantsRepo, conversationsRepo };
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
  expect(push.sendToUser).toHaveBeenCalledTimes(1);
  const [userId, payload] = push.sendToUser.mock.calls[0] as [
    string,
    PushPayload,
  ];
  expect(userId).toBe('recipient-1');
  expect(payload.title).toBe('Alex Doe');
  expect(payload.body).toBe('hey there');
  expect(payload.data.url).toBe('/messages?c=conv-1');
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
  expect(push.sendToUser).not.toHaveBeenCalled();
});

it('never pushes to the sender', async () => {
  const { listener, push } = build({
    participants: [{ userId: 'sender-1', muted: false }],
    online: [],
  });
  await listener.handleMessageCreated(makeEvent());
  expect(push.sendToUser).not.toHaveBeenCalled();
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
  expect(push.sendToUser).not.toHaveBeenCalled();
  // Bails before the participant query — no unnecessary work for group threads.
  expect(participantsRepo.find).not.toHaveBeenCalled();
});
