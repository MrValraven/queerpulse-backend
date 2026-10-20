import type { QuizshowPlayMode } from './quizshow.contract';
import {
  activePlayers,
  advanceCursor,
  createLobbyState,
  eligiblePlayersNow,
  entrantTotals,
  isEligible,
  isJokerActiveFor,
  ownDeadline,
  recordAttachedOrganiser,
  refuse,
  setSessionStatus,
  toMe,
} from './quizshow-engine-state';
import type {
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
} from './quizshow-engine-types';
import type {
  QuizshowSessionSnapshot,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';

const STARTED_AT = 1_000;

function snapshotRound(roundId: string): QuizshowSnapshotRound {
  return {
    id: roundId,
    kind: 'quiz',
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    },
    questions: [
      {
        id: `${roundId}-question`,
        type: 'true_false',
        prompt: { en: 'Is it true?', pt: 'É verdade?' },
        mediaRef: null,
        mediaUrl: null,
        timeLimitSeconds: null,
        points: 1000,
        options: [],
        answer: { isTrue: true },
        acceptedAnswers: [],
        shownOptions: null,
      },
    ],
  };
}

const SNAPSHOT: QuizshowSessionSnapshot = {
  title: 'Pride night quiz',
  languages: 'both',
  screenLanguage: 'en',
  rounds: [snapshotRound('round-one'), snapshotRound('round-two')],
};

function lobbyState(playMode: QuizshowPlayMode = 'solo'): QuizshowLiveState {
  return createLobbyState({
    sessionId: 'session-1',
    eventId: 'event-1',
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    hostUserId: 'host-user',
    openedByUserId: 'host-user',
    joinCode: 'ABC234',
    playMode,
    maxTeamSize: null,
    isReviewOn: true,
    snapshot: SNAPSHOT,
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    startedAt: STARTED_AT,
  });
}

