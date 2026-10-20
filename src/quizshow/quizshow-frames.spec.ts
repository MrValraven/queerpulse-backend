import type {
  QuizshowAnswerPayload,
  QuizshowNextEvent,
  QuizshowOption,
  QuizshowPhase,
  QuizshowPlayMode,
  QuizshowPlayerState,
  QuizshowPodiumEntry,
  QuizshowRoundKind,
  QuizshowScoresScope,
  QuizshowText,
} from './quizshow.contract';
import {
  activePlayers,
  advanceCursor,
  createLobbyState,
  entrantTotals,
  setSessionStatus,
} from './quizshow-engine-state';
import type {
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowLiveVoteOption,
} from './quizshow-engine-types';
import {
  buildAnswerCount,
  buildHostLobby,
  buildHostVoteOptions,
  buildLobby,
  buildMyReveal,
  buildMyScores,
  buildPhaseChange,
  buildPodiumFrame,
  buildReveal,
  buildReviewList,
  buildScores,
  buildSessionEnd,
  buildSessionState,
  buildVoteOptions,
  quizshowPlayerRoomName,
  quizshowRoomName,
} from './quizshow-frames';
import { competitionRanks } from './quizshow-scoring';
import type {
  QuizshowSessionSnapshot,
  QuizshowSnapshotQuestion,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';

const SESSION_ID = 'session-pride-night';
const HOST_USER_ID = 'user-host';
const OPENER_USER_ID = 'user-opener';
const ANA = 'player-ana';
const BEA = 'player-bea';
const CRIS = 'player-cris';
const DANI = 'player-dani';
const PLAYER_IDS = [ANA, BEA, CRIS, DANI];
const USER_IDS = [
  'user-ana',
  'user-bea',
  'user-cris',
  'user-dani',
  HOST_USER_ID,
  OPENER_USER_ID,
];
const ANA_AVATAR = 'https://cdn.example.test/avatars/ana.webp';
const BEA_AVATAR = 'https://cdn.example.test/avatars/bea.webp';
const CRIS_AVATAR = 'https://cdn.example.test/avatars/cris.webp';
const TYPED_ANSWER_TEXT = 'Stonewall Inn';
const LIE_DETECTOR_TRUTH = 'Marsha P. Johnson';
const HIDDEN_CAPTION = 'A caption the hosts will hide';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEXT_EVENT: QuizshowNextEvent = {
  slug: 'pride-night-november',
  title: 'Pride night',
  startAt: '2026-11-19T20:00:00.000Z',
};
const PRE_REVEAL_PHASES: ReadonlySet<QuizshowPhase> = new Set<QuizshowPhase>([
  'read',
  'open',
  'write',
  'review',
  'vote',
]);
/** Key names that only an answer key, a truth or a vote tally carries. */
const ANSWER_KEY_FIELDS = new Set([
  'correctIndex',
  'truth',
  'isTruth',
  'voteCount',
  'answerKey',
  'acceptedAnswers',
  'isCorrect',
  'correctPositions',
  'correct',
  'distribution',
  'authorPoints',
]);
/** Key names an answer key shares with a player's own answer payload. */
const ANSWER_SHAPED_FIELDS = new Set(['isTrue', 'value', 'orderedIds']);

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function bilingual(
  english: string,
  portuguese: string = english,
): QuizshowText {
  return { en: english, pt: portuguese };
}

function option(optionId: string, english: string): QuizshowOption {
  return { id: optionId, text: bilingual(english) };
}

const QUESTION_DEFAULTS = {
  mediaRef: null,
  mediaUrl: null,
  timeLimitSeconds: null,
  points: 1000,
};

const MULTIPLE_CHOICE_OPTIONS = [
  option('a', '1997'),
  option('b', '2000'),
  option('c', '2005'),
];
const ORDER_OPTIONS = [
  option('x', 'Stonewall'),
  option('y', 'First Pride march'),
  option('z', 'Lisbon Pride'),
];

const MULTIPLE_CHOICE_QUESTION: QuizshowSnapshotQuestion = {
  ...QUESTION_DEFAULTS,
  id: 'question-multiple-choice',
  type: 'multiple_choice',
  prompt: bilingual(
    'When did Lisbon hold its first Pride march?',
    'Quando foi a primeira marcha do Orgulho em Lisboa?',
  ),
  options: MULTIPLE_CHOICE_OPTIONS,
  answer: { correctIndex: 1 },
  acceptedAnswers: [],
  shownOptions: MULTIPLE_CHOICE_OPTIONS,
};
const TRUE_FALSE_QUESTION: QuizshowSnapshotQuestion = {
  ...QUESTION_DEFAULTS,
  id: 'question-true-false',
  type: 'true_false',
  prompt: bilingual('The Stonewall uprising happened in 1979'),
  options: [],
  answer: { isTrue: false },
  acceptedAnswers: [],
  shownOptions: null,
};
const TYPED_QUESTION: QuizshowSnapshotQuestion = {
  ...QUESTION_DEFAULTS,
  id: 'question-typed',
  type: 'type_answer',
  prompt: bilingual('Name the bar where the 1969 uprising began'),
  options: [],
  answer: { text: bilingual(TYPED_ANSWER_TEXT) },
  acceptedAnswers: ['Stonewall'],
  shownOptions: null,
};
const ORDER_QUESTION: QuizshowSnapshotQuestion = {
  ...QUESTION_DEFAULTS,
  id: 'question-order',
  type: 'order',
  prompt: bilingual('Put these in order, oldest first'),
  options: ORDER_OPTIONS,
  answer: { orderedIds: ['x', 'y', 'z'] },
  acceptedAnswers: [],
  shownOptions: [
    option('y', 'First Pride march'),
    option('z', 'Lisbon Pride'),
    option('x', 'Stonewall'),
  ],
};
const CLOSEST_QUESTION: QuizshowSnapshotQuestion = {
  ...QUESTION_DEFAULTS,
  id: 'question-closest',
  type: 'closest_number',
  prompt: bilingual('In which year did Portugal open marriage to everyone?'),
  options: [],
  answer: { value: 2010 },
  acceptedAnswers: [],
  shownOptions: null,
};
const LIE_DETECTOR_QUESTION: QuizshowSnapshotQuestion = {
  ...QUESTION_DEFAULTS,
  id: 'question-lie-detector',
  type: 'prompt',
  prompt: bilingual('Who is said to have started the Stonewall uprising?'),
  options: [],
  answer: { truth: bilingual(LIE_DETECTOR_TRUTH) },
  acceptedAnswers: [],
  shownOptions: null,
};
const CAPTION_QUESTION: QuizshowSnapshotQuestion = {
  ...QUESTION_DEFAULTS,
  id: 'question-caption',
  type: 'prompt',
  prompt: bilingual('Caption this photo', 'Legenda esta foto'),
  mediaRef: 'event-covers/caption.webp',
  mediaUrl: 'https://cdn.example.test/event-covers/caption.webp',
  options: [],
  answer: null,
  acceptedAnswers: [],
  shownOptions: null,
};

function snapshotRound(
  kind: QuizshowRoundKind,
  title: string,
  questions: QuizshowSnapshotQuestion[],
): QuizshowSnapshotRound {
  return {
    id: `round-${kind}`,
    kind,
    title: bilingual(title),
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    },
    questions,
  };
}

