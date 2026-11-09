import {
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowPlayMode,
  type QuizshowWheelBonus,
  type QuizshowWheelPick,
} from './quizshow.contract';
import { createLobbyState } from './quizshow-engine-state';
import type {
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
} from './quizshow-engine-types';
import { applyWheelBonus } from './quizshow-engine-wheel';
import type {
  QuizshowSessionSnapshot,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';
import { createWheelState, emptyWheelProgress } from './quizshow-wheel';

const STARTED_AT = 1_000;

function snapshotRow(
  rowId: string,
  kind: 'quiz' | 'wheel',
  wheelBonus: QuizshowWheelBonus,
): QuizshowSnapshotRound {
  return {
    id: rowId,
    kind,
    title: { en: `Title ${rowId}`, pt: `Titulo ${rowId}` },
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
      ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
      wheelBonus,
    },
    questions: [],
  };
}

/** Row 0 is the wheel; rows 1 and 2 are its slices. */
function snapshotWith(sliceBonus: QuizshowWheelBonus): QuizshowSessionSnapshot {
  return {
    title: 'Pride night quiz',
    languages: 'both',
    screenLanguage: 'en',
    rounds: [
      snapshotRow('wheel-row', 'wheel', 0),
      snapshotRow('slice-one', 'quiz', 250),
      snapshotRow('slice-two', 'quiz', sliceBonus),
    ],
  };
}

function lobbyState(
  playMode: QuizshowPlayMode,
  sliceBonus: QuizshowWheelBonus,
): QuizshowLiveState {
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
    snapshot: snapshotWith(sliceBonus),
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    startedAt: STARTED_AT,
  });
}

function livePlayer(
  playerId: string,
  name: string,
  overrides: Partial<QuizshowLivePlayer> = {},
): QuizshowLivePlayer {
  return {
    playerId,
    userId: `${playerId}-user`,
    screenName: name,
    teamId: null,
    isCohostPlayer: false,
    isAvatarShown: false,
    avatarUrl: null,
    hasExtraTime: false,
    score: 0,
    streak: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    joinedAt: STARTED_AT,
    removedAt: null,
    connectedSocketCount: 1,
    ...overrides,
  };
}

function liveTeam(
  teamId: string,
  name: string,
  overrides: Partial<QuizshowLiveTeam> = {},
): QuizshowLiveTeam {
  return {
    teamId,
    name,
    colorKey: 'circle',
    score: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    createdAt: STARTED_AT,
    ...overrides,
  };
}

function questionPlay(
  pointsByPlayer: Record<string, number>,
  teamPoints: Record<string, number>,
): QuizshowLiveQuestionPlay {
  return {
    questionId: 'question-1',
    roundIndex: 2,
    questionIndex: 0,
    openedAt: STARTED_AT,
    eligiblePlayerIds: new Set<string>(),
    extraTimePlayerIds: new Set<string>(),
    answers: new Map(),
    votes: new Map(),
    voteOptions: null,
    favouriteOptionId: null,
    isScored: true,
    wasSkipped: false,
    pointsByPlayer: new Map(Object.entries(pointsByPlayer)),
    teamPoints: new Map(Object.entries(teamPoints)),
  };
}

function openWheel(
  state: QuizshowLiveState,
  pick: QuizshowWheelPick,
  baselineByEntrant: Record<string, number> | null,
): void {
  const wheel = createWheelState(state.snapshot.rounds, 0, [1, 2]);
  state.wheelProgress = {
    ...emptyWheelProgress(),
    wheel: { ...wheel, pick, playingRoundIndex: 2, baselineByEntrant },
  };
}

function soloState(
  sliceBonus: QuizshowWheelBonus,
  pick: QuizshowWheelPick,
  baselineByEntrant: Record<string, number> | null,
  players: QuizshowLivePlayer[],
): QuizshowLiveState {
  const state = lobbyState('solo', sliceBonus);
  for (const player of players) state.players.set(player.playerId, player);
  openWheel(state, pick, baselineByEntrant);
  return state;
}

