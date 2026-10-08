import { FindOperator, Repository } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { ConnectionsService } from '../connections/connections.service';
import { EventAudienceGateService } from '../events/event-audience-gate.service';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventInvite } from '../events/entities/event-invite.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Listing } from '../listings/entities/listing.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { matchedChatMemberKey } from '../messaging/matched-member-key';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { MentionNameResolveService } from './mention-name-resolve.service';

/**
 * PRD-423: inside a matched Go together chat, a mention of one of its members
 * resolves to that member's first name, the spelling every other name in the
 * chat uses. Anywhere else, and for anyone outside the chat's seats, a
 * mention keeps the member's full name.
 */

const VIEWER_ID = 'viewer-1';
const ANA_ID = 'ana-1';
const OUTSIDER_ID = 'outsider-1';
const CONVERSATION_ID = '4f1c7a52-9a3e-4d4b-8f5e-2b6c1d0e9a11';

const PROFILES = [
  { userId: VIEWER_ID, slug: 'viv-self', firstName: 'Viv', lastName: 'Self' },
  {
    userId: ANA_ID,
    slug: 'ana-sousa',
    firstName: 'Ana',
    lastName: 'Sousa',
    // The private tier only chooses the limited card, which still names her.
    visibility: ProfileVisibility.Private,
  },
  {
    userId: OUTSIDER_ID,
    slug: 'rui-lopes',
    firstName: 'Rui',
    lastName: 'Lopes',
  },
] as Profile[];

function buildService(options: {
  eventMatchGroupId: string | null;
  isGoTogetherChat?: boolean;
  seatUserIds: string[];
  /** User ids a block gate drops (either direction) for the viewer. */
  blockedUserIds?: string[];
  /** User ids who hid their profile from the viewer. */
  hiddenFromUserIds?: string[];
  /** User ids a moderator hid or removed. */
  takenDownUserIds?: string[];
}) {
  let profileQueryCount = 0;
  const droppedUserIds = new Set<string>();
  const profileQuery = {
    innerJoin: () => profileQuery,
    where: () => profileQuery,
    andWhere: () => profileQuery,
    getMany: () => {
      profileQueryCount += 1;
      return Promise.resolve(
        PROFILES.filter(
          (profile) =>
            profile.userId !== VIEWER_ID && !droppedUserIds.has(profile.userId),
        ),
      );
    },
  };
  const blockFilter = {
    excludeBlocked: jest.fn(() => {
      options.blockedUserIds?.forEach((id) => droppedUserIds.add(id));
      return profileQuery;
    }),
  };
  const hiddenFrom = {
    excludeHiddenFrom: jest.fn(() => {
      options.hiddenFromUserIds?.forEach((id) => droppedUserIds.add(id));
      return profileQuery;
    }),
  };
  const contentModeration = {
    statesForAnyType: jest.fn((_types: string[], subjectIds: string[]) =>
      Promise.resolve(
        new Map(
          subjectIds
            .filter((id) => options.takenDownUserIds?.includes(id))
            .map((id) => [id, { hidden: true, removed: false }]),
        ),
      ),
    ),
  };
  const empty = { find: jest.fn().mockResolvedValue([]) };
  const conversations = {
    findOne: jest.fn().mockResolvedValue({
      id: CONVERSATION_ID,
      eventMatchGroupId: options.eventMatchGroupId,
      isGoTogetherChat:
        options.isGoTogetherChat ?? options.eventMatchGroupId !== null,
    }),
  };
  const participants = {
    find: jest
      .fn()
      .mockResolvedValue(options.seatUserIds.map((userId) => ({ userId }))),
  };
  const service = new MentionNameResolveService(
    {
      createQueryBuilder: () => profileQuery,
      find: jest.fn(() =>
        Promise.resolve(
          PROFILES.filter((profile) => profile.userId === VIEWER_ID),
        ),
      ),
    } as unknown as Repository<Profile>,
    empty as unknown as Repository<Community>,
    empty as unknown as Repository<CommunityMember>,
    empty as unknown as Repository<Listing>,
    empty as unknown as Repository<Event>,
    empty as unknown as Repository<ForumThread>,
    conversations as unknown as Repository<Conversation>,
    participants as unknown as Repository<ConversationParticipant>,
    blockFilter as unknown as BlockFilterService,
    hiddenFrom as unknown as HiddenFromService,
    contentModeration as unknown as ContentModerationService,
    empty as unknown as Repository<EventCohost>,
    {} as unknown as EventAudienceGateService,
  );
  return {
    service,
    conversations,
    contentModeration,
    profileQueries: () => profileQueryCount,
  };
}

