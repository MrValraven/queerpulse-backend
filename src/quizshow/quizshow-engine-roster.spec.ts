import { BLOCKED_TERMS } from '../common/blocked-terms';
import {
  QUIZSHOW_TEAM_COLOR_KEYS,
  type QuizshowAckFailure,
  type QuizshowPhase,
  type QuizshowPlayMode,
  type QuizshowTeamColorKey,
} from './quizshow.contract';
import {
  hostCreateTeams,
  hostMovePlayer,
  hostRenamePlayer,
} from './quizshow-engine-roster';
import { createLobbyState } from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLivePlayer,
  QuizshowLiveState,
  QuizshowLiveTeam,
} from './quizshow-engine-types';
import type { QuizshowRandom } from './quizshow-snapshot';

const LOBBY_OPENED_AT = 1_000;
const NOW = 5_000;

function at<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) throw new Error(`Nothing at index ${index}.`);
  return item;
}

const BLOCKED_WORD = at(BLOCKED_TERMS, 0);

/** Counter-based uuids in the uuid shape, so every run mints the same ids. */
function seededRandom(): QuizshowRandom {
  let uuidCounter = 0;
  return {
    uuid: () => {
      uuidCounter += 1;
      return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
    },
    integerBelow: (limit: number) => (uuidCounter * 7) % limit,
  };
}

function lobbyState(playMode: QuizshowPlayMode = 'teams'): QuizshowLiveState {
  return createLobbyState({
    sessionId: 'session-1',
    eventId: 'event-1',
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    kind: 'event',
    gameId: null,
    isAdultsOnly: false,
    hostUserId: 'host-user',
    openedByUserId: 'host-user',
    joinCode: 'ABC234',
    playMode,
    maxTeamSize: null,
    isReviewOn: true,
    isPractice: false,
    snapshot: {
      title: 'Pride night quiz',
      languages: 'both',
      screenLanguage: 'en',
      rounds: [],
      sourceUpdatedAt: '',
    },
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    startedAt: LOBBY_OPENED_AT,
  });
}

function addTeam(
  state: QuizshowLiveState,
  teamId: string,
  name: string,
  colorKey: QuizshowTeamColorKey,
  isHostMade = false,
): QuizshowLiveTeam {
  const team: QuizshowLiveTeam = {
    teamId,
    name,
    colorKey,
    score: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    createdAt: LOBBY_OPENED_AT,
    isHostMade,
  };
  state.teams.set(teamId, team);
  return team;
}

function addPlayer(
  state: QuizshowLiveState,
  playerId: string,
  screenName: string,
  teamId: string | null,
  overrides: Partial<QuizshowLivePlayer> = {},
): QuizshowLivePlayer {
  const player: QuizshowLivePlayer = {
    playerId,
    userId: `user-${playerId}`,
    screenName,
    teamId,
    isCohostPlayer: false,
    isAvatarShown: false,
    avatarUrl: null,
    hasExtraTime: false,
    score: 0,
    streak: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    joinedAt: LOBBY_OPENED_AT,
    removedAt: null,
    connectedSocketCount: 1,
    disconnectedAt: null,
    leftAt: null,
    ...overrides,
  };
  state.players.set(playerId, player);
  return player;
}

/** Puts a running session at `phase`; the roster commands read only the status and the phase. */
function runAt(state: QuizshowLiveState, phase: QuizshowPhase): void {
  state.status = 'running';
  state.cursor.status = 'running';
  state.cursor.phase = phase;
}

function refusalOf(
  outcome: QuizshowCommandOutcome<object>,
): QuizshowAckFailure {
  if (outcome.ok) throw new Error('Expected a refusal, the command acted.');
  expect(outcome.effects).toEqual([]);
  return outcome.failure;
}

function successOf<Success extends object>(
  outcome: QuizshowCommandOutcome<Success>,
): Success {
  if (!outcome.ok) {
    throw new Error(`Expected success, refused with ${outcome.failure.code}.`);
  }
  return outcome.success;
}

function effectKinds(effects: QuizshowEngineEffect[]): string[] {
  return effects.map((effect) =>
    effect.kind === 'persist'
      ? `persist ${effect.operation.type}`
      : effect.kind,
  );
}

