import { ConversationKind } from '../messaging/entities/conversation.entity';
import { GroupMembersAddedEvent } from '../messaging/messaging.events';
import { NotificationType } from './entities/notification.entity';
import { GroupNotificationsListener } from './group-notifications.listener';

function build(
  conversation: {
    id: string;
    kind: ConversationKind;
    title: string | null;
  } | null,
) {
  const notifications = {
    createForRecipients: jest.fn().mockResolvedValue([]),
  };
  const conversations = {
    findOne: jest.fn().mockResolvedValue(conversation),
  };
  const listener = new GroupNotificationsListener(
    notifications as never,
    conversations as never,
  );
  return { listener, notifications, conversations };
}

const EVENT: GroupMembersAddedEvent = {
  conversationId: 'conv-1',
  actorUserId: 'actor-1',
  addedUserIds: ['member-1', 'member-2'],
};

describe('GroupNotificationsListener', () => {
  it('writes one group_added row per added member, with the adder as actor', async () => {
    const { listener, notifications } = build({
      id: 'conv-1',
      kind: ConversationKind.Group,
      title: 'Book club',
    });
    await listener.onGroupMembersAdded(EVENT);
    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['member-1', 'member-2'],
      NotificationType.GroupAdded,
      {
        source: 'message',
        conversationId: 'conv-1',
        groupTitle: 'Book club',
        actorId: 'actor-1',
      },
      // The block/mute gate argument.
      'actor-1',
    );
  });

  it('never notifies the actor and dedupes repeated ids', async () => {
    const { listener, notifications } = build({
      id: 'conv-1',
      kind: ConversationKind.Group,
      title: 'Book club',
    });
    await listener.onGroupMembersAdded({
      ...EVENT,
      addedUserIds: ['member-1', 'actor-1', 'member-1'],
    });
    const [recipientUserIds] = notifications.createForRecipients.mock
      .calls[0] as [string[]];
    expect(recipientUserIds).toEqual(['member-1']);
  });

  it('omits groupTitle when the group has no title', async () => {
    const { listener, notifications } = build({
      id: 'conv-1',
      kind: ConversationKind.Group,
      title: null,
    });
    await listener.onGroupMembersAdded(EVENT);
    const [, , payload] = notifications.createForRecipients.mock.calls[0] as [
      string[],
      NotificationType,
      Record<string, unknown>,
    ];
    expect(payload).not.toHaveProperty('groupTitle');
  });

  it('writes nothing for a missing conversation or a direct conversation', async () => {
    const missing = build(null);
    await missing.listener.onGroupMembersAdded(EVENT);
    expect(missing.notifications.createForRecipients).not.toHaveBeenCalled();

    const direct = build({
      id: 'conv-1',
      kind: ConversationKind.Direct,
      title: null,
    });
    await direct.listener.onGroupMembersAdded(EVENT);
    expect(direct.notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('skips the lookup entirely when nobody was added', async () => {
    const { listener, notifications, conversations } = build({
      id: 'conv-1',
      kind: ConversationKind.Group,
      title: 'Book club',
    });
    await listener.onGroupMembersAdded({ ...EVENT, addedUserIds: [] });
    expect(conversations.findOne).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('never throws when the write fails (best-effort)', async () => {
    const { listener, notifications } = build({
      id: 'conv-1',
      kind: ConversationKind.Group,
      title: 'Book club',
    });
    notifications.createForRecipients.mockRejectedValueOnce(new Error('boom'));
    await expect(listener.onGroupMembersAdded(EVENT)).resolves.toBeUndefined();
  });
});
