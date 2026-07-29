import { MentionNotificationService } from './mention-notification.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { RosterRole } from '../communities/entities/community-member.entity';
import { MemberLookup } from '../common/member-ref';

// Minimal fake repositories; only the paths exercised below are stubbed.
// Member-slug resolution goes through `MemberLookup` (constructed fresh
// inside the service from the injected `profiles` repo), so — mirroring
// `forum-posts.service.spec.ts` — it's spied on directly rather than
// reimplementing its query-builder chain here.
function build() {
  const profiles = {} as never;
  const communities = { findOne: jest.fn() };
  const members = { find: jest.fn().mockResolvedValue([]) };
  const listings = { findOne: jest.fn() };
  const events = { findOne: jest.fn() };
  const threads = { findOne: jest.fn() };
  const notifications = {
    createForRecipients: jest.fn().mockResolvedValue(undefined),
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
    notifications as never,
  );

  return {
    service,
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
    communities.findOne.mockResolvedValue({
      id: 'community-1',
      slug: 'pride',
      ownerId: 'owner-1',
    });
    members.find.mockResolvedValue([
      { userId: 'owner-1', role: RosterRole.Owner },
      { userId: 'mod-1', role: RosterRole.Mod },
    ]);

    await service.notify('shoutout to c/pride', 'author-1', payloadBase);

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    const [recipients, type, payload, actorId] = notifications
      .createForRecipients.mock.calls[0] as [
      string[],
      NotificationType,
      Record<string, unknown>,
      string | undefined,
    ];
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
    communities.findOne.mockResolvedValue({
      id: 'community-2',
      slug: 'samecommunity',
      ownerId: 'user-x',
    });
    members.find.mockResolvedValue([]);

    await service.notify(
      '@sameuser also owns c/samecommunity',
      'author-1',
      payloadBase,
    );

    expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    const [recipients, , payload] = notifications.createForRecipients.mock
      .calls[0] as [
      string[],
      NotificationType,
      Record<string, unknown>,
      string | undefined,
    ];
    expect(recipients).toEqual(['user-x']);
    expect(payload).toMatchObject({ entityKind: 'member' });
  });

  it('skips an unresolvable slug (repo returns null) without notifying', async () => {
    const { service, communities, notifications } = build();
    communities.findOne.mockResolvedValue(null);

    await service.notify(
      'c/doesnotexist has vanished',
      'author-1',
      payloadBase,
    );

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('never propagates a thrown resolver error — best-effort only', async () => {
    const { service, communities, notifications } = build();
    communities.findOne.mockRejectedValue(new Error('db exploded'));

    await expect(
      service.notify(
        'c/explode should not crash the write',
        'author-1',
        payloadBase,
      ),
    ).resolves.toBeUndefined();

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });
});