describe('hostCreateTeams', () => {
  it('creates host-made teams with trimmed names, in input order, and ends on one checkpoint', () => {
    const state = lobbyState();
    const outcome = hostCreateTeams(
      state,
      ['  Table 1 ', 'Table 2'],
      NOW,
      seededRandom(),
    );
    const success = successOf(outcome);
    expect(success.isNoop).toBe(false);
    expect(success.teamIds).toHaveLength(2);
    const createdTeams = success.teamIds.map((teamId) =>
      state.teams.get(teamId),
    );
    expect(createdTeams.map((team) => team?.name)).toEqual([
      'Table 1',
      'Table 2',
    ]);
    expect(createdTeams.every((team) => team?.isHostMade === true)).toBe(true);
    expect(effectKinds(outcome.effects)).toEqual([
      'persist insert_team',
      'persist insert_team',
      'lobby_changed',
      'persist checkpoint',
    ]);
    expect(state.lastHostCommandAt).toBe(NOW);
  });

  it('creates nothing when one name is blocked', () => {
    const state = lobbyState();
    const outcome = hostCreateTeams(
      state,
      ['Table 1', `Table ${BLOCKED_WORD}`, 'Table 3'],
      NOW,
      seededRandom(),
    );
    expect(refusalOf(outcome).code).toBe('quizshow_text_blocked');
    expect(state.teams.size).toBe(0);
    expect(state.lastHostCommandAt).toBe(NOW);
  });

  it('refuses a blank name', () => {
    const state = lobbyState();
    const outcome = hostCreateTeams(
      state,
      ['Table 1', '   '],
      NOW,
      seededRandom(),
    );
    expect(refusalOf(outcome).code).toBe('quizshow_text_blank');
    expect(state.teams.size).toBe(0);
  });

  it('refuses 5 more teams over 20 and takes 4', () => {
    const state = lobbyState();
    for (const [teamIndex, colorKey] of QUIZSHOW_TEAM_COLOR_KEYS.slice(
      0,
      20,
    ).entries()) {
      addTeam(state, `team-${teamIndex}`, `Team ${teamIndex}`, colorKey);
    }
    const fiveNames = ['A', 'B', 'C', 'D', 'E'];
    expect(
      refusalOf(hostCreateTeams(state, fiveNames, NOW, seededRandom())).code,
    ).toBe('quizshow_team_limit');
    expect(state.teams.size).toBe(20);

    const success = successOf(
      hostCreateTeams(state, fiveNames.slice(0, 4), NOW, seededRandom()),
    );
    expect(success.teamIds).toHaveLength(4);
    expect(state.teams.size).toBe(24);
  });

  it('gives the first free colour keys in order, tier 2 keys included', () => {
    const state = lobbyState();
    const tierOneKeys = QUIZSHOW_TEAM_COLOR_KEYS.slice(0, 8);
    for (const [teamIndex, colorKey] of tierOneKeys.entries()) {
      if (colorKey === 'square') continue;
      addTeam(state, `team-${teamIndex}`, `Team ${teamIndex}`, colorKey);
    }
    addTeam(state, 'team-circle-2', 'Team circle two', 'circle_2');

    const success = successOf(
      hostCreateTeams(state, ['One', 'Two', 'Three'], NOW, seededRandom()),
    );
    expect(
      success.teamIds.map((teamId) => state.teams.get(teamId)?.colorKey),
    ).toEqual(['square', 'triangle_2', 'square_2']);
  });

  it('refuses names that fold to the same key within the batch', () => {
    const state = lobbyState();
    const outcome = hostCreateTeams(
      state,
      ['Mesa João', 'MESA  joao'],
      NOW,
      seededRandom(),
    );
    expect(refusalOf(outcome).code).toBe('quizshow_team_name_taken');
    expect(state.teams.size).toBe(0);
  });

  it('refuses a name an existing team holds', () => {
    const state = lobbyState();
    addTeam(state, 'team-1', 'Table 1', 'circle');
    const outcome = hostCreateTeams(
      state,
      ['Table 2', 'table 1'],
      NOW,
      seededRandom(),
    );
    expect(refusalOf(outcome).code).toBe('quizshow_team_name_taken');
    expect(state.teams.size).toBe(1);
  });

  it('refuses outside the lobby and in solo play', () => {
    const runningState = lobbyState();
    runAt(runningState, 'leaderboard');
    expect(
      refusalOf(hostCreateTeams(runningState, ['A'], NOW, seededRandom())).code,
    ).toBe('quizshow_not_in_lobby');

    const soloState = lobbyState('solo');
    expect(
      refusalOf(hostCreateTeams(soloState, ['A'], NOW, seededRandom())).code,
    ).toBe('quizshow_teams_off');
  });
});

