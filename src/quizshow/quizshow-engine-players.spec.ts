import { BLOCKED_TERMS } from '../common/blocked-terms';
import type {
  QuizshowAckFailure,
  QuizshowAnswerPayload,
  QuizshowMe,
  QuizshowMyAnswer,
  QuizshowMyVote,
  QuizshowPhase,
  QuizshowPlayMode,
  QuizshowRoundKind,
  QuizshowRoundSettings,
} from './quizshow.contract';
import {
  createTeam,
  joinLobby,
  pickTeam,
  playJoker,
  setAvatarShown,
  setExtraTime,
  setScreenName,
  submitAnswer,
  submitVote,
  type QuizshowJoinLobbyInput,
} from './quizshow-engine-players';
import {
  activePlayers,
  advanceCursor,
  createLobbyState,
  isEligible,
  setSessionStatus,
  toMe,
} from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLiveState,
} from './quizshow-engine-types';
import { QUIZSHOW_FAKE_TOO_CLOSE_MESSAGE } from './quizshow-errors';
import {
  extraTimeMs,
  openLimitMs,
  voteLimitMs,
  writeLimitMs,
  type QuizshowRandom,
  type QuizshowSnapshotQuestion,
  type QuizshowSnapshotRound,
} from './quizshow-snapshot';

const LOBBY_OPENED_AT = 1_000;

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

const ROUND_SETTINGS: QuizshowRoundSettings = {
  timeLimitSeconds: 20,
  isSpeedBonusOn: true,
  isJokerAllowed: true,
  writeSeconds: 60,
  voteSeconds: 30,
};

const QUESTION_BASE = {
  prompt: { en: 'Question', pt: 'Pergunta' },
  mediaRef: null,
  mediaUrl: null,
  timeLimitSeconds: null,
  points: 1000,
};

function trueFalseQuestion(questionId: string): QuizshowSnapshotQuestion {
  return {
    ...QUESTION_BASE,
    id: questionId,
    type: 'true_false',
    options: [],
    answer: { isTrue: true },
    acceptedAnswers: [],
    shownOptions: null,
  };
}

function multipleChoiceQuestion(questionId: string): QuizshowSnapshotQuestion {
  const options = ['a', 'b', 'c', 'd'].map((optionId) => ({
    id: optionId,
    text: { en: `Option ${optionId}`, pt: `Opção ${optionId}` },
  }));
  return {
    ...QUESTION_BASE,
    id: questionId,
    type: 'multiple_choice',
    options,
    answer: { correctIndex: 1 },
    acceptedAnswers: [],
    shownOptions: options,
  };
}

function orderQuestion(questionId: string): QuizshowSnapshotQuestion {
  const options = ['x', 'y', 'z'].map((optionId) => ({
    id: optionId,
    text: { en: `Item ${optionId}`, pt: `Item ${optionId}` },
  }));
  return {
    ...QUESTION_BASE,
    id: questionId,
    type: 'order',
    options,
    answer: { orderedIds: ['x', 'y', 'z'] },
    acceptedAnswers: [],
    shownOptions: [at(options, 1), at(options, 2), at(options, 0)],
  };
}

function closestNumberQuestion(questionId: string): QuizshowSnapshotQuestion {
  return {
    ...QUESTION_BASE,
    id: questionId,
    type: 'closest_number',
    options: [],
    answer: { value: 1969 },
    acceptedAnswers: [],
    shownOptions: null,
  };
}

function promptQuestion(
  questionId: string,
  truth: { en: string; pt: string } | null,
): QuizshowSnapshotQuestion {
  return {
    ...QUESTION_BASE,
    id: questionId,
    type: 'prompt',
    options: [],
    answer: truth === null ? null : { truth },
    acceptedAnswers: [],
    shownOptions: null,
  };
}

function snapshotRound(
  kind: QuizshowRoundKind,
  questions: QuizshowSnapshotQuestion[],
  settings: Partial<QuizshowRoundSettings> = {},
): QuizshowSnapshotRound {
  return {
    id: `round-${questions.map((question) => question.id).join('-')}`,
    kind,
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel: 'none',
    settings: { ...ROUND_SETTINGS, ...settings },
    questions,
  };
}

function stateWithQuiz({
  playMode = 'solo',
  rounds,
  maxTeamSize = null,
}: {
  playMode?: QuizshowPlayMode;
  rounds: QuizshowSnapshotRound[];
  maxTeamSize?: number | null;
}): QuizshowLiveState {
  return createLobbyState({
    sessionId: 'session-1',
    eventId: 'event-1',
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    hostUserId: 'host-user',
    openedByUserId: 'host-user',
    joinCode: 'ABC234',
    playMode,
    maxTeamSize,
    isReviewOn: true,
    snapshot: {
      title: 'Pride night quiz',
      languages: 'both',
      screenLanguage: 'en',
      rounds,
    },
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    startedAt: LOBBY_OPENED_AT,
  });
}

function joinInput(
  userId: string,
  overrides: Partial<QuizshowJoinLobbyInput> = {},
): QuizshowJoinLobbyInput {
  return {
    userId,
    isCohostPlayer: false,
    avatarUrl: null,
    screenName: `${userId} name`,
    isAvatarShown: false,
    hasExtraTime: false,
    team: null,
    ...overrides,
  };
}

type AnyOutcome =
  { ok: true } | { ok: false; failure: QuizshowAckFailure; effects: [] };

function refusalOf(outcome: AnyOutcome): QuizshowAckFailure {
  if (outcome.ok) throw new Error('Expected a refusal, the command acted.');
  expect(outcome.effects).toEqual([]);
  return outcome.failure;
}

function refusalCode(outcome: AnyOutcome): string {
  return refusalOf(outcome).code;
}

function successOf<Success extends object>(
  outcome: QuizshowCommandOutcome<Success>,
): Success {
  if (!outcome.ok) {
    throw new Error(`Expected success, refused with ${outcome.failure.code}.`);
  }
  return outcome.success;
}

