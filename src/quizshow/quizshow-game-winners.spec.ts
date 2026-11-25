import type { QuizshowStoredPodiumEntry } from './entities/quizshow-result.entity';
import type {
  QuizshowLivePlayer,
  QuizshowLiveState,
  QuizshowLiveTeam,
} from './quizshow-engine-types';
import {
  eventGameWinnersOf,
  shouldNumberEventGame,
} from './quizshow-game-winners';

type WinnerState = Pick<QuizshowLiveState, 'players' | 'teams'>;

function podiumEntry(
  place: 1 | 2 | 3,
  kind: 'player' | 'team',
  entrantId: string,
): QuizshowStoredPodiumEntry {
  return { place, kind, entrantId, score: 100 - place };
}

function member(
  key: string,
  overrides: Partial<QuizshowLivePlayer> = {},
): QuizshowLivePlayer {
  return {
    playerId: key,
    userId: `user-${key}`,
    screenName: `Player ${key}`,
    teamId: null,
    isCohostPlayer: false,
    joinedAt: Number(key.replace(/\D/g, '')) || 0,
    removedAt: null,
    leftAt: null,
    ...overrides,
  } as QuizshowLivePlayer;
}

function soloState(
  keys: string[],
  options: { cohost?: string[] } = {},
): WinnerState {
  const players = new Map<string, QuizshowLivePlayer>();
  for (const key of keys) {
    players.set(
      key,
      member(key, { isCohostPlayer: options.cohost?.includes(key) ?? false }),
    );
  }
  return { players, teams: new Map() };
}

function teamState(
  teamId: string,
  teamName: string,
  members: QuizshowLivePlayer[],
): WinnerState {
  const players = new Map<string, QuizshowLivePlayer>();
  for (const teamMember of members) {
    players.set(teamMember.playerId, { ...teamMember, teamId });
  }
  const team = { teamId, name: teamName } as QuizshowLiveTeam;
  return { players, teams: new Map([[teamId, team]]) };
}

describe('shouldNumberEventGame', () => {
  it('numbers an event game with a first place', () => {
    expect(
      shouldNumberEventGame({ kind: 'event', isPractice: false }, [
        podiumEntry(1, 'player', 'p1'),
      ]),
    ).toBe(true);
  });

  it.each([
    [{ kind: 'event', isPractice: true }, [podiumEntry(1, 'player', 'p1')]],
    [{ kind: 'game', isPractice: false }, [podiumEntry(1, 'player', 'p1')]],
    [{ kind: 'event', isPractice: false }, []],
    [{ kind: 'event', isPractice: false }, [podiumEntry(2, 'player', 'p1')]],
  ])('numbers nothing for %p with podium %p', (state, podium) => {
    expect(shouldNumberEventGame(state as never, podium)).toBe(false);
  });
});

describe('eventGameWinnersOf', () => {
  it('gives every tied first place a win', () => {
    expect(
      eventGameWinnersOf(soloState(['p1', 'p2', 'p3']), [
        podiumEntry(1, 'player', 'p1'),
        podiumEntry(1, 'player', 'p2'),
        podiumEntry(3, 'player', 'p3'),
      ]).map((winner) => winner.userId),
    ).toEqual(['user-p1', 'user-p2']);
  });

  it('gives nobody the win when a co-host player tops a solo podium', () => {
    expect(
      eventGameWinnersOf(soloState(['p1'], { cohost: ['p1'] }), [
        podiumEntry(1, 'player', 'p1'),
      ]),
    ).toEqual([]);
  });

  it('keeps a tied player beside a co-host on first place', () => {
    expect(
      eventGameWinnersOf(soloState(['p1', 'p2'], { cohost: ['p1'] }), [
        podiumEntry(1, 'player', 'p1'),
        podiumEntry(1, 'player', 'p2'),
      ]).map((winner) => winner.userId),
    ).toEqual(['user-p2']);
  });

  it('gives nobody the win when the podium player is missing from the state', () => {
    expect(
      eventGameWinnersOf(soloState(['p1']), [podiumEntry(1, 'player', 'p9')]),
    ).toEqual([]);
  });

  it('gives a winning team its active members with the team name', () => {
    const state = teamState('t1', 'Glitter Brains', [
      member('p1'),
      member('p2', { leftAt: 5 }),
      member('p3', { removedAt: 6 }),
      member('p4', { isCohostPlayer: true }),
      member('p5'),
    ]);
    expect(eventGameWinnersOf(state, [podiumEntry(1, 'team', 't1')])).toEqual([
      {
        userId: 'user-p1',
        screenName: 'Player p1',
        teamName: 'Glitter Brains',
      },
      {
        userId: 'user-p5',
        screenName: 'Player p5',
        teamName: 'Glitter Brains',
      },
    ]);
  });

  it('gives a solo winner a null team name', () => {
    expect(
      eventGameWinnersOf(soloState(['p1']), [podiumEntry(1, 'player', 'p1')]),
    ).toEqual([{ userId: 'user-p1', screenName: 'Player p1', teamName: null }]);
  });

  it('lists a member once', () => {
    const players = new Map<string, QuizshowLivePlayer>([
      ['p1', member('p1', { teamId: 't1' })],
    ]);
    const state: WinnerState = {
      players,
      teams: new Map([
        ['t1', { teamId: 't1', name: 'Duo' } as QuizshowLiveTeam],
      ]),
    };
    const winners = eventGameWinnersOf(state, [
      podiumEntry(1, 'player', 'p1'),
      podiumEntry(1, 'team', 't1'),
    ]);
    expect(winners).toEqual([
      { userId: 'user-p1', screenName: 'Player p1', teamName: null },
    ]);
  });

  it('leaves the team name null when the team is missing', () => {
    const players = new Map<string, QuizshowLivePlayer>([
      ['p1', member('p1', { teamId: 't9' })],
    ]);
    expect(
      eventGameWinnersOf({ players, teams: new Map() }, [
        podiumEntry(1, 'team', 't9'),
      ]),
    ).toEqual([{ userId: 'user-p1', screenName: 'Player p1', teamName: null }]);
  });

  it('orders team members by joined order', () => {
    const state = teamState('t1', 'Duo', [
      member('p2', { joinedAt: 20 }),
      member('p1', { joinedAt: 10 }),
    ]);
    expect(
      eventGameWinnersOf(state, [podiumEntry(1, 'team', 't1')]).map(
        (winner) => winner.userId,
      ),
    ).toEqual(['user-p1', 'user-p2']);
  });
});
