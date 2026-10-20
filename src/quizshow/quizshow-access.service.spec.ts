import { NotFoundException } from '@nestjs/common';
import type { Event } from '../events/entities/event.entity';
import type { Profile } from '../users/entities/profile.entity';
import type { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import type { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowAccessService } from './quizshow-access.service';
import type { QuizshowScopeSource } from './quizshow-engine-types';
import { quizshowCodeOf } from './quizshow-errors';

const HOST_ID = 'host-user';
const COHOST_ID = 'cohost-user';
const MEMBER_ID = 'member-user';
const OWNER_ID = 'owner-user';
const GAME_ID = '6f1c2a4e-8b3d-4e5f-9a7b-1c2d3e4f5a6b';

interface Fixture {
  isBanned?: boolean;
  isBlocked?: boolean;
  organiserIds?: string[];
  canView?: boolean;
  activePlayerCount?: number;
  playerRow?: Partial<QuizshowPlayerRecord> | null;
  openSessionIds?: string[];
  isCohostPlayerRow?: boolean;
  userRow?: {
    id: string;
    restricted: boolean;
    restrictedUntil: Date | null;
  } | null;
  gameRow?: Partial<QuizshowQuizRecord> | null;
  profileRow?: Partial<Profile> | null;
}

function buildEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    slug: 'quiz-night',
    hostId: HOST_ID,
    formatDetails: null,
    ...overrides,
  } as Event;
}

function buildService(fixture: Fixture = {}) {
  const organiserIds = fixture.organiserIds ?? [HOST_ID, COHOST_ID];
  const events = { findOne: jest.fn().mockResolvedValue(buildEvent()) };
  const eventBans = {
    exists: jest.fn().mockResolvedValue(fixture.isBanned ?? false),
  };
  const users = {
    findOne: jest.fn().mockResolvedValue(fixture.userRow ?? null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const sessions = {
    find: jest
      .fn()
      .mockResolvedValue((fixture.openSessionIds ?? []).map((id) => ({ id }))),
  };
  const players = {
    exists: jest.fn().mockResolvedValue(fixture.isCohostPlayerRow ?? false),
    findOne: jest.fn().mockResolvedValue(fixture.playerRow ?? null),
    count: jest.fn().mockResolvedValue(fixture.activePlayerCount ?? 0),
  };
  const eventsService = {
    isOrganizer: jest.fn((_eventId: string, userId: string) =>
      Promise.resolve(organiserIds.includes(userId)),
    ),
    assertCanView: jest.fn((_event: Event, viewerId: string) => {
      if (fixture.canView === false) {
        return Promise.reject(new NotFoundException('Event not found'));
      }
      return Promise.resolve(organiserIds.includes(viewerId));
    }),
  };
  const blockFilter = {
    isBlockedEitherWay: jest.fn().mockResolvedValue(fixture.isBlocked ?? false),
  };
  const quizzes = {
    findOne: jest.fn().mockResolvedValue(fixture.gameRow ?? null),
  };
  const profiles = {
    findOne: jest.fn().mockResolvedValue(fixture.profileRow ?? null),
  };
  const service = new QuizshowAccessService(
    events as never,
    eventBans as never,
    users as never,
    sessions as never,
    players as never,
    eventsService as never,
    blockFilter as never,
    quizzes as never,
    profiles as never,
  );
  return {
    service,
    events,
    eventBans,
    users,
    sessions,
    players,
    eventsService,
    blockFilter,
    quizzes,
    profiles,
  };
}

const session = {
  id: 'session-1',
  startedByUserId: HOST_ID,
  attachedOrganiserUserIds: [] as string[],
};

function mayPlayInput(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    session,
    scope: { kind: 'event' as const, event: buildEvent() },
    userId,
    isRestricted: false,
    shouldCheckCapacity: true,
    ...overrides,
  };
}

const gameSession = {
  id: 'session-2',
  startedByUserId: OWNER_ID,
  attachedOrganiserUserIds: [] as string[],
};

function gameMayPlayInput(
  userId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    session: gameSession,
    scope: { kind: 'game' as const, gameId: GAME_ID, ownerUserId: OWNER_ID },
    userId,
    isRestricted: false,
    shouldCheckCapacity: true,
    ...overrides,
  };
}

