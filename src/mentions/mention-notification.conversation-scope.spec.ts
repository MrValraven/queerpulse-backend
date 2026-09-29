import { FindOperator } from 'typeorm';
import { MentionNotificationService } from './mention-notification.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import type { NotificationsService } from '../notifications/notifications.service';
import { RosterRole } from '../communities/entities/community-member.entity';
import { MemberLookup } from '../common/member-ref';
import { messageMentionText } from '../common/mentions';
import { MessageKind } from '../messaging/entities/message.entity';
import { MessagesService } from '../messaging/messages.service';
import type { MessageResponse } from '../messaging/message-response';

// ENG-400: a mention written inside a DM or group reaches only the
// conversation's current participants, for every entity kind. The
// participant repo below honours the `userId: In(...)` filter the service
// sends, so each test states who sits in the conversation and the service's
// own query decides who passes.
function build(participantUserIds: string[]) {
  const communities = {
    find: jest
      .fn()
      .mockResolvedValue([
        { id: 'community-1', slug: 'pride', ownerId: 'user-owner' },
      ]),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const members = {
    find: jest.fn().mockResolvedValue([
      {
        communityId: 'community-1',
        userId: 'user-owner',
        role: RosterRole.Owner,
      },
      { communityId: 'community-1', userId: 'user-mod', role: RosterRole.Mod },
    ]),
  };
  const listings = {
    find: jest
      .fn()
      .mockResolvedValue([{ slug: 'corner-cafe', ownerId: 'user-lister' }]),
  };
  const events = {
    find: jest
      .fn()
      .mockResolvedValue([{ slug: 'pride-picnic', hostId: 'user-host' }]),
  };
  const threads = {
    find: jest
      .fn()
      .mockResolvedValue([{ slug: 'housing-tips', authorId: 'user-writer' }]),
  };
  const participantQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  const conversationParticipants = {
    find: jest.fn(
      ({ where }: { where: { userId: FindOperator<string[]> } }) => {
        const requestedUserIds = where.userId.value;
        return Promise.resolve(
          participantUserIds
            .filter((userId) => requestedUserIds.includes(userId))
            .map((userId) => ({ userId })),
        );
      },
    ),
    createQueryBuilder: jest.fn(() => participantQueryBuilder),
  };
  const notifications = {
    createForRecipients: jest.fn<
      Promise<string[]>,
      Parameters<NotificationsService['createForRecipients']>
    >((userIds) => Promise.resolve(userIds)),
  };
  const userIdsForSlugs = jest
    .spyOn(MemberLookup.prototype, 'userIdsForSlugs')
    .mockResolvedValue(new Map());

  // A forum fan-out reads platform staff roles and author blocks; default
  // nobody is staff and nobody is blocked.
  const users = { find: jest.fn().mockResolvedValue([]) };
  const blockFilter = {
    blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
  };
  // A community fan-out reads the community's takedown state; default
  // visible, so the community-source cases here keep their own audience.
  const contentModeration = {
    stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
  };

  const service = new MentionNotificationService(
    {} as never,
    communities as never,
    members as never,
    listings as never,
    events as never,
    threads as never,
    conversationParticipants as never,
    users as never,
    notifications as never,
    blockFilter as never,
    contentModeration as never,
  );

  const notifiedRecipients = () =>
    notifications.createForRecipients.mock.calls.flatMap((call) => call[0]);

  return {
    service,
    conversationParticipants,
    notifications,
    userIdsForSlugs,
    notifiedRecipients,
  };
}

const messagePayload = {
  actorId: 'author-1',
  source: 'message',
  conversationId: 'conversation-1',
  messageId: 'message-1',
  excerpt: 'something said inside a private thread',
};

describe('MentionNotificationService.notify inside a conversation (ENG-400)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('notifies no community owner, mod, event host, listing owner or thread author who is outside the conversation', async () => {
    const { service, notifications, conversationParticipants } = build([
      'author-1',
      'user-friend',
    ]);

    const notified = await service.notify(
      'see c/pride e/pride-picnic b/corner-cafe t/housing-tips',
      'author-1',
      messagePayload,
    );

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(notified).toEqual(new Set());
    // Every entity recipient went through the participant check.
    const [findArguments] = conversationParticipants.find.mock.calls[0]!;
    expect(new Set(findArguments.where.userId.value)).toEqual(
      new Set([
        'user-owner',
        'user-mod',
        'user-host',
        'user-lister',
        'user-writer',
      ]),
    );
  });

  it('notifies a community owner who sits in the conversation and drops the mod who does not', async () => {
    const { service, notifications, notifiedRecipients } = build([
      'author-1',
      'user-owner',
    ]);

    await service.notify('ask c/pride about it', 'author-1', messagePayload);

    expect(notifiedRecipients()).toEqual(['user-owner']);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-owner'],
      NotificationType.Mention,
      { ...messagePayload, entityKind: 'community', entityRef: 'pride' },
      'author-1',
    );
  });

  it('notifies an event host who sits in the conversation', async () => {
    const { service, notifiedRecipients } = build(['author-1', 'user-host']);

    await service.notify(
      'going to e/pride-picnic?',
      'author-1',
      messagePayload,
    );

    expect(notifiedRecipients()).toEqual(['user-host']);
  });

  it('fails closed for an entity mention on a message payload with no conversationId', async () => {
    const { service, notifications } = build(['user-owner', 'user-host']);

    await service.notify('c/pride e/pride-picnic', 'author-1', {
      source: 'message',
      excerpt: 'a private thing',
    });

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('keeps member priority: a participant named by @slug and as a community owner gets one member notification', async () => {
    const { service, notifications, userIdsForSlugs } = build([
      'author-1',
      'user-owner',
    ]);
    userIdsForSlugs.mockResolvedValue(new Map([['owner', 'user-owner']]));

    await service.notify('@owner runs c/pride', 'author-1', messagePayload);

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-owner'],
      NotificationType.Mention,
      { ...messagePayload, entityKind: 'member', entityRef: 'owner' },
      'author-1',
    );
  });

  it('leaves a community-post entity mention unrestricted by conversation seats', async () => {
    const { service, conversationParticipants, notifiedRecipients } = build([]);

    await service.notify('shoutout to c/pride', 'author-1', {
      source: 'community',
      communitySlug: 'open-space',
      postId: 'post-1',
    });

    expect(conversationParticipants.find).not.toHaveBeenCalled();
    expect(new Set(notifiedRecipients())).toEqual(
      new Set(['user-owner', 'user-mod']),
    );
  });
});