const SNAPSHOT: QuizshowSessionSnapshot = {
  title: 'Pride night quiz',
  languages: 'both',
  screenLanguage: 'en',
  rounds: [
    snapshotRound('quiz', 'Warm up', [
      MULTIPLE_CHOICE_QUESTION,
      TRUE_FALSE_QUESTION,
      TYPED_QUESTION,
      ORDER_QUESTION,
      CLOSEST_QUESTION,
    ]),
    snapshotRound('lie_detector', 'Lie Detector', [LIE_DETECTOR_QUESTION]),
    snapshotRound('caption_this', 'Caption This', [CAPTION_QUESTION]),
  ],
};

function lobbyState(playMode: QuizshowPlayMode = 'solo'): QuizshowLiveState {
  return createLobbyState({
    sessionId: SESSION_ID,
    eventId: 'event-pride-night',
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    hostUserId: HOST_USER_ID,
    openedByUserId: OPENER_USER_ID,
    joinCode: 'ABC234',
    playMode,
    maxTeamSize: null,
    isReviewOn: true,
    snapshot: SNAPSHOT,
    attachedOrganiserUserIds: new Set<string>([HOST_USER_ID]),
    nextEvent: null,
    startedAt: 1_000,
  });
}

function livePlayer(
  playerId: string,
  screenName: string,
  joinedAt: number,
  overrides: Partial<QuizshowLivePlayer> = {},
): QuizshowLivePlayer {
  return {
    playerId,
    userId: `user-${screenName.toLowerCase()}`,
    screenName,
    teamId: null,
    isCohostPlayer: false,
    isAvatarShown: false,
    avatarUrl: null,
    hasExtraTime: false,
    score: 0,
    streak: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    joinedAt,
    removedAt: null,
    connectedSocketCount: 1,
    ...overrides,
  };
}

function liveTeam(
  teamId: string,
  name: string,
  createdAt: number,
  overrides: Partial<QuizshowLiveTeam> = {},
): QuizshowLiveTeam {
  return {
    teamId,
    name,
    colorKey: 'circle',
    score: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    createdAt,
    ...overrides,
  };
}

function addPlayer(state: QuizshowLiveState, player: QuizshowLivePlayer): void {
  state.players.set(player.playerId, player);
}

function seatPlayers(state: QuizshowLiveState): void {
  addPlayer(
    state,
    livePlayer(ANA, 'Ana', 2_000, {
      isAvatarShown: true,
      avatarUrl: ANA_AVATAR,
    }),
  );
  addPlayer(
    state,
    livePlayer(BEA, 'Bea', 3_000, {
      isAvatarShown: false,
      avatarUrl: BEA_AVATAR,
    }),
  );
  addPlayer(
    state,
    livePlayer(CRIS, 'Cris', 4_000, {
      isAvatarShown: true,
      avatarUrl: CRIS_AVATAR,
      isCohostPlayer: true,
    }),
  );
}

function snapshotRoundAt(roundIndex: number): QuizshowSnapshotRound {
  const round = SNAPSHOT.rounds[roundIndex];
  if (round === undefined) throw new Error(`No fixture round ${roundIndex}`);
  return round;
}

function currentPlay(state: QuizshowLiveState): QuizshowLiveQuestionPlay {
  if (state.current === null) throw new Error('No question in play');
  return state.current;
}

function openQuestion(
  state: QuizshowLiveState,
  roundIndex: number,
  questionIndex: number,
  now: number,
): void {
  const round = snapshotRoundAt(roundIndex);
  const question = round.questions[questionIndex];
  if (question === undefined) {
    throw new Error(`No fixture question ${roundIndex}.${questionIndex}`);
  }
  const isParty = round.kind !== 'quiz';
  state.current = {
    questionId: question.id,
    roundIndex,
    questionIndex,
    openedAt: now,
    eligiblePlayerIds: new Set(
      activePlayers(state).map((player) => player.playerId),
    ),
    extraTimePlayerIds: new Set<string>(),
    answers: new Map(),
    votes: new Map(),
    voteOptions: null,
    favouriteOptionId: null,
    isScored: false,
    wasSkipped: false,
    pointsByPlayer: new Map(),
    teamPoints: new Map(),
  };
  advanceCursor(state, {
    phase: isParty ? 'write' : 'read',
    roundIndex,
    questionIndex,
    now,
    durationMs: isParty ? 60_000 : 4_000,
    extraTimeMs: isParty ? 90_000 : null,
  });
}

function moveTo(
  state: QuizshowLiveState,
  phase: QuizshowPhase,
  now: number,
  indexes?: { roundIndex: number | null; questionIndex: number | null },
): void {
  const isTimed = phase === 'open' || phase === 'write' || phase === 'vote';
  advanceCursor(state, {
    phase,
    roundIndex:
      indexes === undefined ? state.cursor.roundIndex : indexes.roundIndex,
    questionIndex:
      indexes === undefined
        ? state.cursor.questionIndex
        : indexes.questionIndex,
    now,
    durationMs: isTimed ? 20_000 : null,
    extraTimeMs: isTimed ? 30_000 : null,
  });
}

function submitAnswer(
  state: QuizshowLiveState,
  playerId: string,
  payload: QuizshowAnswerPayload,
  now: number,
): QuizshowLiveAnswer {
  const play = currentPlay(state);
  const answer: QuizshowLiveAnswer = {
    answerId: nextUuid(),
    playerId,
    questionId: play.questionId,
    phaseId: state.cursor.phaseId,
    payload,
    receivedAt: now,
    elapsedMs: payload.type === 'prompt' ? null : 1_500,
    isCorrect: null,
    correctPositions: null,
    pointsAwarded: 0,
    streakBonus: 0,
    voteOptionId: null,
    hiddenAt: null,
  };
  play.answers.set(playerId, answer);
  return answer;
}

function answerOf(
  state: QuizshowLiveState,
  playerId: string,
): QuizshowLiveAnswer {
  const answer = currentPlay(state).answers.get(playerId);
  if (answer === undefined) throw new Error(`No answer from ${playerId}`);
  return answer;
}

/** Vote options in the given order; `null` stands for the Lie Detector truth. */
function startVote(
  state: QuizshowLiveState,
  authorOrder: Array<string | null>,
  now: number,
): void {
  const play = currentPlay(state);
  play.voteOptions = authorOrder.map(
    (authorPlayerId): QuizshowLiveVoteOption => {
      if (authorPlayerId === null) {
        return {
          optionId: nextUuid(),
          answerId: null,
          authorPlayerId: null,
          text: LIE_DETECTOR_TRUTH,
          isTruth: true,
        };
      }
      const answer = answerOf(state, authorPlayerId);
      const optionId = nextUuid();
      answer.voteOptionId = optionId;
      return {
        optionId,
        answerId: answer.answerId,
        authorPlayerId,
        text: answer.payload.type === 'prompt' ? answer.payload.text : '',
        isTruth: false,
      };
    },
  );
  moveTo(state, 'vote', now);
}

