import { MemberLookup } from '../common/member-ref';
import {
  extractMentions,
  mentionsAddedIn,
  mentionTokensText,
} from '../common/mentions';
import { EventStatus } from '../events/entities/event.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { MentionNotificationService } from './mention-notification.service';

// A mention written in a gathering's description (`source: 'event'`) reaches
// the people the gathering's detail page admits: its audience tier through
// `EventAudienceGateService.audienceAmong`, and organizers alone while it is
// a draft or taken down.

const MEMBER_USER_IDS: Record<string, string> = {
  ana: 'user-ana',
  bea: 'user-bea',
  host: 'user-host',
};

interface GatheringRow {
  id: string;
  slug: string;
  hostId: string;
  status: EventStatus;
}

function build(
  gathering: GatheringRow | null,
  audience: { organizerUserIds: string[]; viewerUserIds: string[] },
  takedown: { hidden: boolean; removed: boolean } = {
    hidden: false,
    removed: false,
  },
) {
  const events = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(gathering),
  };
  const listings = {
    find: jest
      .fn()
      .mockResolvedValue([{ slug: 'corner-cafe', ownerId: 'user-lister' }]),
  };
  const notifications = {
    createForRecipients: jest.fn<
      Promise<string[]>,
      Parameters<NotificationsService['createForRecipients']>
    >((userIds) => Promise.resolve(userIds)),
  };
  const contentModeration = {
    stateFor: jest.fn().mockResolvedValue(takedown),
  };
  const eventAudience = {
    audienceAmong: jest.fn().mockResolvedValue({
      organizerUserIds: new Set(audience.organizerUserIds),
      viewerUserIds: new Set(audience.viewerUserIds),
    }),
  };
  jest
    .spyOn(MemberLookup.prototype, 'userIdsForSlugs')
    .mockImplementation((slugs: string[]) =>
      Promise.resolve(
        new Map(
          slugs
            .filter((slug) => MEMBER_USER_IDS[slug] !== undefined)
            .map((slug) => [slug, MEMBER_USER_IDS[slug]!] as const),
        ),
      ),
    );

  const service = new MentionNotificationService(
    {} as never,
    {} as never,
    {} as never,
    listings as never,
    events as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
    {} as never,
    contentModeration as never,
    eventAudience as never,
  );

  const notifiedRecipients = () =>
    new Set(
      notifications.createForRecipients.mock.calls.flatMap((call) => call[0]),
    );

  return {
    service,
    events,
    notifications,
    contentModeration,
    eventAudience,
    notifiedRecipients,
  };
}

const PUBLISHED: GatheringRow = {
  id: 'event-1',
  slug: 'picnic',
  hostId: 'user-host',
  status: EventStatus.Published,
};

const eventPayload = {
  actorId: 'user-host',
  source: 'event',
  eventSlug: 'picnic',
  eventId: 'event-1',
  excerpt: 'Picnic with @ana and @bea',
};

describe('MentionNotificationService.notify, event source', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('notifies the tagged members the gathering admits, with the event payload', async () => {
    const { service, notifications, eventAudience, notifiedRecipients } = build(
      PUBLISHED,
      {
        organizerUserIds: [],
        viewerUserIds: ['user-ana', 'user-bea'],
      },
    );

    await service.notify(
      'Picnic with @ana and @bea',
      'user-host',
      eventPayload,
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-ana', 'user-bea']));
    expect(notifications.createForRecipients.mock.calls[0]?.[2]).toEqual({
      ...eventPayload,
      entityKind: 'member',
      entityRef: 'ana',
    });
    expect(eventAudience.audienceAmong).toHaveBeenCalledTimes(1);
  });

  it('drops a tagged member outside the gathering audience', async () => {
    const { service, notifiedRecipients } = build(PUBLISHED, {
      organizerUserIds: [],
      viewerUserIds: ['user-ana'],
    });

    await service.notify(
      'Picnic with @ana and @bea',
      'user-host',
      eventPayload,
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-ana']));
  });

  it('never notifies the organizer who wrote the tag', async () => {
    const { service, notifiedRecipients } = build(PUBLISHED, {
      organizerUserIds: ['user-host'],
      viewerUserIds: ['user-host', 'user-ana'],
    });

    await service.notify('Picnic with @host and @ana', 'user-host', {
      ...eventPayload,
      excerpt: 'Picnic with @host and @ana',
    });

    expect(notifiedRecipients()).toEqual(new Set(['user-ana']));
  });

  it('notifies the owner of a tagged business the gathering admits', async () => {
    const { service, notifiedRecipients } = build(PUBLISHED, {
      organizerUserIds: [],
      viewerUserIds: ['user-lister'],
    });

    await service.notify('Food by b/corner-cafe', 'user-host', eventPayload);

    expect(notifiedRecipients()).toEqual(new Set(['user-lister']));
  });

  it('admits organizers alone while the gathering is a draft', async () => {
    const { service, notifiedRecipients } = build(
      { ...PUBLISHED, status: EventStatus.Draft },
      {
        organizerUserIds: ['user-bea'],
        viewerUserIds: ['user-ana', 'user-bea'],
      },
    );

    await service.notify(
      'Picnic with @ana and @bea',
      'user-host',
      eventPayload,
    );

    expect(notifiedRecipients()).toEqual(new Set(['user-bea']));
  });

  it('admits organizers alone while the gathering is taken down', async () => {
    const { service, contentModeration, notifiedRecipients } = build(
      PUBLISHED,
      { organizerUserIds: [], viewerUserIds: ['user-ana', 'user-bea'] },
      { hidden: true, removed: false },
    );

    await service.notify(
      'Picnic with @ana and @bea',
      'user-host',
      eventPayload,
    );

    expect(notifiedRecipients()).toEqual(new Set());
    expect(contentModeration.stateFor).toHaveBeenCalledWith('event', 'event-1');
  });

  it('fails closed on a gathering that does not resolve', async () => {
    const { service, eventAudience, notifiedRecipients } = build(null, {
      organizerUserIds: [],
      viewerUserIds: ['user-ana'],
    });

    await service.notify('Picnic with @ana', 'user-host', eventPayload);

    expect(notifiedRecipients()).toEqual(new Set());
    expect(eventAudience.audienceAmong).not.toHaveBeenCalled();
  });
});

describe('mentionsAddedIn and mentionTokensText', () => {
  it('keeps only the mentions the next body adds, per bucket', () => {
    const added = mentionsAddedIn(
      'With @ana at b/corner-cafe',
      'With @ana and @bea at b/corner-cafe, see e/brunch',
    );

    expect(added).toEqual({
      members: ['bea'],
      communities: [],
      businesses: [],
      events: ['brunch'],
      threads: [],
    });
  });

  it('spells mentions back so extractMentions reads the same set', () => {
    const mentions = mentionsAddedIn('', '@ana c/pride b/corner-cafe t/tips');
    const text = mentionTokensText(mentions);

    expect(text).toBe('@ana c/pride b/corner-cafe t/tips');
    expect(extractMentions(text)).toEqual(mentions);
  });

  it('is empty when nothing was added', () => {
    expect(mentionTokensText(mentionsAddedIn('@ana', '@ana again'))).toBe('');
  });
});
