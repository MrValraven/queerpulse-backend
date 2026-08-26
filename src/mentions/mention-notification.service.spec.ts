import { MentionNotificationService } from './mention-notification.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import type { NotificationsService } from '../notifications/notifications.service';
import { RosterRole } from '../communities/entities/community-member.entity';
import { AccessTier } from '../communities/entities/community.entity';
import { MemberLookup } from '../common/member-ref';

// Minimal fake repositories; only the paths exercised below are stubbed.
// Member-slug resolution goes through `MemberLookup` (constructed fresh
// inside the service from the injected `profiles` repo), so — mirroring
// `forum-posts.service.spec.ts` — it's spied on directly rather than
// reimplementing its query-builder chain here.
function build() {
  const profiles = {} as never;
  const communities = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const members = { find: jest.fn().mockResolvedValue([]) };
  const listings = { findOne: jest.fn() };
  const events = { findOne: jest.fn() };
  const threads = { findOne: jest.fn() };
  // A `message`-source mention is restricted to the conversation's own
  // participants, so the fan-out reads this repo. Default: nobody is a
  // participant, which is the fail-closed shape the service relies on.
  const conversationParticipants = { find: jest.fn().mockResolvedValue([]) };
  const notifications = {
    // Resolves to the ids it actually notified (the real signature returns
    // `Promise<string[]>`; `notify` reads that array). A stub resolving to
    // `undefined` throws inside the loop and silently swallows every
    // remaining mention group. Typed against the real method signature so
    // `.mock.calls[0]` comes back as the real 4-tuple, not a 1-tuple.
    createForRecipients: jest.fn<
      Promise<string[]>,
      Parameters<NotificationsService['createForRecipients']>
    >((userIds) => Promise.resolve(userIds)),
  };
  const userIdsForSlugs = jest
    .spyOn(MemberLookup.prototype, 'userIdsForSlugs')
    .mockResolvedValue(new Map());

  const service = new MentionNotificationService(
    profiles,
    communities as never,
    members as never,
    listings as never,
    events as never,
    threads as never,
    conversationParticipants as never,
    notifications as never,
  );

  return {
    service,
    conversationParticipants,
    communities,
    members,
    listings,
    events,
    threads,
    notifications,
    userIdsForSlugs,
  };
}

const payloadBase = { postId: 'post-1' };