function optionIdOf(
  state: QuizshowLiveState,
  authorPlayerId: string | null,
): string {
  const voteOption = currentPlay(state).voteOptions?.find(
    (candidate) => candidate.authorPlayerId === authorPlayerId,
  );
  if (voteOption === undefined) {
    throw new Error(`No vote option by ${authorPlayerId ?? 'the truth'}`);
  }
  return voteOption.optionId;
}

function submitVote(
  state: QuizshowLiveState,
  voterPlayerId: string,
  authorPlayerId: string | null,
  now: number,
): void {
  const play = currentPlay(state);
  const optionId = optionIdOf(state, authorPlayerId);
  const voteOption = play.voteOptions?.find(
    (candidate) => candidate.optionId === optionId,
  );
  play.votes.set(voterPlayerId, {
    voterPlayerId,
    questionId: play.questionId,
    optionId,
    answerId: voteOption?.answerId ?? null,
    createdAt: now,
  });
}

interface FixtureQuizResult {
  playerId: string;
  isCorrect: boolean;
  points: number;
  correctPositions?: number;
  streakBonus?: number;
}

function scoreQuizQuestion(
  state: QuizshowLiveState,
  results: FixtureQuizResult[],
): void {
  const play = currentPlay(state);
  for (const result of results) {
    const answer = play.answers.get(result.playerId);
    if (answer !== undefined) {
      answer.isCorrect = result.isCorrect;
      answer.correctPositions = result.correctPositions ?? null;
      answer.pointsAwarded = result.points;
      answer.streakBonus = result.streakBonus ?? 0;
    }
    play.pointsByPlayer.set(result.playerId, result.points);
    const player = state.players.get(result.playerId);
    if (player !== undefined) {
      player.score += result.points;
      player.streak = result.isCorrect ? player.streak + 1 : 0;
    }
  }
  play.isScored = true;
  state.hasScoredQuestion = true;
}

interface FixturePartyResult {
  playerId: string;
  points: number;
  authorShare: number;
}

function scorePartyQuestion(
  state: QuizshowLiveState,
  results: FixturePartyResult[],
): void {
  const play = currentPlay(state);
  for (const result of results) {
    const answer = play.answers.get(result.playerId);
    if (answer !== undefined) answer.pointsAwarded = result.authorShare;
    play.pointsByPlayer.set(result.playerId, result.points);
    const player = state.players.get(result.playerId);
    if (player !== undefined) player.score += result.points;
  }
  play.isScored = true;
  state.hasScoredQuestion = true;
}

function showScores(
  state: QuizshowLiveState,
  phase: 'scores' | 'leaderboard' | 'podium',
  scope: QuizshowScoresScope,
  now: number,
  indexes?: { roundIndex: number | null; questionIndex: number | null },
): void {
  moveTo(state, phase, now, indexes);
  state.lastScoresFrame = {
    phaseId: state.cursor.phaseId,
    scope,
    previousByEntrant: new Map(state.scoresAtLastFrame),
  };
  state.scoresAtLastFrame = new Map(
    entrantTotals(state).map((entry): [string, number] => [
      entry.entrantId,
      entry.score,
    ]),
  );
}

function isPodiumPlace(rank: number): rank is 1 | 2 | 3 {
  return rank === 1 || rank === 2 || rank === 3;
}

function rankedPodium(state: QuizshowLiveState): QuizshowPodiumEntry[] {
  return competitionRanks(entrantTotals(state)).flatMap(
    (entry): QuizshowPodiumEntry[] => {
      const place = entry.rank;
      if (!isPodiumPlace(place)) return [];
      return [
        {
          place,
          kind: entry.kind,
          entrantId: entry.entrantId,
          name: entry.name,
          colorKey: entry.colorKey,
          score: entry.score,
        },
      ];
    },
  );
}

interface SessionStep {
  label: string;
  state: QuizshowLiveState;
}

/**
 * One solo night walked through every phase: five quiz questions, a Lie
 * Detector round and a Caption This round, then the podium. Dani joins late,
 * during the first question. Each step is a frozen copy of the state.
 */