// Carried 09-15 item 2: `MessagesService.mentionTextFor` picks the text the
// send path hands to `notify`. Called on a bare prototype instance because
// the method reads nothing from the service's injected dependencies.
describe('MessagesService.mentionTextFor', () => {
  const messagesService = Object.create(
    MessagesService.prototype,
  ) as MessagesService;
  const mentionTextFor = (response: Partial<MessageResponse>, body: string) =>
    (
      messagesService as unknown as {
        mentionTextFor: (response: MessageResponse, body: string) => string;
      }
    ).mentionTextFor(response as MessageResponse, body);

  it('scans the body of a plain text message', () => {
    expect(mentionTextFor({ kind: 'user', attachment: null }, 'hi @sam')).toBe(
      'hi @sam',
    );
  });

  it('scans the caption of a photo and skips its fallback label', () => {
    expect(
      mentionTextFor(
        {
          kind: 'image',
          attachment: {
            url: 'message-image/key',
            previewUrl: 'message-image/key',
            width: 10,
            height: 10,
            provider: 'upload',
            caption: 'look @sam',
          },
        },
        'Photo',
      ),
    ).toBe('look @sam');
  });

  it('returns nothing for an uncaptioned document, so its fallback label is never scanned', () => {
    expect(
      mentionTextFor(
        {
          kind: 'document',
          attachment: {
            url: 'message-document/key',
            fileName: 'lease.pdf',
            byteSize: 100,
            contentType: 'application/pdf',
            provider: 'upload',
          },
        },
        'Document',
      ),
    ).toBe('');
  });
});

// The shared kind rule behind the send-time fan-out, the inbox's
// unread-mention flag and the group mention push.
describe('messageMentionText', () => {
  it('reads the caption of a gif typed as the entity enum', () => {
    expect(
      messageMentionText({
        kind: MessageKind.Gif,
        body: 'GIF',
        attachment: {
          url: 'https://example.test/a.gif',
          previewUrl: 'https://example.test/a.gif',
          width: 10,
          height: 10,
          provider: 'klipy',
          caption: 'for @sam',
        },
      }),
    ).toBe('for @sam');
  });

  it('returns an empty string for a sticker, which carries no caption', () => {
    expect(
      messageMentionText({
        kind: MessageKind.Sticker,
        body: 'Sticker',
        attachment: {
          url: 'sticker/key',
          previewUrl: 'sticker/key',
          width: 10,
          height: 10,
          provider: 'sticker',
          stickerId: 'sticker-1',
          label: 'wave',
        },
      }),
    ).toBe('');
  });

  it('reads the body of a plain message', () => {
    expect(
      messageMentionText({
        kind: MessageKind.User,
        body: 'hi @sam',
        attachment: null,
      }),
    ).toBe('hi @sam');
  });
});