function livePlayer(
  playerId: string,
  overrides: Partial<QuizshowLivePlayer> = {},
): QuizshowLivePlayer {
  return {
    playerId,
    userId: `${playerId}-user`,
    screenName: `${playerId} name`,
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
  overrides: Partial<QuizshowLiveTeam> = {},
): QuizshowLiveTeam {
  return {
    teamId,
    name: `${teamId} name`,
    colorKey: 'circle',
    score: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    createdAt: STARTED_AT,
    ...overrides,
  };
}

function addPlayers(
  state: QuizshowLiveState,
  players: QuizshowLivePlayer[],
): void {
  for (const player of players) state.players.set(player.playerId, player);
}

function addTeams(state: QuizshowLiveState, teams: QuizshowLiveTeam[]): void {
  for (const team of teams) state.teams.set(team.teamId, team);
}

function questionPlay(
  eligiblePlayerIds: string[],
  extraTimePlayerIds: string[],
): QuizshowLiveQuestionPlay {
  return {
    questionId: 'round-one-question',
    roundIndex: 0,
    questionIndex: 0,
    openedAt: 2_000,
    eligiblePlayerIds: new Set(eligiblePlayerIds),
    extraTimePlayerIds: new Set(extraTimePlayerIds),
    answers: new Map(),
    votes: new Map(),
    voteOptions: null,
    favouriteOptionId: null,
    isScored: false,
    wasSkipped: false,
    pointsByPlayer: new Map(),
    teamPoints: new Map(),
  };
}

describe('Pulse Live engine state', () => {
  it('opens in the lobby with phase id 0', () => {
    const state = lobbyState();

    expect(state.status).toBe('lobby');
    expect(state.phaseCounter).toBe(0);
    expect(state.lastHostCommandAt).toBe(STARTED_AT);
    expect(state.isScreenMuted).toBe(false);
    expect(state.hasScoredQuestion).toBe(false);
    expect(state.lastTransition).toBeNull();
    expect(state.current).toBeNull();
    expect(state.podium).toBeNull();
    expect(state.players.size).toBe(0);
    expect(state.teams.size).toBe(0);
    expect(state.questionLog).toEqual([]);
    expect(state).not.toHaveProperty('startedAt');
    expect(state.cursor).toEqual({
      phaseId: '0',
      status: 'lobby',
      phase: 'lobby',
      roundIndex: null,
      questionIndex: null,
      roundCount: 2,
      phaseStartedAt: null,
      deadline: null,
      extraTimeDeadline: null,
      pausedRemainingMs: null,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
    });
  });

  it('counts phases and records the transition it came from', () => {
    const state = lobbyState();

    advanceCursor(state, {
      phase: 'round_intro',
      roundIndex: 0,
      questionIndex: null,
      now: 2_000,
      durationMs: null,
      extraTimeMs: null,
    });
    expect(state.cursor.phaseId).toBe('1');
    expect(state.lastTransition).toEqual({ fromPhaseId: '0', toPhaseId: '1' });

    advanceCursor(state, {
      phase: 'read',
      roundIndex: 0,
      questionIndex: 0,
      now: 3_000,
      durationMs: 4_000,
      extraTimeMs: null,
    });
    expect(state.cursor.phaseId).toBe('2');
    expect(state.phaseCounter).toBe(2);
    expect(state.lastTransition).toEqual({ fromPhaseId: '1', toPhaseId: '2' });
    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.roundIndex).toBe(0);
    expect(state.cursor.questionIndex).toBe(0);
  });

  it('sets the standard and the extra-time deadline from now', () => {
    const state = lobbyState();
    state.cursor.pausedRemainingMs = 5_000;
    state.cursor.pausedExtraTimeRemainingMs = 7_000;
    state.cursor.isRestartRecovery = true;

    advanceCursor(state, {
      phase: 'open',
      roundIndex: 0,
      questionIndex: 0,
      now: 1_000,
      durationMs: 20_000,
      extraTimeMs: 30_000,
    });

    expect(state.cursor.phaseStartedAt).toBe(1_000);
    expect(state.cursor.deadline).toBe(21_000);
    expect(state.cursor.extraTimeDeadline).toBe(31_000);
    expect(state.cursor.pausedRemainingMs).toBeNull();
    expect(state.cursor.pausedExtraTimeRemainingMs).toBeNull();
    expect(state.cursor.isRestartRecovery).toBe(false);

    advanceCursor(state, {
      phase: 'reveal',
      roundIndex: 0,
      questionIndex: 0,
      now: 40_000,
      durationMs: null,
      extraTimeMs: null,
    });

    expect(state.cursor.deadline).toBeNull();
    expect(state.cursor.extraTimeDeadline).toBeNull();
  });

  it('copies the session status into the cursor on every advance', () => {
    const state = lobbyState();
    state.status = 'running';

    advanceCursor(state, {
      phase: 'round_intro',
      roundIndex: 0,
      questionIndex: null,
      now: 2_000,
      durationMs: null,
      extraTimeMs: null,
    });
    expect(state.cursor.status).toBe('running');

    state.status = 'finished';
    advanceCursor(state, {
      phase: 'ended',
      roundIndex: null,
      questionIndex: null,
      now: 3_000,
      durationMs: null,
      extraTimeMs: null,
    });
    expect(state.cursor.status).toBe('finished');
  });

  it('sets the session status and the cursor status together', () => {
    const state = lobbyState();
    const phaseIdBefore = state.cursor.phaseId;

    setSessionStatus(state, 'paused');
    expect(state.status).toBe('paused');
    expect(state.cursor.status).toBe('paused');

    setSessionStatus(state, 'abandoned');
    expect(state.status).toBe('abandoned');
    expect(state.cursor.status).toBe('abandoned');
    expect(state.cursor.phaseId).toBe(phaseIdBefore);
    expect(state.phaseCounter).toBe(0);
  });

  it('judges a player with extra time against their own deadline', () => {
    const state = lobbyState();
    addPlayers(state, [
      livePlayer('player-extra', { hasExtraTime: true }),
      livePlayer('player-standard'),
      livePlayer('player-late', { joinedAt: 2_500 }),
    ]);
    state.current = questionPlay(
      ['player-extra', 'player-standard'],
      ['player-extra'],
    );
    advanceCursor(state, {
      phase: 'open',
      roundIndex: 0,
      questionIndex: 0,
      now: 1_000,
      durationMs: 20_000,
      extraTimeMs: 30_000,
    });

    expect(ownDeadline(state, 'player-extra')).toBe(31_000);
    expect(ownDeadline(state, 'player-standard')).toBe(21_000);
    expect(isEligible(state, 'player-standard')).toBe(true);
    expect(isEligible(state, 'player-late')).toBe(false);
    expect(eligiblePlayersNow(state).map((player) => player.playerId)).toEqual([
      'player-extra',
      'player-standard',
    ]);
  });

  it('applies a team joker to every member and a solo joker to its player', () => {
    const soloState = lobbyState('solo');
    addPlayers(soloState, [
      livePlayer('player-joker', { hasUsedJoker: true, jokerRoundIndex: 1 }),
      livePlayer('player-plain'),
    ]);

    expect(isJokerActiveFor(soloState, 'player-joker', 1)).toBe(true);
    expect(isJokerActiveFor(soloState, 'player-joker', 0)).toBe(false);
    expect(isJokerActiveFor(soloState, 'player-plain', 1)).toBe(false);

    const teamsState = lobbyState('teams');
    addTeams(teamsState, [
      liveTeam('team-joker', { hasUsedJoker: true, jokerRoundIndex: 1 }),
      liveTeam('team-plain', { colorKey: 'star' }),
    ]);
    addPlayers(teamsState, [
      livePlayer('member-one', { teamId: 'team-joker' }),
      livePlayer('member-two', { teamId: 'team-joker' }),
      livePlayer('member-other', {
        teamId: 'team-plain',
        hasUsedJoker: true,
        jokerRoundIndex: 1,
      }),
    ]);

    expect(isJokerActiveFor(teamsState, 'member-one', 1)).toBe(true);
    expect(isJokerActiveFor(teamsState, 'member-two', 1)).toBe(true);
    expect(isJokerActiveFor(teamsState, 'member-one', 0)).toBe(false);
    expect(isJokerActiveFor(teamsState, 'member-other', 1)).toBe(false);
  });

  it('lists entrants by team in teams mode', () => {
    const teamsState = lobbyState('teams');
    addTeams(teamsState, [
      liveTeam('team-later', {
        name: 'Later team',
        colorKey: 'moon',
        score: 300,
        createdAt: 3_000,
      }),
      liveTeam('team-first', {
        name: 'First team',
        colorKey: 'heart',
        score: 500,
        createdAt: 2_000,
      }),
    ]);
    addPlayers(teamsState, [
      livePlayer('member-one', { teamId: 'team-first', score: 500 }),
    ]);

    expect(entrantTotals(teamsState)).toEqual([
      {
        entrantId: 'team-first',
        kind: 'team',
        name: 'First team',
        colorKey: 'heart',
        score: 500,
      },
      {
        entrantId: 'team-later',
        kind: 'team',
        name: 'Later team',
        colorKey: 'moon',
        score: 300,
      },
    ]);

    const soloState = lobbyState('solo');
    addPlayers(soloState, [
      livePlayer('player-second', { score: 100, joinedAt: 3_000 }),
      livePlayer('player-removed', { removedAt: 4_000 }),
      livePlayer('player-first', { score: 200, joinedAt: 2_000 }),
    ]);

    expect(activePlayers(soloState).map((player) => player.playerId)).toEqual([
      'player-first',
      'player-second',
    ]);
    expect(entrantTotals(soloState)).toEqual([
      {
        entrantId: 'player-first',
        kind: 'player',
        name: 'player-first name',
        colorKey: null,
        score: 200,
      },
      {
        entrantId: 'player-second',
        kind: 'player',
        name: 'player-second name',
        colorKey: null,
        score: 100,
      },
    ]);
  });

  it("builds me with the team's joker in teams mode", () => {
    const teamsState = lobbyState('teams');
    addTeams(teamsState, [
      liveTeam('team-joker', { hasUsedJoker: true, jokerRoundIndex: 2 }),
    ]);
    addPlayers(teamsState, [
      livePlayer('member-one', {
        teamId: 'team-joker',
        isAvatarShown: true,
        hasExtraTime: true,
        score: 750,
        streak: 2,
      }),
    ]);

    expect(toMe(teamsState, 'member-one')).toEqual({
      playerId: 'member-one',
      screenName: 'member-one name',
      isAvatarShown: true,
      hasExtraTime: true,
      teamId: 'team-joker',
      isCohostPlayer: false,
      score: 750,
      streak: 2,
      hasUsedJoker: true,
      jokerRoundIndex: 2,
    });

    const soloState = lobbyState('solo');
    addPlayers(soloState, [
      livePlayer('player-joker', { hasUsedJoker: true, jokerRoundIndex: 0 }),
    ]);

    expect(toMe(soloState, 'player-joker')).toMatchObject({
      hasUsedJoker: true,
      jokerRoundIndex: 0,
    });
  });

  it('records an attached organiser once', () => {
    const state = lobbyState();

    const firstOutcome = recordAttachedOrganiser(state, 'organiser-user');
    const secondOutcome = recordAttachedOrganiser(state, 'organiser-user');

    expect(firstOutcome).toEqual({
      ok: true,
      success: {},
      effects: [
        {
          kind: 'persist',
          operation: {
            type: 'add_attached_organiser',
            userId: 'organiser-user',
          },
        },
      ],
    });
    expect(secondOutcome).toEqual({ ok: true, success: {}, effects: [] });
    expect([...state.attachedOrganiserUserIds]).toEqual(['organiser-user']);
  });

  it('refuses with a copy of the cursor only when asked', () => {
    const state = lobbyState();

    const withCursor = refuse('quizshow_stale_phase', state, true);
    const withoutCursor = refuse('quizshow_phase_closed', state, false);

    expect(withCursor.ok).toBe(false);
    expect(withCursor.effects).toEqual([]);
    if (withCursor.ok) throw new Error('Expected a refusal');
    expect(withCursor.failure.code).toBe('quizshow_stale_phase');
    expect(withCursor.failure.cursor).toEqual(state.cursor);
    expect(withCursor.failure.cursor).not.toBe(state.cursor);
    if (withoutCursor.ok) throw new Error('Expected a refusal');
    expect(withoutCursor.failure).not.toHaveProperty('cursor');
  });
});