function playSession(): SessionStep[] {
  const state = lobbyState('solo');
  seatPlayers(state);
  const steps: SessionStep[] = [];
  let now = 10_000;
  const later = (): number => {
    now += 1_000;
    return now;
  };
  const record = (label: string): void => {
    steps.push({ label, state: structuredClone(state) });
  };
  const playQuizQuestion = (
    questionIndex: number,
    label: string,
    answers: Array<[string, QuizshowAnswerPayload]>,
    results: FixtureQuizResult[],
    whileOpen?: () => void,
  ): void => {
    openQuestion(state, 0, questionIndex, later());
    record(`${label} read`);
    moveTo(state, 'open', later());
    for (const [playerId, payload] of answers) {
      submitAnswer(state, playerId, payload, later());
    }
    whileOpen?.();
    record(`${label} open`);
    moveTo(state, 'reveal', later());
    scoreQuizQuestion(state, results);
    record(`${label} reveal`);
    showScores(state, 'scores', 'question', later());
    record(`${label} scores`);
  };

  record('lobby');
  setSessionStatus(state, 'running');
  moveTo(state, 'round_intro', later(), { roundIndex: 0, questionIndex: null });
  record('quiz intro');
  playQuizQuestion(
    0,
    'multiple choice',
    [
      [ANA, { type: 'multiple_choice', optionIndex: 1 }],
      [BEA, { type: 'multiple_choice', optionIndex: 0 }],
    ],
    [
      { playerId: ANA, isCorrect: true, points: 900, streakBonus: 100 },
      { playerId: BEA, isCorrect: false, points: 0 },
      { playerId: CRIS, isCorrect: false, points: 0 },
    ],
    () => addPlayer(state, livePlayer(DANI, 'Dani', now)),
  );
  playQuizQuestion(
    1,
    'true or false',
    [
      [ANA, { type: 'true_false', isTrue: false }],
      [BEA, { type: 'true_false', isTrue: true }],
    ],
    [
      { playerId: ANA, isCorrect: true, points: 800, streakBonus: 200 },
      { playerId: BEA, isCorrect: false, points: 0 },
      { playerId: CRIS, isCorrect: false, points: 0 },
      { playerId: DANI, isCorrect: false, points: 0 },
    ],
  );
  playQuizQuestion(
    2,
    'typed',
    [
      [ANA, { type: 'type_answer', text: 'stonewall' }],
      [BEA, { type: 'type_answer', text: 'Christopher Street' }],
    ],
    [
      { playerId: ANA, isCorrect: true, points: 700, streakBonus: 300 },
      { playerId: BEA, isCorrect: false, points: 0 },
      { playerId: CRIS, isCorrect: false, points: 0 },
      { playerId: DANI, isCorrect: false, points: 0 },
    ],
  );
  playQuizQuestion(
    3,
    'order',
    [
      [ANA, { type: 'order', orderedIds: ['x', 'z', 'y'] }],
      [BEA, { type: 'order', orderedIds: ['z', 'x', 'y'] }],
      [CRIS, { type: 'order', orderedIds: ['x', 'y', 'z'] }],
    ],
    [
      { playerId: ANA, isCorrect: false, points: 333, correctPositions: 1 },
      { playerId: BEA, isCorrect: false, points: 0, correctPositions: 0 },
      { playerId: CRIS, isCorrect: true, points: 600, correctPositions: 3 },
      { playerId: DANI, isCorrect: false, points: 0 },
    ],
  );
  playQuizQuestion(
    4,
    'closest',
    [
      [ANA, { type: 'closest_number', value: 2011 }],
      [BEA, { type: 'closest_number', value: 2030 }],
      [CRIS, { type: 'closest_number', value: 2500 }],
    ],
    [
      { playerId: ANA, isCorrect: true, points: 1000 },
      { playerId: BEA, isCorrect: false, points: 500 },
      { playerId: CRIS, isCorrect: false, points: 0 },
      { playerId: DANI, isCorrect: false, points: 0 },
    ],
  );
  showScores(state, 'leaderboard', 'round', later(), {
    roundIndex: 0,
    questionIndex: null,
  });
  record('quiz leaderboard');

  moveTo(state, 'round_intro', later(), { roundIndex: 1, questionIndex: null });
  record('lie detector intro');
  openQuestion(state, 1, 0, later());
  submitAnswer(state, ANA, { type: 'prompt', text: 'Sylvia Rivera' }, later());
  submitAnswer(state, BEA, { type: 'prompt', text: 'Harvey Milk' }, later());
  submitAnswer(state, CRIS, { type: 'prompt', text: 'Bayard Rustin' }, later());
  record('lie detector write');
  moveTo(state, 'review', later());
  answerOf(state, CRIS).hiddenAt = later();
  record('lie detector review');
  startVote(state, [ANA, null, BEA], later());
  submitVote(state, ANA, null, later());
  submitVote(state, BEA, ANA, later());
  submitVote(state, CRIS, null, later());
  record('lie detector vote');
  moveTo(state, 'reveal', later());
  scorePartyQuestion(state, [
    { playerId: ANA, points: 1500, authorShare: 500 },
    { playerId: BEA, points: 0, authorShare: 0 },
    { playerId: CRIS, points: 1000, authorShare: 0 },
  ]);
  record('lie detector reveal');
  showScores(state, 'leaderboard', 'round', later(), {
    roundIndex: 1,
    questionIndex: null,
  });
  record('party leaderboard');

  moveTo(state, 'round_intro', later(), { roundIndex: 2, questionIndex: null });
  record('caption intro');
  openQuestion(state, 2, 0, later());
  submitAnswer(
    state,
    ANA,
    { type: 'prompt', text: 'Serving looks at the archive' },
    later(),
  );
  submitAnswer(
    state,
    BEA,
    { type: 'prompt', text: 'Category is library realness' },
    later(),
  );
  submitAnswer(state, CRIS, { type: 'prompt', text: HIDDEN_CAPTION }, later());
  record('caption write');
  moveTo(state, 'review', later());
  record('caption review');
  startVote(state, [ANA, BEA, CRIS], later());
  answerOf(state, CRIS).hiddenAt = later();
  submitVote(state, BEA, ANA, later());
  submitVote(state, ANA, BEA, later());
  submitVote(state, CRIS, BEA, later());
  record('caption vote');
  moveTo(state, 'reveal', later());
  currentPlay(state).favouriteOptionId = optionIdOf(state, ANA);
  scorePartyQuestion(state, [
    { playerId: ANA, points: 750, authorShare: 750 },
    { playerId: BEA, points: 500, authorShare: 500 },
    { playerId: CRIS, points: 0, authorShare: 0 },
  ]);
  record('caption reveal');

  showScores(state, 'podium', 'final', later(), {
    roundIndex: null,
    questionIndex: null,
  });
  state.podium = rankedPodium(state);
  record('podium');
  setSessionStatus(state, 'finished');
  moveTo(state, 'ended', later(), { roundIndex: null, questionIndex: null });
  state.nextEvent = NEXT_EVENT;
  record('ended');
  return steps;
}

function stepState(steps: SessionStep[], label: string): QuizshowLiveState {
  const step = steps.find((candidate) => candidate.label === label);
  if (step === undefined) throw new Error(`No fixture step named ${label}`);
  return step.state;
}

function stepOption(
  steps: SessionStep[],
  label: string,
  authorPlayerId: string | null,
): string {
  return optionIdOf(stepState(steps, label), authorPlayerId);
}

function playerState(
  state: QuizshowLiveState,
  playerId: string | null,
): QuizshowPlayerState {
  return buildSessionState(state, {
    role: 'player',
    playerId,
    suggestedScreenName: 'Alex',
  });
}

function publicFrames(state: QuizshowLiveState): unknown[] {
  return [
    buildPhaseChange(state, 'public'),
    buildSessionState(state, { role: 'screen' }),
    playerState(state, null),
    buildVoteOptions(state, null),
    buildAnswerCount(state),
    buildLobby(state, 'screen'),
    buildLobby(state, 'players'),
    ...PLAYER_IDS.flatMap((playerId) => [
      playerState(state, playerId),
      buildVoteOptions(state, playerId),
    ]),
  ];
}

function everyFrame(state: QuizshowLiveState): unknown[] {
  return [
    ...publicFrames(state),
    buildHostLobby(state),
    buildPhaseChange(state, 'host'),
    buildReviewList(state),
    buildHostVoteOptions(state),
    buildReveal(state),
    buildScores(state),
    buildPodiumFrame(state),
    buildSessionEnd(state),
    buildSessionState(state, { role: 'host' }),
    ...PLAYER_IDS.flatMap((playerId) => [
      buildMyReveal(state, playerId),
      buildMyScores(state, playerId),
    ]),
  ];
}

/** Paths of answer-key fields; answer-shaped fields count outside a player's own `payload` only. */
function findAnswerKeyFields(frame: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: string[]): void => {
    if (Array.isArray(node)) {
      (node as unknown[]).forEach((item, index) =>
        visit(item, [...path, String(index)]),
      );
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(
      node as Record<string, unknown>,
    )) {
      const childPath = [...path, key];
      const isAnswerShaped =
        ANSWER_SHAPED_FIELDS.has(key) && !path.includes('payload');
      if (ANSWER_KEY_FIELDS.has(key) || isAnswerShaped) {
        found.push(childPath.join('.'));
      }
      visit(child, childPath);
    }
  };
  visit(JSON.parse(JSON.stringify(frame ?? null)) as unknown, []);
  return found;
}

function collectStrings(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') {
    found.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node as unknown[]) collectStrings(item, found);
  } else if (node !== null && typeof node === 'object') {
    for (const child of Object.values(node as Record<string, unknown>)) {
      collectStrings(child, found);
    }
  }
  return found;
}