describe('MentionNotificationService.notify', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('member mention notifies exactly that one recipient', async () => {
    const { service, notifications, userIdsForSlugs } = build();
    userIdsForSlugs.mockResolvedValue(new Map([['alice', 'user-alice']]));

    await service.notify('hey @alice check this', 'author-1', payloadBase);

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['user-alice'],
      NotificationType.Mention,
      { ...payloadBase, entityKind: 'member', entityRef: 'alice' },
      'author-1',
    );
  });

  it('community mention notifies the owner and every mod', async () => {
    const { service, communities, members, notifications } = build();
    communities.find.mockResolvedValue([
      {
        id: 'community-1',
        slug: 'pride',
        ownerId: 'owner-1',
      },
    ]);
    members.find.mockResolvedValue([
      { communityId: 'community-1', userId: 'owner-1', role: RosterRole.Owner },
      { communityId: 'community-1', userId: 'mod-1', role: RosterRole.Mod },
    ]);

    await service.notify('shoutout to c/pride', 'author-1', payloadBase);

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    // The call count assertion above guarantees this call happened.
    const [recipients, type, payload, actorId] =
      notifications.createForRecipients.mock.calls[0]!;
    expect(new Set(recipients)).toEqual(new Set(['owner-1', 'mod-1']));
    expect(type).toBe(NotificationType.Mention);
    expect(payload).toEqual({
      ...payloadBase,
      entityKind: 'community',
      entityRef: 'pride',
    });
    expect(actorId).toBe('author-1');
  });

  it('never notifies the author, even when the author is mentioned', async () => {
    const { service, notifications, userIdsForSlugs } = build();
    userIdsForSlugs.mockResolvedValue(new Map([['author-slug', 'author-1']]));

    await service.notify(
      '@author-slug replying to myself',
      'author-1',
      payloadBase,
    );

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('a member mentioned by @slug who is also a community owner is notified once (member priority)', async () => {
    const { service, communities, members, notifications, userIdsForSlugs } =
      build();
    userIdsForSlugs.mockResolvedValue(new Map([['sameuser', 'user-x']]));
    communities.find.mockResolvedValue([
      {
        id: 'community-2',
        slug: 'samecommunity',
        ownerId: 'user-x',
      },
    ]);
    members.find.mockResolvedValue([]);

    await service.notify(
      '@sameuser also owns c/samecommunity',
      'author-1',
      payloadBase,
    );

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    // The call count assertion above guarantees this call happened.
    const [recipients, , payload] =
      notifications.createForRecipients.mock.calls[0]!;
    expect(recipients).toEqual(['user-x']);
    expect(payload).toMatchObject({ entityKind: 'member' });
  });

  it('skips an unresolvable slug (repo returns null) without notifying', async () => {
    const { service, communities, notifications } = build();
    communities.find.mockResolvedValue([]);

    await service.notify(
      'c/doesnotexist has vanished',
      'author-1',
      payloadBase,
    );

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('restricts an @-member mention inside a NON-public community to its roster (excerpt must not leak — H3)', async () => {
    const { service, communities, members, notifications, userIdsForSlugs } =
      build();
    userIdsForSlugs.mockResolvedValue(
      new Map([
        ['insider', 'user-insider'],
        ['outsider', 'user-outsider'],
      ]),
    );
    communities.findOne.mockResolvedValue({
      id: 'community-1',
      slug: 'private-support',
      accessTier: AccessTier.Private,
    });
    // Only the insider holds a roster row in the private community; the
    // service's `members.find` (an `In(candidateUserIds)` lookup) returns just
    // them, so the outsider is dropped before any notification is created.
    members.find.mockResolvedValue([
      { communityId: 'community-1', userId: 'user-insider' },
    ]);

    await service.notify('@insider @outsider look here', 'author-1', {
      source: 'community',
      communitySlug: 'private-support',
      postId: 'post-1',
      excerpt: 'a private thing said inside a private community',
    });

    const notifiedRecipients =
      notifications.createForRecipients.mock.calls.flatMap((call) => call[0]);
    expect(notifiedRecipients).toEqual(['user-insider']);
    expect(notifiedRecipients).not.toContain('user-outsider');
  });

  it("restricts an @-member mention inside a DM to that conversation's participants", async () => {
    const {
      service,
      conversationParticipants,
      notifications,
      userIdsForSlugs,
    } = build();
    userIdsForSlugs.mockResolvedValue(
      new Map([
        ['insider', 'user-insider'],
        ['outsider', 'user-outsider'],
      ]),
    );
    // Only the insider is in the room. A DM is the most private space on the
    // platform: notifying the outsider would disclose that a private
    // conversation exists and names them, and would persist a 140-char
    // excerpt of someone else's private message.
    conversationParticipants.find.mockResolvedValue([
      { userId: 'user-insider' },
    ]);

    await service.notify('@insider @outsider look here', 'author-1', {
      source: 'message',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      excerpt: 'something said inside a private thread',
    });

    const notifiedRecipients =
      notifications.createForRecipients.mock.calls.flatMap((call) => call[0]);
    expect(notifiedRecipients).toEqual(['user-insider']);
    expect(notifiedRecipients).not.toContain('user-outsider');
  });

  it('fails CLOSED on a message mention carrying no conversationId', async () => {
    const { service, notifications, userIdsForSlugs } = build();
    userIdsForSlugs.mockResolvedValue(new Map([['someone', 'user-someone']]));

    // Unlike the community branch, which fails open, an unclassifiable
    // conversation must notify nobody rather than broadcast a DM excerpt.
    await service.notify('@someone', 'author-1', {
      source: 'message',
      excerpt: 'a private thing',
    });

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('does NOT restrict an @-member mention in a PUBLIC community', async () => {
    const { service, communities, members, notifications, userIdsForSlugs } =
      build();
    userIdsForSlugs.mockResolvedValue(
      new Map([
        ['alice', 'user-alice'],
        ['bob', 'user-bob'],
      ]),
    );
    communities.findOne.mockResolvedValue({
      id: 'community-1',
      slug: 'open-space',
      accessTier: AccessTier.Public,
    });

    await service.notify('@alice @bob welcome', 'author-1', {
      source: 'community',
      communitySlug: 'open-space',
      postId: 'post-1',
      excerpt: 'public content',
    });

    const notifiedRecipients =
      notifications.createForRecipients.mock.calls.flatMap((call) => call[0]);
    expect(new Set(notifiedRecipients)).toEqual(
      new Set(['user-alice', 'user-bob']),
    );
    // A public community is never roster-filtered.
    expect(members.find).not.toHaveBeenCalled();
  });

  it('never propagates a thrown resolver error — best-effort only', async () => {
    const { service, communities, notifications } = build();
    communities.find.mockRejectedValue(new Error('db exploded'));

    await expect(
      service.notify(
        'c/explode should not crash the write',
        'author-1',
        payloadBase,
      ),
    ).resolves.toEqual(new Set());

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });
});