const REFS = ['member:ana-sousa', 'member:rui-lopes'];

function nameBySlug(resolved: { slug: string; name: string }[]) {
  return Object.fromEntries(resolved.map((entry) => [entry.slug, entry.name]));
}

describe('MentionNameResolveService, matched Go together chats (PRD-423)', () => {
  it('resolves no slug member mention for a viewer seated in a matched chat, seated member or not', async () => {
    const { service, profileQueries } = buildService({
      eventMatchGroupId: 'match-group-1',
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS, CONVERSATION_ID);

    // The chat answers nothing about a slug: no lookup runs at all.
    expect(nameBySlug(resolved)).toEqual({});
    expect(profileQueries()).toBe(0);
  });

  it('names a member by key in a Go together chat whose group row is gone', async () => {
    const anaKey = matchedChatMemberKey(CONVERSATION_ID, ANA_ID);
    const { service } = buildService({
      eventMatchGroupId: null,
      isGoTogetherChat: true,
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(
      VIEWER_ID,
      [`member:${anaKey}`, 'member:ana-sousa'],
      CONVERSATION_ID,
    );

    expect(nameBySlug(resolved)).toEqual({ [anaKey]: 'Ana' });
  });

  it('keeps full names in a normal group', async () => {
    const { service } = buildService({
      eventMatchGroupId: null,
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS, CONVERSATION_ID);

    expect(nameBySlug(resolved)['ana-sousa']).toBe('Ana Sousa');
  });

  it('keeps full names for a viewer who holds no seat in the matched chat', async () => {
    const { service } = buildService({
      eventMatchGroupId: 'match-group-1',
      seatUserIds: [ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS, CONVERSATION_ID);

    expect(nameBySlug(resolved)['ana-sousa']).toBe('Ana Sousa');
  });

  it('reads no conversation when the caller names none', async () => {
    const { service, conversations } = buildService({
      eventMatchGroupId: 'match-group-1',
      seatUserIds: [VIEWER_ID, ANA_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, REFS);

    expect(nameBySlug(resolved)['ana-sousa']).toBe('Ana Sousa');
    expect(conversations.findOne).not.toHaveBeenCalled();
  });

  describe('PRD-423 (opaque member keys)', () => {
    const anaKey = matchedChatMemberKey(CONVERSATION_ID, ANA_ID);

    it('names a member mentioned by their per-chat key, for a viewer seated in the chat', async () => {
      const { service } = buildService({
        eventMatchGroupId: 'match-group-1',
        seatUserIds: [VIEWER_ID, ANA_ID],
      });

      const resolved = await service.resolve(
        VIEWER_ID,
        [`member:${anaKey}`],
        CONVERSATION_ID,
      );

      expect(nameBySlug(resolved)[anaKey]).toBe('Ana');
    });

    it('leaves a key unresolved for a viewer who holds no seat', async () => {
      const { service } = buildService({
        eventMatchGroupId: 'match-group-1',
        seatUserIds: [ANA_ID],
      });

      const resolved = await service.resolve(
        VIEWER_ID,
        [`member:${anaKey}`],
        CONVERSATION_ID,
      );

      expect(nameBySlug(resolved)[anaKey]).toBeUndefined();
    });

    it('leaves a key minted for another chat unresolved', async () => {
      const otherChatKey = matchedChatMemberKey('another-chat', ANA_ID);
      const { service } = buildService({
        eventMatchGroupId: 'match-group-1',
        seatUserIds: [VIEWER_ID, ANA_ID],
      });

      const resolved = await service.resolve(
        VIEWER_ID,
        [`member:${otherChatKey}`],
        CONVERSATION_ID,
      );

      expect(nameBySlug(resolved)[otherChatKey]).toBeUndefined();
    });

    it('leaves a key unresolved in a normal group', async () => {
      const { service } = buildService({
        eventMatchGroupId: null,
        seatUserIds: [VIEWER_ID, ANA_ID],
      });

      const resolved = await service.resolve(
        VIEWER_ID,
        [`member:${anaKey}`],
        CONVERSATION_ID,
      );

      expect(nameBySlug(resolved)[anaKey]).toBeUndefined();
    });
  });
});

describe('MentionNameResolveService, member profile gates', () => {
  const MEMBER_REFS = [
    'member:ana-sousa',
    'member:rui-lopes',
    'member:viv-self',
  ];
  const seats = { eventMatchGroupId: null, seatUserIds: [] };

  it('names every active member and the viewer when no gate applies', async () => {
    const { service } = buildService(seats);

    const resolved = await service.resolve(VIEWER_ID, MEMBER_REFS);

    expect(nameBySlug(resolved)).toEqual({
      'ana-sousa': 'Ana Sousa',
      'rui-lopes': 'Rui Lopes',
      'viv-self': 'Viv Self',
    });
  });

  it('omits a member blocked either way with the viewer', async () => {
    const { service } = buildService({ ...seats, blockedUserIds: [ANA_ID] });

    const resolved = await service.resolve(VIEWER_ID, MEMBER_REFS);

    expect(nameBySlug(resolved)['ana-sousa']).toBeUndefined();
    expect(nameBySlug(resolved)['rui-lopes']).toBe('Rui Lopes');
  });

  it('omits a member who hid their profile from the viewer', async () => {
    const { service } = buildService({
      ...seats,
      hiddenFromUserIds: [OUTSIDER_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, MEMBER_REFS);

    expect(nameBySlug(resolved)['rui-lopes']).toBeUndefined();
    expect(nameBySlug(resolved)['ana-sousa']).toBe('Ana Sousa');
  });

  it('omits a member a moderator took down', async () => {
    const { service } = buildService({ ...seats, takenDownUserIds: [ANA_ID] });

    const resolved = await service.resolve(VIEWER_ID, MEMBER_REFS);

    expect(nameBySlug(resolved)['ana-sousa']).toBeUndefined();
  });

  it('omits a member a moderator took down by slug', async () => {
    const { service } = buildService({
      ...seats,
      takenDownUserIds: ['ana-sousa'],
    });

    const resolved = await service.resolve(VIEWER_ID, MEMBER_REFS);

    expect(nameBySlug(resolved)['ana-sousa']).toBeUndefined();
    expect(nameBySlug(resolved)['rui-lopes']).toBe('Rui Lopes');
  });

  it('keeps naming the viewer when every other member is gated', async () => {
    const { service } = buildService({
      ...seats,
      blockedUserIds: [ANA_ID, OUTSIDER_ID],
    });

    const resolved = await service.resolve(VIEWER_ID, MEMBER_REFS);

    expect(nameBySlug(resolved)).toEqual({ 'viv-self': 'Viv Self' });
  });

  it('keeps the name of a private-tier profile, whose limited card names the member', async () => {
    const { service } = buildService(seats);

    const resolved = await service.resolve(VIEWER_ID, ['member:ana-sousa']);

    expect(nameBySlug(resolved)).toEqual({ 'ana-sousa': 'Ana Sousa' });
  });

  it('skips the takedown lookup when no other member survives the gates', async () => {
    const { service, contentModeration } = buildService({
      ...seats,
      blockedUserIds: [ANA_ID, OUTSIDER_ID],
    });

    await service.resolve(VIEWER_ID, MEMBER_REFS);

    expect(contentModeration.statesForAnyType).not.toHaveBeenCalled();
  });
});

describe('MentionNameResolveService, event mentions', () => {
  // An `e/slug` names a gathering only to a viewer who could open its page:
  // the real `EventAudienceGateService` runs over fakes that honour the
  // `where` filters, so the tier rules under test are the gate's own.
  const HOST_ID = 'host-1';
  const COHOST_ID = 'cohost-1';
  const INVITEE_ID = 'invitee-1';
  const COMMUNITY_MEMBER_ID = 'community-member-1';
  const STRANGER_ID = 'stranger-1';
  const COMMUNITY_ID = 'community-1';

  const eventRow = (
    id: string,
    slug: string,
    title: string,
    overrides: Partial<Event> = {},
  ) => ({
    id,
    slug,
    title,
    status: EventStatus.Published,
    visibility: EventVisibility.Public,
    hostId: HOST_ID,
    communityId: null,
    ...overrides,
  });
  const EVENT_ROWS = [
    eventRow('event-public', 'pride-picnic', 'Pride picnic'),
    eventRow('event-cancelled', 'rooftop-night', 'Rooftop night', {
      status: EventStatus.Cancelled,
      visibility: EventVisibility.Members,
    }),
    eventRow('event-draft', 'secret-draft', 'Secret draft', {
      status: EventStatus.Draft,
    }),
    eventRow('event-invite-only', 'supper-club', 'Supper club', {
      visibility: EventVisibility.InviteOnly,
    }),
    eventRow('event-community', 'book-circle', 'Book circle', {
      visibility: EventVisibility.Community,
      communityId: COMMUNITY_ID,
    }),
    eventRow('event-taken-down', 'late-rave', 'Late rave'),
  ];
  const INVITES = [{ eventId: 'event-invite-only', inviteeId: INVITEE_ID }];
  const COHOSTS = [{ eventId: 'event-taken-down', userId: COHOST_ID }];
  const TAKEN_DOWN_EVENT_IDS = ['event-taken-down'];

  /** Honours the equality, `In` and `Not` filters the service and the gate
   *  send; any other operator matches nothing, so a new filter shows up as a
   *  failing case. */
  function matchesWhere(
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (expected instanceof FindOperator) {
        const operand: unknown = expected.value;
        if (expected.type === 'in') {
          return (operand as unknown[]).includes(row[key]);
        }
        if (expected.type === 'not') return row[key] !== operand;
        return false;
      }
      return row[key] === expected;
    });
  }

  function fakeRepository(rows: Record<string, unknown>[]) {
    return {
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((row) => matchesWhere(row, where))),
      ),
    };
  }

  function buildEventService() {
    const events = fakeRepository(EVENT_ROWS);
    const invites = fakeRepository(INVITES);
    const rsvps = fakeRepository([]);
    const cohosts = fakeRepository(COHOSTS);
    const contentModeration = {
      statesForAnyType: jest.fn((types: string[], subjectIds: string[]) =>
        Promise.resolve(
          new Map(
            types.includes('event')
              ? subjectIds
                  .filter((id) => TAKEN_DOWN_EVENT_IDS.includes(id))
                  .map((id) => [id, { hidden: true, removed: false }])
              : [],
          ),
        ),
      ),
    };
    const audienceGate = new EventAudienceGateService(
      invites as unknown as Repository<EventInvite>,
      rsvps as unknown as Repository<EventRsvp>,
      cohosts as unknown as Repository<EventCohost>,
      {
        allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
        mutualCountsByUserIds: jest.fn().mockResolvedValue(new Map()),
      } as unknown as ConnectionsService,
      {
        effectiveCommunityIdsForUser: jest.fn((userId: string) =>
          Promise.resolve(userId === COMMUNITY_MEMBER_ID ? [COMMUNITY_ID] : []),
        ),
      } as unknown as CommunityMembershipService,
      { find: jest.fn() } as unknown as Repository<CommunityMember>,
      { findOne: jest.fn() } as unknown as Repository<Community>,
    );
    const empty = { find: jest.fn().mockResolvedValue([]) };
    const service = new MentionNameResolveService(
      empty as unknown as Repository<Profile>,
      empty as unknown as Repository<Community>,
      empty as unknown as Repository<CommunityMember>,
      empty as unknown as Repository<Listing>,
      events as unknown as Repository<Event>,
      empty as unknown as Repository<ForumThread>,
      empty as unknown as Repository<Conversation>,
      empty as unknown as Repository<ConversationParticipant>,
      {} as BlockFilterService,
      {} as HiddenFromService,
      contentModeration as unknown as ContentModerationService,
      cohosts as unknown as Repository<EventCohost>,
      audienceGate,
    );
    return { service, events, invites, cohosts, contentModeration };
  }

  async function namedEvents(
    viewerId: string,
    slugs: string[],
  ): Promise<Record<string, string>> {
    const { service } = buildEventService();
    return nameBySlug(
      await service.resolve(
        viewerId,
        slugs.map((slug) => `event:${slug}`),
      ),
    );
  }

  it('names a published and a cancelled open gathering to anyone and leaves a draft raw, its host included', async () => {
    const slugs = ['pride-picnic', 'rooftop-night', 'secret-draft'];
    const expected = {
      'pride-picnic': 'Pride picnic',
      'rooftop-night': 'Rooftop night',
    };

    expect(await namedEvents(STRANGER_ID, slugs)).toEqual(expected);
    expect(await namedEvents(HOST_ID, slugs)).toEqual(expected);
  });

  it('names an invite-only gathering to an invitee and its host and leaves it raw for a stranger', async () => {
    expect(await namedEvents(INVITEE_ID, ['supper-club'])).toEqual({
      'supper-club': 'Supper club',
    });
    expect(await namedEvents(HOST_ID, ['supper-club'])).toEqual({
      'supper-club': 'Supper club',
    });
    expect(await namedEvents(STRANGER_ID, ['supper-club'])).toEqual({});
  });

  it("names a community gathering to that community's members and leaves it raw for a stranger", async () => {
    expect(await namedEvents(COMMUNITY_MEMBER_ID, ['book-circle'])).toEqual({
      'book-circle': 'Book circle',
    });
    expect(await namedEvents(STRANGER_ID, ['book-circle'])).toEqual({});
  });

  it('names a taken-down gathering to its host and co-host alone', async () => {
    expect(await namedEvents(HOST_ID, ['late-rave'])).toEqual({
      'late-rave': 'Late rave',
    });
    expect(await namedEvents(COHOST_ID, ['late-rave'])).toEqual({
      'late-rave': 'Late rave',
    });
    expect(await namedEvents(STRANGER_ID, ['late-rave'])).toEqual({});
    expect(await namedEvents(INVITEE_ID, ['late-rave'])).toEqual({});
  });

  it('reads a whole batch of event tags in one event query and one takedown lookup', async () => {
    const { service, events, invites, cohosts, contentModeration } =
      buildEventService();

    await service.resolve(
      STRANGER_ID,
      EVENT_ROWS.map((row) => `event:${row.slug}`),
    );

    expect(events.find).toHaveBeenCalledTimes(1);
    expect(invites.find).toHaveBeenCalledTimes(1);
    expect(contentModeration.statesForAnyType).toHaveBeenCalledTimes(1);
    expect(contentModeration.statesForAnyType).toHaveBeenCalledWith(
      ['event'],
      EVENT_ROWS.filter((row) => row.status !== EventStatus.Draft).map(
        (row) => row.id,
      ),
    );
    // The gate's organiser read, then the takedown exemption's co-host read.
    expect(cohosts.find).toHaveBeenCalledTimes(2);
  });
});