function eventScopeSource(eventId: string | null): QuizshowScopeSource {
  return { kind: 'event', eventId, gameId: null, hostUserId: HOST_ID };
}

function gameScopeSource(hostUserId: string | null): QuizshowScopeSource {
  return { kind: 'game', eventId: null, gameId: GAME_ID, hostUserId };
}

async function codeOfRefusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return quizshowCodeOf(error);
  }
  return null;
}

describe('QuizshowAccessService', () => {
  it('answers 404 for an event the viewer cannot see', async () => {
    const { service } = buildService({ canView: false });
    expect(
      await codeOfRefusal(service.loadViewableEvent('quiz-night', MEMBER_ID)),
    ).toBe('quizshow_event_not_found');
    const { service: missingService, events } = buildService();
    events.findOne.mockResolvedValue(null);
    expect(
      await codeOfRefusal(missingService.loadViewableEvent('nope', MEMBER_ID)),
    ).toBe('quizshow_event_not_found');
  });

  it('refuses a viewer who is no organiser', async () => {
    const { service } = buildService();
    expect(
      await codeOfRefusal(service.assertOrganiser(buildEvent(), MEMBER_ID)),
    ).toBe('quizshow_not_organiser');
    await expect(
      service.assertOrganiser(buildEvent(), COHOST_ID),
    ).resolves.toBeUndefined();
  });

  it('finds a co-host playing an open session and ignores a finished one', async () => {
    const playing = buildService({
      openSessionIds: ['session-1'],
      isCohostPlayerRow: true,
    });
    expect(
      await playing.service.isCohostPlayingOpenSession('event-1', COHOST_ID),
    ).toBe(true);
    expect(
      await codeOfRefusal(
        playing.service.assertNotCohostPlaying('event-1', COHOST_ID),
      ),
    ).toBe('quizshow_cohost_is_playing');
    const finished = buildService({
      openSessionIds: [],
      isCohostPlayerRow: true,
    });
    expect(
      await finished.service.isCohostPlayingOpenSession('event-1', COHOST_ID),
    ).toBe(false);
    expect(finished.players.exists).not.toHaveBeenCalled();
  });

  it('a co-host who joined as a player cannot read the quiz', async () => {
    const promoted = buildService({
      openSessionIds: ['session-1'],
      isCohostPlayerRow: true,
    });
    expect(
      await codeOfRefusal(
        promoted.service.assertNotCohostPlaying('event-1', COHOST_ID),
      ),
    ).toBe('quizshow_cohost_is_playing');
    // The row joined before the co-host invite, so its join-time flag is
    // false: the lookup matches any non-removed row of this organiser.
    const [existsCall] = promoted.players.exists.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(existsCall?.[0].where).not.toHaveProperty('isCohostPlayer');
    expect(existsCall?.[0].where).toMatchObject({ userId: COHOST_ID });
  });

  it('bars a banned member and a member blocked either way with the host', async () => {
    const banned = buildService({ isBanned: true });
    expect(
      await banned.service.isBarredFromEvent(buildEvent(), MEMBER_ID),
    ).toBe(true);
    const blocked = buildService({ isBlocked: true });
    expect(
      await blocked.service.isBarredFromEvent(buildEvent(), MEMBER_ID),
    ).toBe(true);
    expect(blocked.blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
      HOST_ID,
      MEMBER_ID,
    );
    const organiser = buildService({ isBanned: true, isBlocked: true });
    expect(
      await organiser.service.isBarredFromEvent(buildEvent(), COHOST_ID),
    ).toBe(false);
    const clean = buildService();
    expect(await clean.service.isBarredFromEvent(buildEvent(), MEMBER_ID)).toBe(
      false,
    );
  });

  it('treats an event with no host as unblocked', async () => {
    const { service, blockFilter } = buildService({ isBlocked: true });
    const hostlessEvent = buildEvent({ hostId: null as never });
    expect(await service.isBarredFromEvent(hostlessEvent, MEMBER_ID)).toBe(
      false,
    );
    expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
  });

  it('lifts an expired restriction before deciding', async () => {
    const expired = buildService({
      userRow: {
        id: MEMBER_ID,
        restricted: true,
        restrictedUntil: new Date(Date.now() - 60_000),
      },
    });
    expect(await expired.service.isRestricted(MEMBER_ID)).toBe(false);
    expect(expired.users.update).toHaveBeenCalledTimes(1);
    const active = buildService({
      userRow: {
        id: MEMBER_ID,
        restricted: true,
        restrictedUntil: new Date(Date.now() + 3_600_000),
      },
    });
    expect(await active.service.isRestricted(MEMBER_ID)).toBe(true);
    expect(active.users.update).not.toHaveBeenCalled();
  });

  it('flags an adults only event from its format details', () => {
    const { service } = buildService();
    expect(
      service.isAdultsEvent({ formatDetails: { isAdultsOnly: true } }),
    ).toBe(true);
    expect(service.isAdultsEvent({ formatDetails: null })).toBe(false);
  });

  it('keeps the event order of refusals', async () => {
    const hiddenAndBanned = buildService({ canView: false, isBanned: true });
    expect(
      await codeOfRefusal(
        hiddenAndBanned.service.assertMayPlay(
          mayPlayInput(MEMBER_ID, { isRestricted: true }),
        ),
      ),
    ).toBe('quizshow_cannot_view_event');
    const bannedAndRemoved = buildService({
      isBanned: true,
      playerRow: { removedAt: new Date() },
    });
    expect(
      await codeOfRefusal(
        bannedAndRemoved.service.assertMayPlay(
          mayPlayInput(MEMBER_ID, { isRestricted: true }),
        ),
      ),
    ).toBe('quizshow_banned_from_event');
    expect(bannedAndRemoved.eventBans.exists).toHaveBeenCalledWith({
      where: { eventId: 'event-1', userId: MEMBER_ID },
    });
    // The event path refuses on the ban list before any block check with the host.
    expect(
      hiddenAndBanned.blockFilter.isBlockedEitherWay,
    ).not.toHaveBeenCalled();
    expect(
      bannedAndRemoved.blockFilter.isBlockedEitherWay,
    ).not.toHaveBeenCalled();
  });

  it('refuses in the documented order', async () => {
    const { service } = buildService({
      isBanned: true,
      playerRow: { removedAt: new Date() },
    });
    expect(
      await codeOfRefusal(
        service.assertMayPlay(mayPlayInput(MEMBER_ID, { isRestricted: true })),
      ),
    ).toBe('quizshow_banned_from_event');
    const restricted = buildService({ playerRow: { removedAt: new Date() } });
    expect(
      await codeOfRefusal(
        restricted.service.assertMayPlay(
          mayPlayInput(MEMBER_ID, { isRestricted: true }),
        ),
      ),
    ).toBe('ACCOUNT_RESTRICTED');
    const removed = buildService({ playerRow: { removedAt: new Date() } });
    expect(
      await codeOfRefusal(
        removed.service.assertMayPlay(mayPlayInput(MEMBER_ID)),
      ),
    ).toBe('quizshow_player_removed');
    const hidden = buildService({ canView: false });
    expect(
      await codeOfRefusal(
        hidden.service.assertMayPlay(mayPlayInput(MEMBER_ID)),
      ),
    ).toBe('quizshow_cannot_view_event');
  });

  it('refuses the host, the opener and a co-host who attached as host or screen', async () => {
    const { service } = buildService({
      organiserIds: [HOST_ID, COHOST_ID, 'opener-user', 'attached-user'],
    });
    const hostRefusal = await codeOfRefusal(
      service.assertMayPlay(mayPlayInput(HOST_ID)),
    );
    expect(hostRefusal).toBe('quizshow_organiser_running');
    const openerRefusal = await codeOfRefusal(
      service.assertMayPlay(
        mayPlayInput('opener-user', {
          session: { ...session, startedByUserId: 'opener-user' },
        }),
      ),
    );
    expect(openerRefusal).toBe('quizshow_organiser_running');
    const attachedRefusal = await codeOfRefusal(
      service.assertMayPlay(
        mayPlayInput('attached-user', {
          session: { ...session, attachedOrganiserUserIds: ['attached-user'] },
        }),
      ),
    );
    expect(attachedRefusal).toBe('quizshow_organiser_running');
  });

  it('lets a co-host who is not running the game play', async () => {
    const { service } = buildService();
    await expect(
      service.assertMayPlay(mayPlayInput(COHOST_ID)),
    ).resolves.toEqual({ existingPlayer: null, isCohost: true });
    await expect(
      service.assertMayPlay(mayPlayInput(MEMBER_ID)),
    ).resolves.toEqual({ existingPlayer: null, isCohost: false });
  });

  it('refuses the 151st player and lets an existing player back in', async () => {
    const full = buildService({ activePlayerCount: 150 });
    expect(
      await codeOfRefusal(full.service.assertMayPlay(mayPlayInput(MEMBER_ID))),
    ).toBe('quizshow_session_full');
    const belowCap = buildService({ activePlayerCount: 149 });
    await expect(
      belowCap.service.assertMayPlay(mayPlayInput(MEMBER_ID)),
    ).resolves.toEqual({ existingPlayer: null, isCohost: false });
    const existingRow = { id: 'player-1', removedAt: null };
    const returning = buildService({
      activePlayerCount: 150,
      playerRow: existingRow,
    });
    const result = await returning.service.assertMayPlay(
      mayPlayInput(MEMBER_ID),
    );
    expect(result.existingPlayer).toBe(existingRow);
    const unchecked = buildService({ activePlayerCount: 150 });
    await expect(
      unchecked.service.assertMayPlay(
        mayPlayInput(MEMBER_ID, { shouldCheckCapacity: false }),
      ),
    ).resolves.toEqual({ existingPlayer: null, isCohost: false });
  });

  it('lets any active member play a game with no view or ban check', async () => {
    const { service, eventsService, eventBans, blockFilter } = buildService();
    await expect(
      service.assertMayPlay(gameMayPlayInput(MEMBER_ID)),
    ).resolves.toEqual({ existingPlayer: null, isCohost: false });
    expect(eventsService.assertCanView).not.toHaveBeenCalled();
    expect(eventBans.exists).not.toHaveBeenCalled();
    expect(eventsService.isOrganizer).not.toHaveBeenCalled();
    expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
      OWNER_ID,
      MEMBER_ID,
    );
  });

  it('refuses a game player blocked by the owner, or who blocked the owner, with banned from event', async () => {
    const blocked = buildService({ isBlocked: true });
    expect(
      await codeOfRefusal(
        blocked.service.assertMayPlay(gameMayPlayInput(MEMBER_ID)),
      ),
    ).toBe('quizshow_banned_from_event');
    expect(blocked.blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
      OWNER_ID,
      MEMBER_ID,
    );
    expect(blocked.players.findOne).not.toHaveBeenCalled();
    const restrictedAndBlocked = buildService({ isBlocked: true });
    expect(
      await codeOfRefusal(
        restrictedAndBlocked.service.assertMayPlay(
          gameMayPlayInput(MEMBER_ID, { isRestricted: true }),
        ),
      ),
    ).toBe('ACCOUNT_RESTRICTED');
    const blockedAndRemoved = buildService({
      isBlocked: true,
      playerRow: { removedAt: new Date() },
    });
    expect(
      await codeOfRefusal(
        blockedAndRemoved.service.assertMayPlay(gameMayPlayInput(MEMBER_ID)),
      ),
    ).toBe('quizshow_banned_from_event');
    const removed = buildService({ playerRow: { removedAt: new Date() } });
    expect(
      await codeOfRefusal(
        removed.service.assertMayPlay(gameMayPlayInput(MEMBER_ID)),
      ),
    ).toBe('quizshow_player_removed');
  });

  it('refuses the owner, the opener and an attached organiser of a game with organiser running', async () => {
    const { service } = buildService();
    expect(
      await codeOfRefusal(
        service.assertMayPlay(
          gameMayPlayInput(OWNER_ID, {
            session: { ...gameSession, startedByUserId: 'someone-else' },
          }),
        ),
      ),
    ).toBe('quizshow_organiser_running');
    expect(
      await codeOfRefusal(
        service.assertMayPlay(
          gameMayPlayInput('opener-user', {
            session: { ...gameSession, startedByUserId: 'opener-user' },
          }),
        ),
      ),
    ).toBe('quizshow_organiser_running');
    expect(
      await codeOfRefusal(
        service.assertMayPlay(
          gameMayPlayInput('attached-user', {
            session: {
              ...gameSession,
              attachedOrganiserUserIds: ['attached-user'],
            },
          }),
        ),
      ),
    ).toBe('quizshow_organiser_running');
  });

  it('applies the game capacity and lets an existing game player back in', async () => {
    const full = buildService({ activePlayerCount: 150 });
    expect(
      await codeOfRefusal(
        full.service.assertMayPlay(gameMayPlayInput(MEMBER_ID)),
      ),
    ).toBe('quizshow_session_full');
    const existingRow = { id: 'player-2', removedAt: null };
    const returning = buildService({
      activePlayerCount: 150,
      playerRow: existingRow,
    });
    await expect(
      returning.service.assertMayPlay(gameMayPlayInput(MEMBER_ID)),
    ).resolves.toEqual({ existingPlayer: existingRow, isCohost: false });
  });

  it('treats only the owner as organiser of a game and asks EventsService for an event', async () => {
    const { service, eventsService } = buildService();
    expect(
      await service.isScopeOrganiser(gameScopeSource(OWNER_ID), OWNER_ID),
    ).toBe(true);
    expect(
      await service.isScopeOrganiser(gameScopeSource(OWNER_ID), COHOST_ID),
    ).toBe(false);
    expect(
      await service.isScopeOrganiser(gameScopeSource(null), MEMBER_ID),
    ).toBe(false);
    expect(eventsService.isOrganizer).not.toHaveBeenCalled();

    expect(
      await service.isScopeOrganiser(eventScopeSource('event-1'), COHOST_ID),
    ).toBe(true);
    expect(
      await service.isScopeOrganiser(eventScopeSource('event-1'), MEMBER_ID),
    ).toBe(false);
    expect(eventsService.isOrganizer).toHaveBeenCalledWith(
      'event-1',
      COHOST_ID,
    );
    expect(eventsService.isOrganizer).toHaveBeenCalledWith(
      'event-1',
      MEMBER_ID,
    );
  });

  it("loads the caller's own game by id and owner", async () => {
    const gameRow = { id: GAME_ID, ownerUserId: OWNER_ID, title: 'Trivia' };
    const { service, quizzes } = buildService({ gameRow });
    await expect(service.loadOwnedGame(GAME_ID, OWNER_ID)).resolves.toBe(
      gameRow,
    );
    expect(quizzes.findOne).toHaveBeenCalledWith({
      where: { id: GAME_ID, ownerUserId: OWNER_ID },
    });

    const transactionRepository = {
      findOne: jest.fn().mockResolvedValue(gameRow),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue(transactionRepository),
    };
    const fresh = buildService({ gameRow: null });
    await expect(
      fresh.service.loadOwnedGame(GAME_ID, OWNER_ID, manager as never),
    ).resolves.toBe(gameRow);
    expect(transactionRepository.findOne).toHaveBeenCalledWith({
      where: { id: GAME_ID, ownerUserId: OWNER_ID },
    });
    expect(fresh.quizzes.findOne).not.toHaveBeenCalled();
  });

  it("answers game not found for another member's game and for a malformed id without a query", async () => {
    const otherMember = buildService({ gameRow: null });
    expect(
      await codeOfRefusal(
        otherMember.service.loadOwnedGame(GAME_ID, MEMBER_ID),
      ),
    ).toBe('quizshow_game_not_found');
    expect(otherMember.quizzes.findOne).toHaveBeenCalledWith({
      where: { id: GAME_ID, ownerUserId: MEMBER_ID },
    });

    const malformed = buildService({
      gameRow: { id: GAME_ID, ownerUserId: OWNER_ID },
    });
    for (const badId of ['not-a-uuid', '', `${GAME_ID}x`, "1' OR '1'='1"]) {
      expect(
        await codeOfRefusal(malformed.service.loadOwnedGame(badId, OWNER_ID)),
      ).toBe('quizshow_game_not_found');
    }
    expect(malformed.quizzes.findOne).not.toHaveBeenCalled();
  });

  it("builds the join host from the owner's name, visible photo and slug", async () => {
    const { service, profiles } = buildService({
      profileRow: {
        slug: 'river-owner',
        firstName: 'River',
        lastName: 'Lopes',
        avatarUrl: 'https://images.example.com/river.jpg',
        photoVisible: true,
      },
    });
    await expect(service.loadJoinHost(OWNER_ID)).resolves.toEqual({
      name: 'River Lopes',
      avatarUrl: 'https://images.example.com/river.jpg',
      memberSlug: 'river-owner',
    });
    expect(profiles.findOne).toHaveBeenCalledWith({
      where: { userId: OWNER_ID },
      select: {
        slug: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        photoVisible: true,
      },
    });
    const missing = buildService({ profileRow: null });
    await expect(missing.service.loadJoinHost(OWNER_ID)).resolves.toBeNull();
  });

  it('sends a null avatar when the owner hides their photo', async () => {
    const { service } = buildService({
      profileRow: {
        slug: 'river-owner',
        firstName: 'River',
        lastName: '',
        avatarUrl: 'https://images.example.com/river.jpg',
        photoVisible: false,
      },
    });
    await expect(service.loadJoinHost(OWNER_ID)).resolves.toEqual({
      name: 'River',
      avatarUrl: null,
      memberSlug: 'river-owner',
    });
  });

  it('loads no play scope for an event session whose event is gone', async () => {
    const { service, events } = buildService();
    events.findOne.mockResolvedValue(null);
    await expect(
      service.loadPlayScope(eventScopeSource('event-1')),
    ).resolves.toBeNull();
    expect(events.findOne).toHaveBeenCalledWith({ where: { id: 'event-1' } });
    await expect(service.loadPlayScope(eventScopeSource(null))).resolves.toBe(
      null,
    );

    const present = buildService();
    await expect(
      present.service.loadPlayScope(eventScopeSource('event-1')),
    ).resolves.toEqual({ kind: 'event', event: buildEvent() });
  });

  it('loads a game play scope from the game id and owner, and none without an owner', async () => {
    const { service, events } = buildService();
    await expect(
      service.loadPlayScope(gameScopeSource(OWNER_ID)),
    ).resolves.toEqual({
      kind: 'game',
      gameId: GAME_ID,
      ownerUserId: OWNER_ID,
    });
    await expect(
      service.loadPlayScope(gameScopeSource(null)),
    ).resolves.toBeNull();
    expect(events.findOne).not.toHaveBeenCalled();
  });
});