describe('hostRenamePlayer', () => {
  it('renames an active player and announces the change', () => {
    const state = lobbyState();
    addPlayer(state, 'player-1', 'Alex', null);
    const outcome = hostRenamePlayer(state, 'player-1', '  Alexandra ', NOW);
    expect(successOf(outcome).isNoop).toBe(false);
    expect(state.players.get('player-1')?.screenName).toBe('Alexandra');
    expect(outcome.effects).toEqual([
      {
        kind: 'persist',
        operation: {
          type: 'update_player',
          playerId: 'player-1',
          fields: { screenName: 'Alexandra' },
        },
      },
      { kind: 'lobby_changed' },
      { kind: 'me_changed', playerIds: ['player-1'] },
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);
  });

  it('treats the same name as a no-op', () => {
    const state = lobbyState();
    addPlayer(state, 'player-1', 'Alex', null);
    const outcome = hostRenamePlayer(state, 'player-1', 'Alex ', NOW);
    expect(successOf(outcome).isNoop).toBe(true);
    expect(effectKinds(outcome.effects)).toEqual(['persist checkpoint']);
  });

  it('refuses a name another player holds and suggests a free one', () => {
    const state = lobbyState();
    addPlayer(state, 'player-1', 'Alex', null);
    addPlayer(state, 'player-2', 'Sam', null);
    const failure = refusalOf(hostRenamePlayer(state, 'player-2', 'Alex', NOW));
    expect(failure.code).toBe('quizshow_screen_name_taken');
    expect(failure.suggestedScreenName).toBe('Alex 2');
    expect(state.players.get('player-2')?.screenName).toBe('Sam');
  });

  it('names a left player and does not find a removed one', () => {
    const state = lobbyState();
    addPlayer(state, 'player-left', 'Lee', null, { leftAt: 2_000 });
    addPlayer(state, 'player-removed', 'Rui', null, { removedAt: 2_000 });
    expect(
      refusalOf(hostRenamePlayer(state, 'player-left', 'Lee two', NOW)).code,
    ).toBe('quizshow_player_left');
    expect(
      refusalOf(hostRenamePlayer(state, 'player-removed', 'Rui two', NOW)).code,
    ).toBe('quizshow_player_not_found');
    expect(
      refusalOf(hostRenamePlayer(state, 'player-unknown', 'Kim', NOW)).code,
    ).toBe('quizshow_player_not_found');
  });

  it('refuses blank and blocked names', () => {
    const state = lobbyState();
    addPlayer(state, 'player-1', 'Alex', null);
    expect(refusalOf(hostRenamePlayer(state, 'player-1', '  ', NOW)).code).toBe(
      'quizshow_text_blank',
    );
    expect(
      refusalOf(hostRenamePlayer(state, 'player-1', BLOCKED_WORD, NOW)).code,
    ).toBe('quizshow_text_blocked');
  });

  it('refuses once the session ended, naming the status', () => {
    const state = lobbyState();
    addPlayer(state, 'player-1', 'Alex', null);
    state.status = 'finished';
    expect(
      refusalOf(hostRenamePlayer(state, 'player-1', 'Alexandra', NOW)).code,
    ).toBe('quizshow_session_ended');
    expect(state.lastHostCommandAt).toBe(NOW);
  });
});

describe('hostMovePlayer', () => {
  it('refuses a move during an open question', () => {
    const state = lobbyState();
    addTeam(state, 'team-a', 'Team A', 'circle');
    addTeam(state, 'team-b', 'Team B', 'triangle');
    addPlayer(state, 'player-1', 'Alex', 'team-a');
    runAt(state, 'open');
    const failure = refusalOf(hostMovePlayer(state, 'player-1', 'team-b', NOW));
    expect(failure.code).toBe('quizshow_move_during_question');
    expect(state.players.get('player-1')?.teamId).toBe('team-a');
  });

  it.each<QuizshowPhase>(['reveal', 'scores'])(
    'refuses a move in %s, so a later rescore keeps the question points with the old team',
    (phase) => {
      const state = lobbyState();
      addTeam(state, 'team-a', 'Team A', 'circle');
      addTeam(state, 'team-b', 'Team B', 'triangle');
      addPlayer(state, 'player-1', 'Alex', 'team-a');
      runAt(state, phase);
      const outcome = hostMovePlayer(state, 'player-1', 'team-b', NOW);
      expect(refusalOf(outcome).code).toBe('quizshow_move_during_question');
      expect(state.players.get('player-1')?.teamId).toBe('team-a');
      expect(state.lastHostCommandAt).toBe(NOW);
    },
  );

  it('moves a player between questions and keeps both teams once the game runs', () => {
    const state = lobbyState();
    addTeam(state, 'team-a', 'Team A', 'circle').score = 300;
    addTeam(state, 'team-b', 'Team B', 'triangle');
    addPlayer(state, 'player-1', 'Alex', 'team-a');
    runAt(state, 'leaderboard');
    const outcome = hostMovePlayer(state, 'player-1', 'team-b', NOW);
    expect(successOf(outcome).isNoop).toBe(false);
    expect(state.players.get('player-1')?.teamId).toBe('team-b');
    expect(state.teams.get('team-a')?.score).toBe(300);
    expect(effectKinds(outcome.effects)).toEqual([
      'persist update_player',
      'lobby_changed',
      'me_changed',
      'persist checkpoint',
    ]);
  });

  it('in the lobby drops the emptied player-made team', () => {
    const state = lobbyState();
    addTeam(state, 'team-made-by-player', 'Team A', 'circle');
    addTeam(state, 'team-b', 'Team B', 'triangle');
    addPlayer(state, 'player-1', 'Alex', 'team-made-by-player');
    const outcome = hostMovePlayer(state, 'player-1', 'team-b', NOW);
    successOf(outcome);
    expect(state.teams.has('team-made-by-player')).toBe(false);
    expect(effectKinds(outcome.effects)).toEqual([
      'persist update_player',
      'persist delete_teams',
      'lobby_changed',
      'me_changed',
      'persist checkpoint',
    ]);
  });

  it('in the lobby keeps an emptied host-made team', () => {
    const state = lobbyState();
    addTeam(state, 'team-made-by-host', 'Table 1', 'circle', true);
    addTeam(state, 'team-b', 'Team B', 'triangle');
    addPlayer(state, 'player-1', 'Alex', 'team-made-by-host');
    successOf(hostMovePlayer(state, 'player-1', 'team-b', NOW));
    expect(state.teams.has('team-made-by-host')).toBe(true);
  });

  it('treats a move to the same team as a no-op', () => {
    const state = lobbyState();
    addTeam(state, 'team-a', 'Team A', 'circle');
    addPlayer(state, 'player-1', 'Alex', 'team-a');
    const outcome = hostMovePlayer(state, 'player-1', 'team-a', NOW);
    expect(successOf(outcome).isNoop).toBe(true);
    expect(effectKinds(outcome.effects)).toEqual(['persist checkpoint']);
  });

  it('refuses a full team, an unknown team, a left player and solo play', () => {
    const state = lobbyState();
    state.maxTeamSize = 1;
    addTeam(state, 'team-a', 'Team A', 'circle');
    addTeam(state, 'team-b', 'Team B', 'triangle');
    addPlayer(state, 'player-1', 'Alex', 'team-a');
    addPlayer(state, 'player-2', 'Sam', 'team-b');
    addPlayer(state, 'player-left', 'Lee', 'team-a', { leftAt: 2_000 });
    expect(
      refusalOf(hostMovePlayer(state, 'player-1', 'team-b', NOW)).code,
    ).toBe('quizshow_team_full');
    expect(
      refusalOf(hostMovePlayer(state, 'player-1', 'team-unknown', NOW)).code,
    ).toBe('quizshow_team_not_found');
    expect(
      refusalOf(hostMovePlayer(state, 'player-left', 'team-b', NOW)).code,
    ).toBe('quizshow_player_left');

    const soloState = lobbyState('solo');
    addPlayer(soloState, 'player-1', 'Alex', null);
    expect(
      refusalOf(hostMovePlayer(soloState, 'player-1', 'team-a', NOW)).code,
    ).toBe('quizshow_teams_off');
  });
});