describe('applyWheelBonus', () => {
  it('gives the round bonus to the best scorer since the baseline', () => {
    const state = soloState(500, 'round', { ana: 0, bea: 100 }, [
      livePlayer('ana', 'Ana', { score: 600 }),
      livePlayer('bea', 'Bea', { score: 300 }),
    ]);

    const result = applyWheelBonus(state, 2);

    expect(state.players.get('ana')?.score).toBe(1100);
    expect(state.players.get('bea')?.score).toBe(300);
    expect(result?.effects).toEqual([
      {
        kind: 'persist',
        operation: {
          type: 'save_wheel_bonus',
          players: [{ playerId: 'ana', score: 1100 }],
          teams: [],
        },
      },
      { kind: 'lobby_changed' },
      { kind: 'me_changed', playerIds: ['ana'] },
    ]);
    expect(result?.view).toEqual({
      points: 500,
      pick: 'round',
      sliceRoundIndex: 2,
      sliceTitle: { en: 'Title slice-two', pt: 'Titulo slice-two' },
      winners: [
        { entrantId: 'ana', kind: 'player', name: 'Ana', colorKey: null },
      ],
    });
  });

  it('gives every tied entrant the full bonus', () => {
    const state = soloState(500, 'round', { ana: 0, bea: 0 }, [
      livePlayer('ana', 'Ana', { score: 400 }),
      livePlayer('bea', 'Bea', { score: 400 }),
    ]);

    const result = applyWheelBonus(state, 2);

    expect(state.players.get('ana')?.score).toBe(900);
    expect(state.players.get('bea')?.score).toBe(900);
    expect(result?.effects[0]).toEqual({
      kind: 'persist',
      operation: {
        type: 'save_wheel_bonus',
        players: [
          { playerId: 'ana', score: 900 },
          { playerId: 'bea', score: 900 },
        ],
        teams: [],
      },
    });
    expect(result?.effects[2]).toEqual({
      kind: 'me_changed',
      playerIds: ['ana', 'bea'],
    });
  });

  it('awards nothing for a slice without a bonus', () => {
    const state = soloState(0, 'round', { ana: 0 }, [
      livePlayer('ana', 'Ana', { score: 600 }),
    ]);

    expect(applyWheelBonus(state, 2)).toBeNull();
    expect(state.players.get('ana')?.score).toBe(600);
  });

  it('awards nothing when the best is 0', () => {
    const state = soloState(500, 'round', { ana: 600, bea: 300 }, [
      livePlayer('ana', 'Ana', { score: 600 }),
      livePlayer('bea', 'Bea', { score: 300 }),
    ]);

    expect(applyWheelBonus(state, 2)).toBeNull();
    expect(state.players.get('ana')?.score).toBe(600);
    expect(state.players.get('bea')?.score).toBe(300);
  });

  it('gives the question bonus from the question points', () => {
    const state = soloState(250, 'question', null, [
      livePlayer('ana', 'Ana', { score: 2000 }),
      livePlayer('bea', 'Bea', { score: 1000 }),
    ]);
    state.current = questionPlay({ bea: 1000 }, {});

    const result = applyWheelBonus(state, 2);

    expect(state.players.get('bea')?.score).toBe(1250);
    expect(state.players.get('ana')?.score).toBe(2000);
    expect(result?.view.pick).toBe('question');
    expect(result?.view.winners).toEqual([
      { entrantId: 'bea', kind: 'player', name: 'Bea', colorKey: null },
    ]);
  });

  it('gives a team the bonus on the team score only', () => {
    const state = lobbyState('teams', 250);
    state.teams.set('teamA', liveTeam('teamA', 'Team A', { score: 900 }));
    state.teams.set(
      'teamB',
      liveTeam('teamB', 'Team B', { score: 500, createdAt: STARTED_AT + 1 }),
    );
    state.players.set(
      'ana',
      livePlayer('ana', 'Ana', { teamId: 'teamA', score: 600 }),
    );
    state.players.set(
      'bea',
      livePlayer('bea', 'Bea', { teamId: 'teamA', score: 300 }),
    );
    openWheel(state, 'question', null);
    state.current = questionPlay({}, { teamA: 800, teamB: 200 });

    const result = applyWheelBonus(state, 2);

    expect(state.teams.get('teamA')?.score).toBe(1150);
    expect(state.teams.get('teamB')?.score).toBe(500);
    expect(state.players.get('ana')?.score).toBe(600);
    expect(state.players.get('bea')?.score).toBe(300);
    expect(result?.effects).toEqual([
      {
        kind: 'persist',
        operation: {
          type: 'save_wheel_bonus',
          players: [],
          teams: [{ teamId: 'teamA', score: 1150 }],
        },
      },
      { kind: 'lobby_changed' },
    ]);
    expect(result?.view.winners).toEqual([
      { entrantId: 'teamA', kind: 'team', name: 'Team A', colorKey: 'circle' },
    ]);
  });

  it('leaves removed players out', () => {
    const state = soloState(500, 'round', { ana: 0, bea: 0 }, [
      livePlayer('ana', 'Ana', { score: 900, removedAt: STARTED_AT + 5 }),
      livePlayer('bea', 'Bea', { score: 300 }),
    ]);

    const result = applyWheelBonus(state, 2);

    expect(state.players.get('ana')?.score).toBe(900);
    expect(state.players.get('bea')?.score).toBe(800);
    expect(result?.view.winners.map((winner) => winner.entrantId)).toEqual([
      'bea',
    ]);
  });

  it('counts an entrant missing from the baseline from 0', () => {
    const state = soloState(500, 'round', { ana: 0 }, [
      livePlayer('ana', 'Ana', { score: 200 }),
      livePlayer('bea', 'Bea', { score: 300 }),
    ]);

    const result = applyWheelBonus(state, 2);

    expect(state.players.get('bea')?.score).toBe(800);
    expect(state.players.get('ana')?.score).toBe(200);
    expect(result?.view.winners.map((winner) => winner.entrantId)).toEqual([
      'bea',
    ]);
  });
});