describe('quizshow frames', () => {
  it('keeps every answer key, truth and vote count out of screen and player frames before reveal', () => {
    const steps = playSession();
    const preRevealSteps = steps.filter((step) =>
      PRE_REVEAL_PHASES.has(step.state.cursor.phase),
    );
    expect(preRevealSteps.map((step) => step.label)).toEqual([
      'multiple choice read',
      'multiple choice open',
      'true or false read',
      'true or false open',
      'typed read',
      'typed open',
      'order read',
      'order open',
      'closest read',
      'closest open',
      'lie detector write',
      'lie detector review',
      'lie detector vote',
      'caption write',
      'caption review',
      'caption vote',
    ]);
    for (const step of preRevealSteps) {
      for (const frame of publicFrames(step.state)) {
        expect({
          label: step.label,
          fields: findAnswerKeyFields(frame),
        }).toEqual({ label: step.label, fields: [] });
        const serialised = JSON.stringify(frame ?? null);
        expect(serialised).not.toContain(TYPED_ANSWER_TEXT);
        expect(serialised).not.toContain('"isTruth"');
        expect(serialised).not.toContain('"voteCount"');
        if (step.state.cursor.phase !== 'vote') {
          expect(serialised).not.toContain(LIE_DETECTOR_TRUTH);
        }
      }
    }

    const voteState = stepState(steps, 'lie detector vote');
    const voteOptions = buildVoteOptions(voteState, null)?.options ?? [];
    expect(voteOptions).toHaveLength(3);
    for (const voteOption of voteOptions) {
      expect(voteOption.optionId).toMatch(UUID_PATTERN);
      expect(Object.keys(voteOption).sort()).toEqual(['optionId', 'text']);
    }
    expect(voteOptions.map((voteOption) => voteOption.text)).toContain(
      LIE_DETECTOR_TRUTH,
    );
  });

  it("gives hosts the answer key from the question's first phase", () => {
    const steps = playSession();
    const expectedKeys: Array<[string, unknown]> = [
      ['multiple choice read', { type: 'multiple_choice', correctIndex: 1 }],
      ['true or false read', { type: 'true_false', isTrue: false }],
      [
        'typed read',
        {
          type: 'type_answer',
          text: bilingual(TYPED_ANSWER_TEXT),
          acceptedAnswers: ['Stonewall'],
        },
      ],
      ['order read', { type: 'order', orderedIds: ['x', 'y', 'z'] }],
      ['closest read', { type: 'closest_number', value: 2010 }],
      [
        'lie detector write',
        { type: 'lie_detector', truth: bilingual(LIE_DETECTOR_TRUTH) },
      ],
      ['caption write', null],
    ];
    for (const [label, expectedKey] of expectedKeys) {
      const state = stepState(steps, label);
      expect(buildPhaseChange(state, 'host').question).toMatchObject({
        questionId: currentPlay(state).questionId,
        answerKey: expectedKey,
      });
      expect(
        buildSessionState(state, { role: 'host' }).question?.answerKey,
      ).toEqual(expectedKey);
      expect(buildPhaseChange(state, 'public').question).not.toHaveProperty(
        'answerKey',
      );
    }
  });

  it('puts no user id in any frame for any role', () => {
    const steps = playSession();
    expect(steps.length).toBeGreaterThan(30);
    for (const step of steps) {
      for (const frame of everyFrame(step.state)) {
        const leakedStrings = collectStrings(frame).filter((value) =>
          USER_IDS.some((userId) => value.includes(userId)),
        );
        expect({ label: step.label, leakedStrings }).toEqual({
          label: step.label,
          leakedStrings: [],
        });
      }
    }
  });

  it('sends avatars to screen and hosts only', () => {
    const state = stepState(playSession(), 'lobby');
    const avatarsOf = (players: Array<{ avatarUrl: string | null }>) =>
      players.map((player) => player.avatarUrl);

    expect(avatarsOf(buildLobby(state, 'screen').players)).toEqual([
      ANA_AVATAR,
      null,
      CRIS_AVATAR,
    ]);
    expect(avatarsOf(buildHostLobby(state).players)).toEqual([
      ANA_AVATAR,
      null,
      CRIS_AVATAR,
    ]);
    expect(avatarsOf(buildLobby(state, 'players').players)).toEqual([
      null,
      null,
      null,
    ]);
    expect(
      avatarsOf(buildSessionState(state, { role: 'screen' }).lobby.players),
    ).toEqual([ANA_AVATAR, null, CRIS_AVATAR]);
    expect(
      avatarsOf(buildSessionState(state, { role: 'host' }).lobby.players),
    ).toEqual([ANA_AVATAR, null, CRIS_AVATAR]);
    for (const playerId of [ANA, BEA, CRIS, null]) {
      expect(JSON.stringify(playerState(state, playerId))).not.toContain(
        '/avatars/',
      );
    }

    const ana = state.players.get(ANA);
    if (ana === undefined) throw new Error('Ana is missing');
    ana.isAvatarShown = false;
    expect(avatarsOf(buildLobby(state, 'screen').players)).toEqual([
      null,
      null,
      CRIS_AVATAR,
    ]);
    expect(avatarsOf(buildHostLobby(state).players)).toEqual([
      null,
      null,
      CRIS_AVATAR,
    ]);
  });

  it('names authors only at reveal and only by screen name', () => {
    const steps = playSession();
    for (const label of [
      'lie detector write',
      'lie detector review',
      'lie detector vote',
      'caption write',
      'caption review',
      'caption vote',
    ]) {
      for (const frame of publicFrames(stepState(steps, label))) {
        const serialised = JSON.stringify(frame ?? null);
        expect(serialised).not.toContain('"authorName"');
        expect(serialised).not.toContain('"answerId"');
        expect(serialised).not.toContain('"authorPlayerId"');
      }
    }

    const voteState = stepState(steps, 'lie detector vote');
    expect(
      buildHostVoteOptions(voteState)?.options.map((voteOption) => [
        voteOption.authorName,
        voteOption.isTruth,
      ]),
    ).toEqual([
      ['Ana', false],
      [null, true],
      ['Bea', false],
    ]);
    expect(
      buildReviewList(stepState(steps, 'lie detector review'))?.submissions.map(
        (submission) => [submission.screenName, submission.isHidden],
      ),
    ).toEqual([
      ['Ana', false],
      ['Bea', false],
      ['Cris', true],
    ]);

    const reveal = buildReveal(stepState(steps, 'lie detector reveal'));
    if (reveal === null || reveal.distribution.kind !== 'votes') {
      throw new Error('Expected a votes reveal');
    }
    expect(
      reveal.distribution.entries.map((entry) => entry.authorName),
    ).toEqual(['Ana', null, 'Bea']);
    for (const entry of reveal.distribution.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        'answerId',
        'authorName',
        'authorPoints',
        'isTruth',
        'optionId',
        'text',
        'voteCount',
      ]);
    }
    expect(JSON.stringify(reveal)).not.toContain('player-');
  });

  it('builds the distribution for every question type', () => {
    const steps = playSession();
    const distributionAt = (label: string) =>
      buildReveal(stepState(steps, label))?.distribution;

    expect(distributionAt('multiple choice reveal')).toEqual({
      kind: 'options',
      counts: [1, 1, 0],
    });
    expect(distributionAt('true or false reveal')).toEqual({
      kind: 'true_false',
      trueCount: 1,
      falseCount: 1,
    });
    expect(distributionAt('typed reveal')).toEqual({
      kind: 'typed',
      correctCount: 1,
      incorrectCount: 1,
    });
    expect(distributionAt('order reveal')).toEqual({
      kind: 'order',
      exactCount: 1,
      partialCount: 1,
      noneCount: 1,
    });
    expect(distributionAt('closest reveal')).toEqual({
      kind: 'closest',
      closestValue: 2011,
      closestNames: ['Ana'],
      withinBandCount: 1,
    });

    const tiedState = structuredClone(stepState(steps, 'closest reveal'));
    answerOf(tiedState, CRIS).payload = {
      type: 'closest_number',
      value: 2009,
    };
    expect(buildReveal(tiedState)?.distribution).toEqual({
      kind: 'closest',
      closestValue: 2011,
      closestNames: ['Ana', 'Cris'],
      withinBandCount: 1,
    });
    const unansweredState = structuredClone(stepState(steps, 'closest reveal'));
    currentPlay(unansweredState).answers.clear();
    expect(buildReveal(unansweredState)?.distribution).toEqual({
      kind: 'closest',
      closestValue: null,
      closestNames: [],
      withinBandCount: 0,
    });

    const multipleChoiceReveal = buildReveal(
      stepState(steps, 'multiple choice reveal'),
    );
    expect(multipleChoiceReveal).toMatchObject({
      questionId: MULTIPLE_CHOICE_QUESTION.id,
      correct: { type: 'multiple_choice', correctIndex: 1 },
      answeredCount: 2,
      eligibleCount: 3,
    });

    const lieDetectorState = stepState(steps, 'lie detector reveal');
    const lieDetectorReveal = buildReveal(lieDetectorState);
    expect(lieDetectorReveal).toEqual({
      phaseId: lieDetectorState.cursor.phaseId,
      questionId: LIE_DETECTOR_QUESTION.id,
      correct: { type: 'lie_detector', truth: bilingual(LIE_DETECTOR_TRUTH) },
      answeredCount: 3,
      eligibleCount: 4,
      distribution: {
        kind: 'votes',
        entries: [
          {
            optionId: optionIdOf(lieDetectorState, ANA),
            answerId: answerOf(lieDetectorState, ANA).answerId,
            text: 'Sylvia Rivera',
            authorName: 'Ana',
            isTruth: false,
            voteCount: 1,
            authorPoints: 500,
          },
          {
            optionId: optionIdOf(lieDetectorState, null),
            answerId: null,
            text: LIE_DETECTOR_TRUTH,
            authorName: null,
            isTruth: true,
            voteCount: 2,
            authorPoints: 0,
          },
          {
            optionId: optionIdOf(lieDetectorState, BEA),
            answerId: answerOf(lieDetectorState, BEA).answerId,
            text: 'Harvey Milk',
            authorName: 'Bea',
            isTruth: false,
            voteCount: 0,
            authorPoints: 0,
          },
        ],
        favouriteOptionId: null,
      },
    });
    expect(JSON.stringify(lieDetectorReveal)).not.toContain('Bayard Rustin');

    const captionState = stepState(steps, 'caption reveal');
    const captionReveal = buildReveal(captionState);
    expect(captionReveal?.correct).toBeNull();
    expect(captionReveal?.distribution).toEqual({
      kind: 'votes',
      entries: [
        {
          optionId: optionIdOf(captionState, ANA),
          answerId: answerOf(captionState, ANA).answerId,
          text: 'Serving looks at the archive',
          authorName: 'Ana',
          isTruth: false,
          voteCount: 1,
          authorPoints: 750,
        },
        {
          optionId: optionIdOf(captionState, BEA),
          answerId: answerOf(captionState, BEA).answerId,
          text: 'Category is library realness',
          authorName: 'Bea',
          isTruth: false,
          voteCount: 2,
          authorPoints: 500,
        },
      ],
      favouriteOptionId: optionIdOf(captionState, ANA),
    });
    expect(JSON.stringify(captionReveal)).not.toContain(HIDDEN_CAPTION);
  });

  it('ranks ties together on the leaderboard and gives each player their own line', () => {
    const soloState = lobbyState('solo');
    addPlayer(soloState, livePlayer(ANA, 'Ana', 2_000, { score: 1000 }));
    addPlayer(soloState, livePlayer(BEA, 'Bea', 3_000, { score: 1000 }));
    addPlayer(soloState, livePlayer(CRIS, 'Cris', 4_000, { score: 500 }));
    addPlayer(soloState, livePlayer(DANI, 'Dani', 5_000, { score: 0 }));
    addPlayer(
      soloState,
      livePlayer('player-eli', 'Eli', 6_000, { score: 5000, removedAt: 7_000 }),
    );
    setSessionStatus(soloState, 'running');
    soloState.scoresAtLastFrame = new Map([
      [ANA, 400],
      [BEA, 1000],
    ]);
    showScores(soloState, 'scores', 'question', 20_000, {
      roundIndex: 0,
      questionIndex: 0,
    });
    const soloScores = buildScores(soloState);
    expect(soloScores?.scope).toBe('question');
    expect(soloScores?.entrantCount).toBe(4);
    expect(
      soloScores?.entries.map((entry) => [
        entry.name,
        entry.rank,
        entry.score,
        entry.previousScore,
      ]),
    ).toEqual([
      ['Ana', 1, 1000, 400],
      ['Bea', 1, 1000, 1000],
      ['Cris', 3, 500, 0],
      ['Dani', 4, 0, 0],
    ]);
    expect(buildMyScores(soloState, ANA)).toEqual({
      phaseId: soloState.cursor.phaseId,
      rank: 1,
      score: 1000,
      previousScore: 400,
      ownScore: 1000,
    });
    expect(buildMyScores(soloState, CRIS)?.rank).toBe(3);
    expect(buildMyScores(soloState, 'player-eli')).toBeNull();

    for (let extra = 0; extra < 10; extra += 1) {
      addPlayer(
        soloState,
        livePlayer(`player-extra-${extra}`, `Extra ${extra}`, 8_000 + extra),
      );
    }
    const crowdedScores = buildScores(soloState);
    expect(crowdedScores?.entries).toHaveLength(10);
    expect(crowdedScores?.entrantCount).toBe(14);

    const teamsState = lobbyState('teams');
    teamsState.teams.set(
      'team-glitter',
      liveTeam('team-glitter', 'Glitter', 1, { score: 900 }),
    );
    teamsState.teams.set(
      'team-sequin',
      liveTeam('team-sequin', 'Sequin', 2, { score: 900, colorKey: 'star' }),
    );
    teamsState.teams.set(
      'team-velvet',
      liveTeam('team-velvet', 'Velvet', 3, { score: 300, colorKey: 'moon' }),
    );
    addPlayer(
      teamsState,
      livePlayer(ANA, 'Ana', 2_000, { teamId: 'team-glitter', score: 1200 }),
    );
    addPlayer(
      teamsState,
      livePlayer(BEA, 'Bea', 3_000, { teamId: 'team-glitter', score: 600 }),
    );
    addPlayer(
      teamsState,
      livePlayer(CRIS, 'Cris', 4_000, { teamId: 'team-sequin', score: 900 }),
    );
    addPlayer(
      teamsState,
      livePlayer(DANI, 'Dani', 5_000, { teamId: 'team-velvet', score: 300 }),
    );
    setSessionStatus(teamsState, 'running');
    teamsState.scoresAtLastFrame = new Map([['team-glitter', 500]]);
    showScores(teamsState, 'leaderboard', 'round', 30_000, {
      roundIndex: 0,
      questionIndex: null,
    });
    const teamScores = buildScores(teamsState);
    expect(teamScores?.scope).toBe('round');
    expect(
      teamScores?.entries.map((entry) => [
        entry.kind,
        entry.name,
        entry.colorKey,
        entry.rank,
        entry.score,
        entry.previousScore,
      ]),
    ).toEqual([
      ['team', 'Glitter', 'circle', 1, 900, 500],
      ['team', 'Sequin', 'star', 1, 900, 0],
      ['team', 'Velvet', 'moon', 3, 300, 0],
    ]);
    expect(buildMyScores(teamsState, BEA)).toEqual({
      phaseId: teamsState.cursor.phaseId,
      rank: 1,
      score: 900,
      previousScore: 500,
      ownScore: 600,
    });
    expect(buildMyScores(teamsState, DANI)).toMatchObject({
      rank: 3,
      score: 300,
      ownScore: 300,
    });
  });

  it('counts submissions in review and votes in vote against the eligible total', () => {
    const steps = playSession();
    const countAt = (state: QuizshowLiveState) => buildAnswerCount(state);

    const openState = stepState(steps, 'multiple choice open');
    expect(countAt(openState)).toEqual({
      phaseId: openState.cursor.phaseId,
      count: 2,
      total: 3,
    });
    expect(countAt(stepState(steps, 'lie detector write'))).toMatchObject({
      count: 3,
      total: 4,
    });
    const reviewState = stepState(steps, 'lie detector review');
    expect(countAt(reviewState)).toEqual({
      phaseId: reviewState.cursor.phaseId,
      count: 3,
      total: 4,
    });
    expect(
      buildSessionState(reviewState, { role: 'screen' }).answerCount,
    ).toEqual({ count: 3, total: 4 });

    const voteState = stepState(steps, 'lie detector vote');
    expect(countAt(voteState)).toEqual({
      phaseId: voteState.cursor.phaseId,
      count: 3,
      total: 4,
    });
    const removalState = structuredClone(voteState);
    const bea = removalState.players.get(BEA);
    if (bea === undefined) throw new Error('Bea is missing');
    bea.removedAt = 99_000;
    expect(countAt(removalState)).toMatchObject({ count: 2, total: 3 });

    expect(countAt(stepState(steps, 'lie detector reveal'))).toBeNull();
    expect(countAt(stepState(steps, 'quiz leaderboard'))).toBeNull();
  });

  it("builds the player's state with their own answer, vote, reveal and scores after a reconnect", () => {
    const steps = playSession();

    const voteState = stepState(steps, 'lie detector vote');
    const anaAnswer = answerOf(voteState, ANA);
    const anaAtVote = playerState(voteState, ANA);
    expect(anaAtVote.role).toBe('player');
    expect(anaAtVote.me).toMatchObject({ playerId: ANA, screenName: 'Ana' });
    expect(anaAtVote.isEligibleForQuestion).toBe(true);
    expect(anaAtVote.myAnswer).toEqual({
      questionId: LIE_DETECTOR_QUESTION.id,
      phaseId: anaAnswer.phaseId,
      payload: { type: 'prompt', text: 'Sylvia Rivera' },
      receivedAt: anaAnswer.receivedAt,
    });
    expect(anaAtVote.myVote).toEqual({
      questionId: LIE_DETECTOR_QUESTION.id,
      optionId: optionIdOf(voteState, null),
    });
    expect(anaAtVote.voteOptions?.ownOptionId).toBe(optionIdOf(voteState, ANA));
    expect(anaAtVote.myReveal).toBeNull();
    expect(anaAtVote.myScores).toBeNull();

    const scoresState = stepState(steps, 'multiple choice scores');
    const anaAtScores = playerState(scoresState, ANA);
    expect(anaAtScores.question?.questionId).toBe(MULTIPLE_CHOICE_QUESTION.id);
    expect(anaAtScores.myAnswer?.payload).toEqual({
      type: 'multiple_choice',
      optionIndex: 1,
    });
    expect(anaAtScores.reveal?.questionId).toBe(MULTIPLE_CHOICE_QUESTION.id);
    expect(anaAtScores.scores?.scope).toBe('question');
    expect(anaAtScores.myReveal).toEqual({
      phaseId: anaAtScores.reveal?.phaseId,
      questionId: MULTIPLE_CHOICE_QUESTION.id,
      hasAnswered: true,
      ownAnswerId: answerOf(scoresState, ANA).answerId,
      isCorrect: true,
      correctPositions: null,
      pointsAwarded: 900,
      streakBonus: 100,
      isJokerActive: false,
      streak: 1,
      score: 900,
      teamScore: null,
      rank: 1,
    });
    expect(anaAtScores.myScores).toEqual({
      phaseId: scoresState.cursor.phaseId,
      rank: 1,
      score: 900,
      previousScore: 0,
      ownScore: 900,
    });
    expect(
      playerState(stepState(steps, 'order reveal'), BEA).myReveal,
    ).toMatchObject({
      hasAnswered: true,
      isCorrect: false,
      correctPositions: 0,
    });

    const lateJoinerAtOpen = playerState(
      stepState(steps, 'multiple choice open'),
      DANI,
    );
    expect(lateJoinerAtOpen.me?.playerId).toBe(DANI);
    expect(lateJoinerAtOpen.isEligibleForQuestion).toBe(false);
    expect(lateJoinerAtOpen.myAnswer).toBeNull();
    const lateJoinerAtScores = playerState(scoresState, DANI);
    expect(lateJoinerAtScores.myReveal).toBeNull();
    expect(lateJoinerAtScores.myScores).toMatchObject({ rank: 2, score: 0 });
    expect(
      playerState(stepState(steps, 'true or false read'), DANI)
        .isEligibleForQuestion,
    ).toBe(true);

    const newcomer = playerState(voteState, null);
    expect(newcomer.me).toBeNull();
    expect(newcomer.suggestedScreenName).toBe('Alex');
    expect(newcomer.isEligibleForQuestion).toBe(false);
    expect(newcomer.myAnswer).toBeNull();

    const mutedState = structuredClone(voteState);
    expect(playerState(mutedState, ANA).isScreenMuted).toBe(false);
    mutedState.isScreenMuted = true;
    expect(
      buildSessionState(mutedState, { role: 'screen' }).isScreenMuted,
    ).toBe(true);
    expect(buildSessionState(mutedState, { role: 'host' }).isScreenMuted).toBe(
      true,
    );
    expect(playerState(mutedState, ANA).isScreenMuted).toBe(true);
  });

  it('a reconnect in party reveal tells the author which entry is theirs', () => {
    const steps = playSession();
    const revealState = stepState(steps, 'lie detector reveal');
    const anaAnswerId = answerOf(revealState, ANA).answerId;
    const anaReveal = playerState(revealState, ANA).myReveal;
    expect(anaReveal?.ownAnswerId).toBe(anaAnswerId);
    expect(anaReveal?.ownAnswerId).toBe(
      buildMyReveal(revealState, ANA)?.ownAnswerId,
    );
    const entries = buildReveal(revealState)?.distribution;
    if (entries?.kind !== 'votes') throw new Error('Expected a votes reveal');
    const ownEntries = entries.entries.filter(
      (entry) => entry.answerId === anaReveal?.ownAnswerId,
    );
    expect(ownEntries).toHaveLength(1);
    expect(ownEntries[0]?.authorName).toBe('Ana');
    expect(playerState(revealState, BEA).myReveal?.ownAnswerId).toBe(
      answerOf(revealState, BEA).answerId,
    );
  });

  it("marks the receiving player's own option in vote options", () => {
    const steps = playSession();
    const voteState = stepState(steps, 'lie detector vote');
    expect(buildVoteOptions(voteState, ANA)?.ownOptionId).toBe(
      optionIdOf(voteState, ANA),
    );
    expect(buildVoteOptions(voteState, BEA)?.ownOptionId).toBe(
      optionIdOf(voteState, BEA),
    );
    expect(buildVoteOptions(voteState, CRIS)?.ownOptionId).toBeNull();
    expect(buildVoteOptions(voteState, DANI)?.ownOptionId).toBeNull();
    expect(buildVoteOptions(voteState, null)?.ownOptionId).toBeNull();
    expect(buildHostVoteOptions(voteState)?.ownOptionId).toBeNull();
    expect(
      buildHostVoteOptions(voteState)?.options.find(
        (voteOption) => voteOption.isTruth,
      ),
    ).toEqual({
      optionId: stepOption(steps, 'lie detector vote', null),
      text: LIE_DETECTOR_TRUTH,
      answerId: null,
      authorName: null,
      isTruth: true,
    });

    const captionVoteState = stepState(steps, 'caption vote');
    const crisOptions = buildVoteOptions(captionVoteState, CRIS);
    expect(crisOptions?.ownOptionId).toBeNull();
    expect(crisOptions?.options).toHaveLength(2);
    expect(JSON.stringify(crisOptions)).not.toContain(HIDDEN_CAPTION);
    expect(buildVoteOptions(captionVoteState, BEA)?.ownOptionId).toBe(
      optionIdOf(captionVoteState, BEA),
    );
    expect(
      buildVoteOptions(stepState(steps, 'caption review'), ANA),
    ).toBeNull();
  });

  it('keeps the revealed question through scores and clears it on the leaderboard and podium', () => {
    const steps = playSession();
    const questionIdAt = (label: string, audience: 'public' | 'host') =>
      buildPhaseChange(stepState(steps, label), audience).question
        ?.questionId ?? null;

    for (const audience of ['public', 'host'] as const) {
      expect(questionIdAt('multiple choice reveal', audience)).toBe(
        MULTIPLE_CHOICE_QUESTION.id,
      );
      expect(questionIdAt('multiple choice scores', audience)).toBe(
        MULTIPLE_CHOICE_QUESTION.id,
      );
      expect(questionIdAt('lie detector reveal', audience)).toBe(
        LIE_DETECTOR_QUESTION.id,
      );
      for (const label of [
        'lobby',
        'quiz intro',
        'quiz leaderboard',
        'party leaderboard',
        'podium',
        'ended',
      ]) {
        expect({ label, questionId: questionIdAt(label, audience) }).toEqual({
          label,
          questionId: null,
        });
      }
    }
    expect(
      buildPhaseChange(stepState(steps, 'quiz leaderboard'), 'public').round
        ?.roundIndex,
    ).toBe(0);
    expect(
      buildPhaseChange(stepState(steps, 'podium'), 'public').round,
    ).toBeNull();
  });

  it('ends with the podium and results only when finished', () => {
    const steps = playSession();
    const podiumState = stepState(steps, 'podium');
    expect(buildPodiumFrame(podiumState)).toEqual({
      phaseId: podiumState.cursor.phaseId,
      entries: [
        expect.objectContaining({ place: 1, name: 'Ana', score: 5983 }),
        expect.objectContaining({ place: 2, name: 'Cris', score: 1600 }),
        expect.objectContaining({ place: 3, name: 'Bea', score: 1000 }),
      ],
    });
    expect(buildScores(podiumState)?.scope).toBe('final');

    const endedState = stepState(steps, 'ended');
    const finishedEnd = buildSessionEnd(endedState);
    expect(finishedEnd.status).toBe('finished');
    expect(finishedEnd.hasResults).toBe(true);
    expect(finishedEnd.nextEvent).toEqual(NEXT_EVENT);
    expect(finishedEnd.podium.map((entry) => entry.name)).toEqual([
      'Ana',
      'Cris',
      'Bea',
    ]);
    expect(buildSessionState(endedState, { role: 'screen' }).nextEvent).toEqual(
      NEXT_EVENT,
    );

    const abandonedState = structuredClone(
      stepState(steps, 'quiz leaderboard'),
    );
    setSessionStatus(abandonedState, 'abandoned');
    expect(buildSessionEnd(abandonedState)).toEqual({
      sessionId: SESSION_ID,
      status: 'abandoned',
      podium: [],
      nextEvent: null,
      hasResults: false,
    });
  });

  it('a reconnecting player is eligible for the question paused by a restart', () => {
    const steps = playSession();
    const openState = stepState(steps, 'multiple choice open');
    expect(playerState(openState, ANA).isEligibleForQuestion).toBe(true);
    expect(playerState(openState, DANI).isEligibleForQuestion).toBe(false);

    const recoveryState = structuredClone(openState);
    recoveryState.current = null;
    recoveryState.cursor.isRestartRecovery = true;
    recoveryState.cursor.deadline = null;
    recoveryState.cursor.extraTimeDeadline = null;
    recoveryState.pausedAt = 50_000;
    setSessionStatus(recoveryState, 'paused');

    const anaAfterRestart = playerState(recoveryState, ANA);
    expect(anaAfterRestart.cursor.isRestartRecovery).toBe(true);
    expect(anaAfterRestart.question?.questionId).toBe(
      MULTIPLE_CHOICE_QUESTION.id,
    );
    expect(anaAfterRestart.me?.playerId).toBe(ANA);
    expect(anaAfterRestart.isEligibleForQuestion).toBe(true);
    expect(anaAfterRestart.myAnswer).toBeNull();
    expect(anaAfterRestart.myVote).toBeNull();
    expect(playerState(recoveryState, DANI).isEligibleForQuestion).toBe(true);
    expect(playerState(recoveryState, null).isEligibleForQuestion).toBe(false);
  });

  it('names the rooms', () => {
    expect(quizshowRoomName(SESSION_ID, 'screen')).toBe(
      'qs:session-pride-night:screen',
    );
    expect(quizshowRoomName(SESSION_ID, 'players')).toBe(
      'qs:session-pride-night:players',
    );
    expect(quizshowRoomName(SESSION_ID, 'hosts')).toBe(
      'qs:session-pride-night:hosts',
    );
    expect(quizshowPlayerRoomName(SESSION_ID, ANA)).toBe(
      'qs:session-pride-night:player:player-ana',
    );
  });
});