function effectsOf(
  outcome: QuizshowCommandOutcome<object>,
): QuizshowEngineEffect[] {
  return outcome.effects;
}

function effectKinds(effects: QuizshowEngineEffect[]): string[] {
  return effects.map((effect) =>
    effect.kind === 'persist'
      ? `persist ${effect.operation.type}`
      : effect.kind,
  );
}

function join(
  state: QuizshowLiveState,
  userId: string,
  now: number,
  random: QuizshowRandom,
  overrides: Partial<QuizshowJoinLobbyInput> = {},
): QuizshowMe {
  return successOf(joinLobby(state, joinInput(userId, overrides), now, random))
    .me;
}

/** What `host:start` leaves behind: a running session at round 0's intro. */
function startGame(state: QuizshowLiveState, now: number): void {
  state.status = 'running';
  advanceCursor(state, {
    phase: 'round_intro',
    roundIndex: 0,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
}

/**
 * Opens a question straight at its accepting phase (`open` for quiz rounds,
 * `write` for party rounds) with every active player eligible.
 */
function openQuestion(
  state: QuizshowLiveState,
  roundIndex: number,
  questionIndex: number,
  now: number,
): void {
  const round = at(state.snapshot.rounds, roundIndex);
  const question = at(round.questions, questionIndex);
  const eligiblePlayers = activePlayers(state);
  state.current = {
    questionId: question.id,
    roundIndex,
    questionIndex,
    openedAt: now,
    eligiblePlayerIds: new Set(
      eligiblePlayers.map((player) => player.playerId),
    ),
    extraTimePlayerIds: new Set(
      eligiblePlayers
        .filter((player) => player.hasExtraTime)
        .map((player) => player.playerId),
    ),
    answers: new Map(),
    votes: new Map(),
    voteOptions: null,
    favouriteOptionId: null,
    isScored: false,
    wasSkipped: false,
    pointsByPlayer: new Map(),
    teamPoints: new Map(),
  };
  const isParty = round.kind !== 'quiz';
  const limitMs = isParty ? writeLimitMs(round) : openLimitMs(round, question);
  state.status = 'running';
  advanceCursor(state, {
    phase: isParty ? 'write' : 'open',
    roundIndex,
    questionIndex,
    now,
    durationMs: limitMs,
    extraTimeMs: extraTimeMs(limitMs),
  });
}

/** Moves the current question to another phase; `vote` gets its own deadlines. */
function moveToPhase(
  state: QuizshowLiveState,
  phase: QuizshowPhase,
  now: number,
): void {
  const round = at(state.snapshot.rounds, state.cursor.roundIndex ?? 0);
  const limitMs = phase === 'vote' ? voteLimitMs(round) : null;
  advanceCursor(state, {
    phase,
    roundIndex: state.cursor.roundIndex,
    questionIndex: phase === 'leaderboard' ? null : state.cursor.questionIndex,
    now,
    durationMs: limitMs,
    extraTimeMs: limitMs === null ? null : extraTimeMs(limitMs),
  });
}

/** One vote option per stored answer, in joined order. */
function showVoteOptions(state: QuizshowLiveState, now: number): void {
  const current = state.current;
  if (current === null) throw new Error('No question in play.');
  moveToPhase(state, 'vote', now);
  current.voteOptions = [...current.answers.values()].map((answer) => ({
    optionId: `option-${answer.playerId}`,
    answerId: answer.answerId,
    authorPlayerId: answer.playerId,
    text: answer.payload.type === 'prompt' ? answer.payload.text : '',
    isTruth: false,
  }));
}

function answerNow(
  state: QuizshowLiveState,
  playerId: string,
  payload: QuizshowAnswerPayload,
  now: number,
  random: QuizshowRandom,
): QuizshowCommandOutcome<{ answer: QuizshowMyAnswer; isDuplicate: boolean }> {
  const questionId = state.current?.questionId ?? 'no-question';
  return submitAnswer(
    state,
    playerId,
    { phaseId: state.cursor.phaseId, questionId, payload },
    now,
    random,
  );
}

function voteNow(
  state: QuizshowLiveState,
  playerId: string,
  optionId: string,
  now: number,
): QuizshowCommandOutcome<{ vote: QuizshowMyVote; isDuplicate: boolean }> {
  const questionId = state.current?.questionId ?? 'no-question';
  return submitVote(
    state,
    playerId,
    { phaseId: state.cursor.phaseId, questionId, optionId },
    now,
  );
}

const TRUE_ANSWER: QuizshowAnswerPayload = { type: 'true_false', isTrue: true };

describe('Pulse Live engine, players', () => {
  it('creates a player with the trimmed name and returns the same row on a second join', () => {
    const state = stateWithQuiz({
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();

    const first = joinLobby(
      state,
      joinInput('user-a', {
        screenName: '  Alex  ',
        avatarUrl: 'https://cdn.example/alex.webp',
        isAvatarShown: true,
        hasExtraTime: true,
      }),
      2_000,
      random,
    );
    const firstMe = successOf(first).me;

    expect(firstMe).toEqual({
      playerId: firstMe.playerId,
      screenName: 'Alex',
      isAvatarShown: true,
      hasExtraTime: true,
      teamId: null,
      isCohostPlayer: false,
      score: 0,
      streak: 0,
      hasUsedJoker: false,
      jokerRoundIndex: null,
    });
    expect(JSON.stringify(firstMe)).not.toContain('user-a');
    expect(effectKinds(effectsOf(first))).toEqual([
      'persist insert_player',
      'lobby_changed',
    ]);
    const player = state.players.get(firstMe.playerId);
    expect(player?.userId).toBe('user-a');
    expect(player?.screenName).toBe('Alex');
    expect(player?.joinedAt).toBe(2_000);
    expect(player?.avatarUrl).toBe('https://cdn.example/alex.webp');

    const second = joinLobby(
      state,
      joinInput('user-a', { screenName: 'Someone else' }),
      3_000,
      random,
    );

    expect(second).toEqual({
      ok: true,
      success: { me: firstMe },
      effects: [],
    });
    expect(state.players.size).toBe(1);
  });

  it('refuses a blank name, a blocked name and a removed player', () => {
    const state = stateWithQuiz({
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();

    expect(
      refusalCode(
        joinLobby(
          state,
          joinInput('user-a', { screenName: '   ' }),
          2_000,
          random,
        ),
      ),
    ).toBe('quizshow_text_blank');
    expect(
      refusalCode(
        joinLobby(
          state,
          joinInput('user-a', { screenName: `Hi ${BLOCKED_WORD}` }),
          2_000,
          random,
        ),
      ),
    ).toBe('quizshow_text_blocked');
    expect(state.players.size).toBe(0);

    const me = join(state, 'user-a', 2_000, random);
    expect(refusalCode(setScreenName(state, me.playerId, '  ', 2_100))).toBe(
      'quizshow_text_blank',
    );
    expect(
      refusalCode(setScreenName(state, me.playerId, BLOCKED_WORD, 2_100)),
    ).toBe('quizshow_text_blocked');
    expect(
      refusalCode(setScreenName(state, 'unknown-player', 'Robin', 2_100)),
    ).toBe('quizshow_not_joined');

    const renamed = setScreenName(state, me.playerId, ' Robin ', 2_200);
    expect(successOf(renamed).me.screenName).toBe('Robin');
    expect(effectKinds(effectsOf(renamed))).toEqual([
      'persist update_player',
      'lobby_changed',
      'me_changed',
    ]);

    const player = state.players.get(me.playerId);
    if (player === undefined) throw new Error('The player was not stored.');
    player.removedAt = 3_000;

    expect(
      refusalCode(joinLobby(state, joinInput('user-a'), 4_000, random)),
    ).toBe('quizshow_player_removed');
    expect(refusalCode(setScreenName(state, me.playerId, 'Sam', 4_000))).toBe(
      'quizshow_player_removed',
    );
    expect(refusalCode(setExtraTime(state, me.playerId, true, 4_000))).toBe(
      'quizshow_player_removed',
    );
    expect(refusalCode(setAvatarShown(state, me.playerId, true, 4_000))).toBe(
      'quizshow_player_removed',
    );
    expect(refusalCode(playJoker(state, me.playerId, 0, 4_000))).toBe(
      'quizshow_player_removed',
    );
    expect(
      refusalCode(answerNow(state, me.playerId, TRUE_ANSWER, 4_000, random)),
    ).toBe('quizshow_player_removed');
    expect(refusalCode(voteNow(state, me.playerId, 'option-1', 4_000))).toBe(
      'quizshow_player_removed',
    );
  });

  it('refuses the 151st player', () => {
    const state = stateWithQuiz({
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();
    for (let index = 0; index < 150; index += 1) {
      join(state, `user-${index}`, 2_000 + index, random);
    }

    const refusal = refusalOf(
      joinLobby(state, joinInput('user-150'), 3_000, random),
    );

    expect(refusal.code).toBe('quizshow_session_full');
    expect(state.players.size).toBe(150);
  });

  it('requires a team in teams play and closes team creation after the start', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();

    expect(
      refusalCode(joinLobby(state, joinInput('user-a'), 2_000, random)),
    ).toBe('quizshow_team_required');

    const founded = joinLobby(
      state,
      joinInput('user-a', {
        team: { newTeam: { name: '  Glitter  ', colorKey: 'circle' } },
      }),
      2_000,
      random,
    );
    const founder = successOf(founded).me;
    expect(effectKinds(effectsOf(founded))).toEqual([
      'persist insert_team',
      'persist insert_player',
      'lobby_changed',
    ]);
    const teamId = founder.teamId;
    if (teamId === null) throw new Error('The founder has no team.');
    expect(state.teams.get(teamId)?.name).toBe('Glitter');
    expect(state.teams.get(teamId)?.colorKey).toBe('circle');

    const soloState = stateWithQuiz({
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const soloRefusal = refusalOf(
      joinLobby(
        soloState,
        joinInput('user-a', { team: { teamId } }),
        2_000,
        random,
      ),
    );
    expect(soloRefusal.code).toBe('quizshow_command_not_allowed');
    expect(soloRefusal.cursor).toEqual(soloState.cursor);
    const soloMe = join(soloState, 'user-a', 2_000, random);
    expect(
      refusalCode(pickTeam(soloState, soloMe.playerId, teamId, 2_100)),
    ).toBe('quizshow_command_not_allowed');

    startGame(state, 5_000);

    expect(
      refusalCode(
        joinLobby(
          state,
          joinInput('user-b', {
            team: { newTeam: { name: 'Sparkle', colorKey: 'triangle' } },
          }),
          6_000,
          random,
        ),
      ),
    ).toBe('quizshow_team_change_closed');
    const lateJoiner = join(state, 'user-b', 6_000, random, {
      team: { teamId },
    });
    expect(lateJoiner.teamId).toBe(teamId);
    expect(
      refusalCode(
        createTeam(
          state,
          founder.playerId,
          { name: 'Sparkle', colorKey: 'triangle' },
          6_100,
          random,
        ),
      ),
    ).toBe('quizshow_team_change_closed');
    expect(
      refusalCode(setScreenName(state, founder.playerId, 'New name', 6_100)),
    ).toBe('quizshow_team_change_closed');
    expect(refusalCode(pickTeam(state, founder.playerId, teamId, 6_100))).toBe(
      'quizshow_team_change_closed',
    );
    expect(state.teams.size).toBe(1);
  });

  it('keeps team names unique across case and colours unique per session', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      maxTeamSize: 2,
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();
    const founder = join(state, 'user-a', 2_000, random, {
      team: { newTeam: { name: 'Glitter', colorKey: 'circle' } },
    });
    const glitterTeamId = founder.teamId;
    if (glitterTeamId === null) throw new Error('The founder has no team.');

    expect(
      refusalCode(
        joinLobby(
          state,
          joinInput('user-b', {
            team: { newTeam: { name: ' gLITTER ', colorKey: 'triangle' } },
          }),
          2_100,
          random,
        ),
      ),
    ).toBe('quizshow_team_name_taken');
    expect(
      refusalCode(
        joinLobby(
          state,
          joinInput('user-b', {
            team: { newTeam: { name: 'Sparkle', colorKey: 'circle' } },
          }),
          2_100,
          random,
        ),
      ),
    ).toBe('quizshow_team_color_taken');
    expect(
      refusalCode(
        joinLobby(
          state,
          joinInput('user-b', { team: { teamId: 'missing-team' } }),
          2_100,
          random,
        ),
      ),
    ).toBe('quizshow_team_not_found');

    join(state, 'user-b', 2_200, random, { team: { teamId: glitterTeamId } });
    expect(
      refusalCode(
        joinLobby(
          state,
          joinInput('user-c', { team: { teamId: glitterTeamId } }),
          2_300,
          random,
        ),
      ),
    ).toBe('quizshow_team_full');

    const sparkleMember = join(state, 'user-c', 2_300, random, {
      team: { newTeam: { name: 'Sparkle', colorKey: 'triangle' } },
    });
    expect(
      refusalCode(
        createTeam(
          state,
          sparkleMember.playerId,
          { name: 'GLITTER', colorKey: 'square' },
          2_400,
          random,
        ),
      ),
    ).toBe('quizshow_team_name_taken');
    expect(
      refusalCode(
        createTeam(
          state,
          sparkleMember.playerId,
          { name: 'Disco', colorKey: 'triangle' },
          2_400,
          random,
        ),
      ),
    ).toBe('quizshow_team_color_taken');
    expect(
      refusalCode(
        pickTeam(state, sparkleMember.playerId, glitterTeamId, 2_400),
      ),
    ).toBe('quizshow_team_full');

    const created = createTeam(
      state,
      sparkleMember.playerId,
      { name: 'Disco', colorKey: 'square' },
      2_500,
      random,
    );
    const createdSuccess = successOf(created);
    expect(createdSuccess.me.teamId).toBe(createdSuccess.teamId);
    expect(effectKinds(effectsOf(created))).toEqual([
      'persist insert_team',
      'persist update_player',
      'lobby_changed',
      'me_changed',
    ]);

    const remainingColorKeys = [
      'diamond',
      'star',
      'hexagon',
      'heart',
      'moon',
    ] as const;
    remainingColorKeys.forEach((colorKey, index) => {
      join(state, `user-team-${index}`, 3_000 + index, random, {
        team: { newTeam: { name: `Team ${colorKey}`, colorKey } },
      });
    });
    expect(state.teams.size).toBe(8);

    expect(
      refusalCode(
        joinLobby(
          state,
          joinInput('user-ninth', {
            team: { newTeam: { name: 'Ninth', colorKey: 'moon' } },
          }),
          4_000,
          random,
        ),
      ),
    ).toBe('quizshow_team_limit');
    expect(state.teams.size).toBe(8);
  });

  it('lets a late joiner in without a place in the question being played', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('quiz', [
          trueFalseQuestion('question-1'),
          trueFalseQuestion('question-2'),
        ]),
      ],
    });
    const random = seededRandom();
    const early = join(state, 'user-a', 2_000, random);
    startGame(state, 5_000);
    openQuestion(state, 0, 0, 10_000);

    const late = join(state, 'user-b', 11_000, random);

    expect(state.players.get(late.playerId)?.joinedAt).toBe(11_000);
    expect(isEligible(state, late.playerId)).toBe(false);
    expect(
      refusalCode(answerNow(state, late.playerId, TRUE_ANSWER, 12_000, random)),
    ).toBe('quizshow_not_eligible');
    expect(
      successOf(answerNow(state, early.playerId, TRUE_ANSWER, 12_000, random))
        .isDuplicate,
    ).toBe(false);

    openQuestion(state, 0, 1, 40_000);

    expect(isEligible(state, late.playerId)).toBe(true);
    expect(
      successOf(answerNow(state, late.playerId, TRUE_ANSWER, 41_000, random))
        .isDuplicate,
    ).toBe(false);
  });

  it('accepts an answer 499 ms after the deadline and refuses one 501 ms after', () => {
    const state = stateWithQuiz({
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();
    const onTime = join(state, 'user-a', 2_000, random);
    const late = join(state, 'user-b', 2_000, random);
    openQuestion(state, 0, 0, 10_000);
    const deadline = state.cursor.deadline;
    if (deadline === null) throw new Error('The open phase has no deadline.');
    expect(deadline).toBe(30_000);

    const accepted = answerNow(
      state,
      onTime.playerId,
      TRUE_ANSWER,
      deadline + 499,
      random,
    );
    expect(successOf(accepted).answer.receivedAt).toBe(deadline + 499);
    expect(effectKinds(effectsOf(accepted))).toEqual([
      'persist insert_answer',
      'answer_accepted',
      'answer_count_changed',
    ]);
    expect(
      refusalCode(
        answerNow(state, late.playerId, TRUE_ANSWER, deadline + 501, random),
      ),
    ).toBe('quizshow_phase_closed');
    expect(state.current?.answers.has(late.playerId)).toBe(false);
  });

  it('judges a player with extra time against the extra-time deadline', () => {
    const state = stateWithQuiz({
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();
    const extraTimeOnTime = join(state, 'user-a', 2_000, random, {
      hasExtraTime: true,
    });
    const extraTimeLate = join(state, 'user-b', 2_000, random, {
      hasExtraTime: true,
    });
    const standard = join(state, 'user-c', 2_000, random);
    openQuestion(state, 0, 0, 10_000);
    const { deadline, extraTimeDeadline } = state.cursor;
    if (deadline === null || extraTimeDeadline === null) {
      throw new Error('The open phase has no deadlines.');
    }
    expect(extraTimeDeadline).toBe(40_000);

    expect(
      successOf(
        answerNow(
          state,
          extraTimeOnTime.playerId,
          TRUE_ANSWER,
          extraTimeDeadline + 400,
          random,
        ),
      ).isDuplicate,
    ).toBe(false);
    expect(
      refusalCode(
        answerNow(
          state,
          extraTimeLate.playerId,
          TRUE_ANSWER,
          extraTimeDeadline + 600,
          random,
        ),
      ),
    ).toBe('quizshow_phase_closed');
    expect(
      refusalCode(
        answerNow(
          state,
          standard.playerId,
          TRUE_ANSWER,
          deadline + 600,
          random,
        ),
      ),
    ).toBe('quizshow_phase_closed');
  });

  it('keeps the first answer and acks a resend as a duplicate, even after the phase moved', () => {
    const state = stateWithQuiz({
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();
    const me = join(state, 'user-a', 2_000, random);
    openQuestion(state, 0, 0, 10_000);
    const openPhaseId = state.cursor.phaseId;

    const first = successOf(
      answerNow(state, me.playerId, TRUE_ANSWER, 12_000, random),
    );
    expect(first.answer).toEqual({
      questionId: 'question-1',
      phaseId: openPhaseId,
      payload: TRUE_ANSWER,
      receivedAt: 12_000,
    });
    expect(state.current?.answers.get(me.playerId)?.elapsedMs).toBe(2_000);

    const resend = answerNow(
      state,
      me.playerId,
      { type: 'true_false', isTrue: false },
      13_000,
      random,
    );
    expect(resend).toEqual({
      ok: true,
      success: { answer: first.answer, isDuplicate: true },
      effects: [],
    });

    moveToPhase(state, 'reveal', 31_000);
    const afterMove = submitAnswer(
      state,
      me.playerId,
      {
        phaseId: openPhaseId,
        questionId: 'question-1',
        payload: { type: 'true_false', isTrue: false },
      },
      31_500,
      random,
    );
    expect(afterMove).toEqual({
      ok: true,
      success: { answer: first.answer, isDuplicate: true },
      effects: [],
    });
    expect(state.current?.answers.size).toBe(1);
  });

  it('refuses a stale phase id with the current cursor', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('quiz', [trueFalseQuestion('question-1')]),
        snapshotRound('caption_this', [promptQuestion('question-2', null)]),
      ],
    });
    const random = seededRandom();
    const me = join(state, 'user-a', 2_000, random);
    openQuestion(state, 0, 0, 10_000);

    const refusal = refusalOf(
      submitAnswer(
        state,
        me.playerId,
        { phaseId: '0', questionId: 'question-1', payload: TRUE_ANSWER },
        11_000,
        random,
      ),
    );
    expect(refusal.code).toBe('quizshow_stale_phase');
    expect(refusal.cursor).toEqual(state.cursor);

    openQuestion(state, 1, 0, 40_000);
    showVoteOptions(state, 50_000);
    const voteRefusal = refusalOf(
      submitVote(
        state,
        me.playerId,
        { phaseId: '1', questionId: 'question-2', optionId: 'option-other' },
        51_000,
      ),
    );
    expect(voteRefusal.code).toBe('quizshow_stale_phase');
    expect(voteRefusal.cursor).toEqual(state.cursor);
  });

  it('refuses submissions while paused', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('quiz', [trueFalseQuestion('question-1')]),
        snapshotRound('caption_this', [promptQuestion('question-2', null)]),
      ],
    });
    const random = seededRandom();
    const first = join(state, 'user-a', 2_000, random);
    const second = join(state, 'user-b', 2_000, random);
    openQuestion(state, 0, 0, 10_000);

    setSessionStatus(state, 'paused');
    expect(
      refusalCode(
        answerNow(state, first.playerId, TRUE_ANSWER, 11_000, random),
      ),
    ).toBe('quizshow_phase_closed');
    setSessionStatus(state, 'running');
    expect(
      successOf(answerNow(state, first.playerId, TRUE_ANSWER, 12_000, random))
        .isDuplicate,
    ).toBe(false);

    openQuestion(state, 1, 0, 40_000);
    successOf(
      answerNow(
        state,
        first.playerId,
        { type: 'prompt', text: 'A caption' },
        41_000,
        random,
      ),
    );
    successOf(
      answerNow(
        state,
        second.playerId,
        { type: 'prompt', text: 'Another caption' },
        41_000,
        random,
      ),
    );
    showVoteOptions(state, 50_000);

    setSessionStatus(state, 'paused');
    expect(
      refusalCode(
        voteNow(state, first.playerId, `option-${second.playerId}`, 51_000),
      ),
    ).toBe('quizshow_phase_closed');
    setSessionStatus(state, 'running');
    expect(
      successOf(
        voteNow(state, first.playerId, `option-${second.playerId}`, 52_000),
      ).isDuplicate,
    ).toBe(false);
  });

  it('refuses an answer of the wrong type and an order that is no permutation', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('quiz', [
          multipleChoiceQuestion('question-1'),
          orderQuestion('question-2'),
          closestNumberQuestion('question-3'),
        ]),
      ],
    });
    const random = seededRandom();
    const me = join(state, 'user-a', 2_000, random);

    openQuestion(state, 0, 0, 10_000);
    const invalidChoices: QuizshowAnswerPayload[] = [
      TRUE_ANSWER,
      { type: 'multiple_choice', optionIndex: 4 },
      { type: 'multiple_choice', optionIndex: -1 },
      { type: 'multiple_choice', optionIndex: 1.5 },
    ];
    for (const payload of invalidChoices) {
      expect(
        refusalCode(answerNow(state, me.playerId, payload, 11_000, random)),
      ).toBe('quizshow_invalid_answer');
    }
    expect(state.current?.answers.size).toBe(0);
    successOf(
      answerNow(
        state,
        me.playerId,
        { type: 'multiple_choice', optionIndex: 3 },
        11_000,
        random,
      ),
    );

    openQuestion(state, 0, 1, 40_000);
    const invalidOrders: string[][] = [
      ['x', 'x', 'y'],
      ['x', 'y'],
      ['x', 'y', 'w'],
      ['x', 'y', 'z', 'x'],
    ];
    for (const orderedIds of invalidOrders) {
      expect(
        refusalCode(
          answerNow(
            state,
            me.playerId,
            { type: 'order', orderedIds },
            41_000,
            random,
          ),
        ),
      ).toBe('quizshow_invalid_answer');
    }
    expect(
      successOf(
        answerNow(
          state,
          me.playerId,
          { type: 'order', orderedIds: ['z', 'x', 'y'] },
          41_000,
          random,
        ),
      ).answer.payload,
    ).toEqual({ type: 'order', orderedIds: ['z', 'x', 'y'] });

    openQuestion(state, 0, 2, 70_000);
    const invalidNumbers = [Number.POSITIVE_INFINITY, Number.NaN, 2e12, -2e12];
    for (const value of invalidNumbers) {
      expect(
        refusalCode(
          answerNow(
            state,
            me.playerId,
            { type: 'closest_number', value },
            71_000,
            random,
          ),
        ),
      ).toBe('quizshow_invalid_answer');
    }
    successOf(
      answerNow(
        state,
        me.playerId,
        { type: 'closest_number', value: 1970 },
        71_000,
        random,
      ),
    );
    expect(state.current?.answers.get(me.playerId)?.elapsedMs).toBe(1_000);
  });

  it('refuses blocked party text without storing it', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('caption_this', [promptQuestion('question-1', null)]),
      ],
    });
    const random = seededRandom();
    const me = join(state, 'user-a', 2_000, random);
    openQuestion(state, 0, 0, 10_000);
    expect(state.cursor.phase).toBe('write');

    expect(
      refusalCode(
        answerNow(
          state,
          me.playerId,
          { type: 'prompt', text: `So ${BLOCKED_WORD}` },
          11_000,
          random,
        ),
      ),
    ).toBe('quizshow_text_blocked');
    expect(
      refusalCode(
        answerNow(
          state,
          me.playerId,
          { type: 'prompt', text: '    ' },
          11_000,
          random,
        ),
      ),
    ).toBe('quizshow_text_blank');
    expect(state.current?.answers.size).toBe(0);

    const accepted = successOf(
      answerNow(
        state,
        me.playerId,
        { type: 'prompt', text: '  A fine caption  ' },
        12_000,
        random,
      ),
    );
    expect(accepted.answer.payload).toEqual({
      type: 'prompt',
      text: 'A fine caption',
    });
    expect(state.current?.answers.get(me.playerId)?.elapsedMs).toBeNull();
  });

  it('refuses a Lie Detector fake that matches the truth in either language', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('lie_detector', [
          promptQuestion('question-1', {
            en: 'Freddie Mercury',
            pt: 'Ney Matogrosso',
          }),
        ]),
      ],
    });
    const random = seededRandom();
    const me = join(state, 'user-a', 2_000, random);
    openQuestion(state, 0, 0, 10_000);

    const englishMatch = refusalOf(
      answerNow(
        state,
        me.playerId,
        { type: 'prompt', text: 'freddie  MERCURY!' },
        11_000,
        random,
      ),
    );
    expect(englishMatch.code).toBe('quizshow_fake_too_close');
    expect(englishMatch.message).toBe(
      'Too close to the real answer, try another',
    );
    expect(englishMatch.message).toBe(QUIZSHOW_FAKE_TOO_CLOSE_MESSAGE);
    expect(
      refusalCode(
        answerNow(
          state,
          me.playerId,
          { type: 'prompt', text: 'Ney Matogroso' },
          11_000,
          random,
        ),
      ),
    ).toBe('quizshow_fake_too_close');
    expect(state.current?.answers.size).toBe(0);

    successOf(
      answerNow(
        state,
        me.playerId,
        { type: 'prompt', text: 'Elton John' },
        12_000,
        random,
      ),
    );
    expect(state.current?.answers.size).toBe(1);
  });

  it('stops taking fakes after three too-close tries', () => {
    const truth = { en: 'Freddie Mercury', pt: 'Ney Matogrosso' };
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('lie_detector', [
          promptQuestion('question-1', truth),
          promptQuestion('question-2', truth),
        ]),
      ],
    });
    const random = seededRandom();
    const prober = join(state, 'user-a', 2_000, random);
    const other = join(state, 'user-b', 2_000, random);
    openQuestion(state, 0, 0, 10_000);

    const tooCloseGuesses = [
      'Freddie Mercury',
      'Fredie Mercury',
      'Ney Matogroso',
    ];
    tooCloseGuesses.forEach((text, index) => {
      expect(
        refusalCode(
          answerNow(
            state,
            prober.playerId,
            { type: 'prompt', text },
            11_000 + index * 1_000,
            random,
          ),
        ),
      ).toBe('quizshow_fake_too_close');
    });

    const afterLockout = refusalOf(
      answerNow(
        state,
        prober.playerId,
        { type: 'prompt', text: 'Elton John' },
        15_000,
        random,
      ),
    );
    expect(afterLockout.code).toBe('quizshow_fake_too_close');
    expect(afterLockout.message).toBe(QUIZSHOW_FAKE_TOO_CLOSE_MESSAGE);
    expect(state.current?.answers.has(prober.playerId)).toBe(false);

    successOf(
      answerNow(
        state,
        other.playerId,
        { type: 'prompt', text: 'Elton John' },
        15_000,
        random,
      ),
    );
    showVoteOptions(state, 20_000);
    expect(
      successOf(
        voteNow(state, prober.playerId, `option-${other.playerId}`, 21_000),
      ).isDuplicate,
    ).toBe(false);

    openQuestion(state, 0, 1, 40_000);
    expect(
      successOf(
        answerNow(
          state,
          prober.playerId,
          { type: 'prompt', text: 'George Michael' },
          41_000,
          random,
        ),
      ).isDuplicate,
    ).toBe(false);
  });

  it('refuses a vote for your own answer and for a hidden one', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('caption_this', [promptQuestion('question-1', null)]),
      ],
    });
    const random = seededRandom();
    const voter = join(state, 'user-a', 2_000, random);
    const hiddenAuthor = join(state, 'user-b', 2_000, random);
    const visibleAuthor = join(state, 'user-c', 2_000, random);
    openQuestion(state, 0, 0, 10_000);
    for (const player of [voter, hiddenAuthor, visibleAuthor]) {
      successOf(
        answerNow(
          state,
          player.playerId,
          { type: 'prompt', text: `Caption of ${player.playerId}` },
          11_000,
          random,
        ),
      );
    }
    const hiddenAnswer = state.current?.answers.get(hiddenAuthor.playerId);
    if (hiddenAnswer === undefined) throw new Error('No answer to hide.');
    hiddenAnswer.hiddenAt = 12_000;
    showVoteOptions(state, 20_000);

    expect(
      refusalCode(
        voteNow(state, voter.playerId, `option-${voter.playerId}`, 21_000),
      ),
    ).toBe('quizshow_own_answer_vote');
    expect(
      refusalCode(
        voteNow(
          state,
          voter.playerId,
          `option-${hiddenAuthor.playerId}`,
          21_000,
        ),
      ),
    ).toBe('quizshow_vote_option_not_found');
    expect(
      refusalCode(voteNow(state, voter.playerId, 'option-missing', 21_000)),
    ).toBe('quizshow_vote_option_not_found');
    expect(state.current?.votes.size).toBe(0);

    const accepted = voteNow(
      state,
      voter.playerId,
      `option-${visibleAuthor.playerId}`,
      22_000,
    );
    expect(successOf(accepted)).toEqual({
      vote: {
        questionId: 'question-1',
        optionId: `option-${visibleAuthor.playerId}`,
      },
      isDuplicate: false,
    });
    expect(effectKinds(effectsOf(accepted))).toEqual([
      'persist insert_vote',
      'answer_count_changed',
    ]);
    expect(state.current?.votes.get(voter.playerId)?.answerId).toBe(
      state.current?.answers.get(visibleAuthor.playerId)?.answerId,
    );

    const resend = voteNow(
      state,
      voter.playerId,
      `option-${hiddenAuthor.playerId}`,
      23_000,
    );
    expect(successOf(resend)).toEqual({
      vote: {
        questionId: 'question-1',
        optionId: `option-${visibleAuthor.playerId}`,
      },
      isDuplicate: true,
    });
    expect(effectsOf(resend)).toEqual([]);
  });

  it('plays a joker once per team and tells every teammate', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();
    const founder = join(state, 'user-a', 2_000, random, {
      team: { newTeam: { name: 'Glitter', colorKey: 'circle' } },
    });
    const teamId = founder.teamId;
    if (teamId === null) throw new Error('The founder has no team.');
    const teammate = join(state, 'user-b', 2_100, random, {
      team: { teamId },
    });
    const rival = join(state, 'user-c', 2_200, random, {
      team: { newTeam: { name: 'Sparkle', colorKey: 'triangle' } },
    });

    const played = playJoker(state, founder.playerId, 0, 3_000);

    expect(successOf(played).me.hasUsedJoker).toBe(true);
    expect(successOf(played).me.jokerRoundIndex).toBe(0);
    expect(effectsOf(played)).toContainEqual({
      kind: 'me_changed',
      playerIds: [founder.playerId, teammate.playerId],
    });
    expect(effectsOf(played)).toContainEqual({
      kind: 'persist',
      operation: {
        type: 'update_team',
        teamId,
        fields: { hasUsedJoker: true, jokerRoundIndex: 0 },
      },
    });
    expect(toMe(state, teammate.playerId).hasUsedJoker).toBe(true);
    expect(toMe(state, teammate.playerId).jokerRoundIndex).toBe(0);
    expect(toMe(state, rival.playerId).hasUsedJoker).toBe(false);

    // The teammate's tap finds the team joker already on round 0: acked with their current me.
    const teammateTap = playJoker(state, teammate.playerId, 0, 3_100);
    expect(successOf(teammateTap).me).toEqual(toMe(state, teammate.playerId));
    expect(effectsOf(teammateTap)).toEqual([]);
    expect(successOf(playJoker(state, rival.playerId, 0, 3_200)).me).toEqual(
      expect.objectContaining({ hasUsedJoker: true, jokerRoundIndex: 0 }),
    );
  });

  it('a second joker tap acks the joker already played', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('quiz', [trueFalseQuestion('question-1')]),
        snapshotRound('quiz', [trueFalseQuestion('question-2')]),
      ],
    });
    const random = seededRandom();
    const player = join(state, 'user-a', 2_000, random);
    startGame(state, 5_000);

    const firstTap = playJoker(state, player.playerId, 0, 5_100);
    expect(successOf(firstTap).me).toEqual(
      expect.objectContaining({ hasUsedJoker: true, jokerRoundIndex: 0 }),
    );
    expect(effectsOf(firstTap)).not.toEqual([]);

    const secondTap = playJoker(state, player.playerId, 0, 5_150);
    expect(secondTap.ok).toBe(true);
    expect(successOf(secondTap).me).toEqual(toMe(state, player.playerId));
    expect(successOf(secondTap).me).toEqual(
      expect.objectContaining({ hasUsedJoker: true, jokerRoundIndex: 0 }),
    );
    expect(effectsOf(secondTap)).toEqual([]);

    // A tap that lands after the question opened still finds the joker it asked for.
    openQuestion(state, 0, 0, 10_000);
    const lateTap = playJoker(state, player.playerId, 0, 10_100);
    expect(successOf(lateTap).me.jokerRoundIndex).toBe(0);
    expect(effectsOf(lateTap)).toEqual([]);

    moveToPhase(state, 'leaderboard', 40_000);
    expect(refusalCode(playJoker(state, player.playerId, 1, 40_100))).toBe(
      'quizshow_joker_used',
    );
    expect(toMe(state, player.playerId).jokerRoundIndex).toBe(0);
  });

  it('a second team creation tap acks the team already created', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [snapshotRound('quiz', [trueFalseQuestion('question-1')])],
    });
    const random = seededRandom();
    const founder = join(state, 'user-a', 2_000, random, {
      team: { newTeam: { name: 'Glitter', colorKey: 'circle' } },
    });
    const otherPlayer = join(state, 'user-b', 2_100, random, {
      team: { newTeam: { name: 'Sparkle', colorKey: 'triangle' } },
    });

    const firstTap = createTeam(
      state,
      founder.playerId,
      { name: 'Disco', colorKey: 'square' },
      3_000,
      random,
    );
    const createdTeamId = successOf(firstTap).teamId;
    expect(successOf(firstTap).me.teamId).toBe(createdTeamId);
    expect(effectKinds(effectsOf(firstTap))).toContain('persist insert_team');
    const teamCount = state.teams.size;

    const secondTap = createTeam(
      state,
      founder.playerId,
      { name: '  disco ', colorKey: 'square' },
      3_050,
      random,
    );
    expect(successOf(secondTap)).toEqual({
      me: toMe(state, founder.playerId),
      teamId: createdTeamId,
    });
    expect(effectsOf(secondTap)).toEqual([]);
    expect(state.teams.size).toBe(teamCount);

    expect(
      refusalCode(
        createTeam(
          state,
          otherPlayer.playerId,
          { name: 'Disco', colorKey: 'square' },
          3_100,
          random,
        ),
      ),
    ).toBe('quizshow_team_name_taken');
    expect(
      refusalCode(
        createTeam(
          state,
          founder.playerId,
          { name: 'Disco', colorKey: 'star' },
          3_150,
          random,
        ),
      ),
    ).toBe('quizshow_team_name_taken');
    expect(state.players.get(otherPlayer.playerId)?.teamId).toBe(
      otherPlayer.teamId,
    );
  });

  it("refuses a joker outside the round's intro, the leaderboard before it, or the lobby for round 0", () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('quiz', [trueFalseQuestion('question-1')]),
        snapshotRound('quiz', [trueFalseQuestion('question-2')]),
        snapshotRound('quiz', [trueFalseQuestion('question-3')], {
          isJokerAllowed: false,
        }),
      ],
    });
    const random = seededRandom();
    const lobbyPlayer = join(state, 'user-a', 2_000, random);
    const introPlayer = join(state, 'user-b', 2_000, random);
    const leaderboardPlayer = join(state, 'user-c', 2_000, random);
    const lastPlayer = join(state, 'user-d', 2_000, random);

    expect(refusalCode(playJoker(state, lobbyPlayer.playerId, 1, 3_000))).toBe(
      'quizshow_joker_not_allowed',
    );
    expect(
      successOf(playJoker(state, lobbyPlayer.playerId, 0, 3_000)).me
        .jokerRoundIndex,
    ).toBe(0);
    expect(
      successOf(playJoker(state, lobbyPlayer.playerId, 0, 3_100)).me
        .jokerRoundIndex,
    ).toBe(0);

    startGame(state, 5_000);
    expect(refusalCode(playJoker(state, introPlayer.playerId, 1, 5_100))).toBe(
      'quizshow_joker_not_allowed',
    );
    expect(
      successOf(playJoker(state, introPlayer.playerId, 0, 5_100)).me
        .jokerRoundIndex,
    ).toBe(0);

    openQuestion(state, 0, 0, 10_000);
    expect(
      refusalCode(playJoker(state, leaderboardPlayer.playerId, 0, 11_000)),
    ).toBe('quizshow_joker_not_allowed');
    expect(
      refusalCode(playJoker(state, leaderboardPlayer.playerId, 1, 11_000)),
    ).toBe('quizshow_joker_not_allowed');

    moveToPhase(state, 'leaderboard', 40_000);
    expect(refusalCode(playJoker(state, lobbyPlayer.playerId, 1, 40_050))).toBe(
      'quizshow_joker_used',
    );
    expect(
      refusalCode(playJoker(state, leaderboardPlayer.playerId, 0, 40_100)),
    ).toBe('quizshow_joker_not_allowed');
    expect(
      refusalCode(playJoker(state, leaderboardPlayer.playerId, 2, 40_100)),
    ).toBe('quizshow_joker_not_allowed');
    expect(
      successOf(playJoker(state, leaderboardPlayer.playerId, 1, 40_100)).me
        .jokerRoundIndex,
    ).toBe(1);

    advanceCursor(state, {
      phase: 'leaderboard',
      roundIndex: 1,
      questionIndex: null,
      now: 70_000,
      durationMs: null,
      extraTimeMs: null,
    });
    expect(refusalCode(playJoker(state, lastPlayer.playerId, 2, 70_100))).toBe(
      'quizshow_joker_not_allowed',
    );
    advanceCursor(state, {
      phase: 'round_intro',
      roundIndex: 2,
      questionIndex: null,
      now: 71_000,
      durationMs: null,
      extraTimeMs: null,
    });
    expect(refusalCode(playJoker(state, lastPlayer.playerId, 2, 71_100))).toBe(
      'quizshow_joker_not_allowed',
    );
    expect(refusalCode(playJoker(state, lastPlayer.playerId, 7, 71_100))).toBe(
      'quizshow_joker_not_allowed',
    );
    expect(toMe(state, lastPlayer.playerId).hasUsedJoker).toBe(false);
  });
});
