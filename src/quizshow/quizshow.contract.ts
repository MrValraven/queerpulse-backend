/**
 * Pulse Live (`quizshow`) wire contract: pure vocabulary, no imports.
 * Frontend mirror (by hand, same names and string values):
 * `queerpulse/src/shared/contracts/quizshow.ts`.
 */

export const QUIZSHOW_ROUND_KINDS = [
  'quiz',
  'lie_detector',
  'caption_this',
  'drag_name',
] as const;
export type QuizshowRoundKind = (typeof QUIZSHOW_ROUND_KINDS)[number];
/** Rounds whose questions are all `prompt` and whose answers players write. */
export const QUIZSHOW_PARTY_ROUND_KINDS = [
  'lie_detector',
  'caption_this',
  'drag_name',
] as const;

export const QUIZSHOW_QUESTION_TYPES = [
  'multiple_choice',
  'true_false',
  'type_answer',
  'order',
  'closest_number',
  'prompt',
] as const;
export type QuizshowQuestionType = (typeof QUIZSHOW_QUESTION_TYPES)[number];

export const QUIZSHOW_CONTENT_LABELS = [
  'none',
  'spicy',
  'sensitive',
  'adults',
] as const;
export type QuizshowContentLabel = (typeof QUIZSHOW_CONTENT_LABELS)[number];

/** `quiz.languages`: which languages the host writes in. */
export const QUIZSHOW_LANGUAGE_MODES = ['en', 'pt', 'both'] as const;
export type QuizshowLanguageMode = (typeof QUIZSHOW_LANGUAGE_MODES)[number];
export const QUIZSHOW_LANGUAGES = ['en', 'pt'] as const;
export type QuizshowLanguage = (typeof QUIZSHOW_LANGUAGES)[number];

export const QUIZSHOW_SESSION_STATUSES = [
  'lobby',
  'running',
  'paused',
  'finished',
  'abandoned',
] as const;
export type QuizshowSessionStatus = (typeof QUIZSHOW_SESSION_STATUSES)[number];
/** The statuses that hold the join code and show the event-page banner. */
export const QUIZSHOW_OPEN_SESSION_STATUSES = [
  'lobby',
  'running',
  'paused',
] as const;

export const QUIZSHOW_PLAY_MODES = ['solo', 'teams'] as const;
export type QuizshowPlayMode = (typeof QUIZSHOW_PLAY_MODES)[number];

export const QUIZSHOW_PHASES = [
  'lobby', // waiting room, players join
  'round_intro', // round title card with its content label; jokers are played here
  'read', // quiz question shown, 4 s, no answers accepted
  'open', // quiz question accepting answers
  'write', // party question accepting written answers
  'review', // party submissions on the host remote; screen shows "checking"
  'vote', // party: players vote on approved submissions
  'reveal', // correct answer / authors, points
  'scores', // quiz rounds only: top of the leaderboard after a question
  'leaderboard', // between rounds
  'podium', // 3rd, 2nd, 1st
  'ended', // thank-you screen; status is finished or abandoned
] as const;
export type QuizshowPhase = (typeof QUIZSHOW_PHASES)[number];
/** Phases with a server deadline. Every other phase waits for a host. */
export const QUIZSHOW_TIMED_PHASES = ['read', 'open', 'write', 'vote'] as const;

export const QUIZSHOW_ATTACH_ROLES = ['screen', 'player', 'host'] as const;
export type QuizshowAttachRole = (typeof QUIZSHOW_ATTACH_ROLES)[number];

/** Eight team keys. The frontend pairs each with a colour token and an icon
 *  (both themes, colour-blind safe); the wire carries the key alone. */
export const QUIZSHOW_TEAM_COLOR_KEYS = [
  'circle',
  'triangle',
  'square',
  'diamond',
  'star',
  'hexagon',
  'heart',
  'moon',
] as const;
export type QuizshowTeamColorKey = (typeof QUIZSHOW_TEAM_COLOR_KEYS)[number];

export const QUIZSHOW_STARTER_PACK_KEYS = [
  'pride_history',
  'portuguese_queer_culture',
  'eurovision',
  'drag_herstory',
] as const;
export type QuizshowStarterPackKey =
  (typeof QUIZSHOW_STARTER_PACK_KEYS)[number];

/** Every coded refusal, REST bodies and socket acks alike. */
export const QUIZSHOW_ERROR_CODES = [
  // REST
  'quizshow_event_not_found',
  'quizshow_not_organiser',
  'quizshow_cohost_is_playing',
  'quizshow_quiz_changed',
  'quizshow_quiz_invalid',
  'quizshow_adults_round_needs_adults_event',
  'quizshow_quiz_has_adults_rounds',
  'quizshow_pack_not_found',
  'quizshow_import_source_not_found',
  'quizshow_import_same_event',
  'quizshow_quiz_not_found',
  'quizshow_quiz_incomplete',
  'quizshow_session_already_open',
  'quizshow_results_exist',
  'quizshow_event_not_playable',
  'quizshow_join_code_not_found',
  'quizshow_session_finished',
  'quizshow_banned_from_event',
  'quizshow_cannot_view_event',
  'quizshow_player_removed',
  'quizshow_organiser_running',
  'quizshow_session_full',
  'quizshow_results_not_found',
  // socket
  'quizshow_session_not_found',
  'quizshow_already_attached',
  'quizshow_not_attached',
  'quizshow_wrong_role',
  'quizshow_not_joined',
  'quizshow_stale_phase',
  'quizshow_command_not_allowed',
  'quizshow_phase_closed',
  'quizshow_not_eligible',
  'quizshow_wrong_question',
  'quizshow_invalid_answer',
  'quizshow_text_blank',
  'quizshow_text_blocked',
  'quizshow_fake_too_close',
  'quizshow_vote_option_not_found',
  'quizshow_own_answer_vote',
  'quizshow_team_not_found',
  'quizshow_team_full',
  'quizshow_team_limit',
  'quizshow_team_name_taken',
  'quizshow_team_color_taken',
  'quizshow_team_required',
  'quizshow_team_change_closed',
  'quizshow_joker_used',
  'quizshow_joker_not_allowed',
  'quizshow_no_players',
  'quizshow_player_not_found',
  'quizshow_answer_not_found',
  'quizshow_rate_limited',
  // existing, reused as is
  'ACCOUNT_RESTRICTED',
] as const;
export type QuizshowErrorCode = (typeof QUIZSHOW_ERROR_CODES)[number];

/** Problem codes inside `quizshow_quiz_invalid` and `quizshow_quiz_incomplete` (section 2). */
export const QUIZSHOW_QUIZ_PROBLEM_CODES = [
  'too_many_rounds',
  'too_many_questions',
  'too_many_questions_in_round',
  'question_type_not_allowed',
  'option_count',
  'option_ids_not_unique',
  'answer_out_of_range',
  'order_answer_not_permutation',
  'answer_not_allowed',
  'no_rounds',
  'title_missing',
  'round_empty',
  'prompt_missing',
  'option_text_missing',
  'answer_missing',
  'truth_missing',
  'media_missing',
] as const;
export type QuizshowQuizProblemCode =
  (typeof QUIZSHOW_QUIZ_PROBLEM_CODES)[number];

/** Unambiguous: no I, L, O, 0, 1. */
export const QUIZSHOW_JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const QUIZSHOW_JOIN_CODE_PATTERN =
  /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/** Limits and scoring numbers; the frontend mirror carries the same names and values. */
export const QUIZSHOW_LIMITS = {
  quizTitleMax: 120,
  roundTitleMax: 80,
  promptMax: 280,
  optionTextMax: 80,
  answerTextMax: 80,
  acceptedAnswersMax: 10,
  acceptedAnswerMax: 80,
  roundsMax: 10,
  questionsPerQuizMax: 50,
  questionsPerRoundMax: 20,
  multipleChoiceOptionsMin: 2,
  multipleChoiceOptionsMax: 4,
  orderItemsMin: 3,
  orderItemsMax: 6,
  optionIdPattern: /^[a-z0-9]{1,12}$/,
  pointsValues: [500, 1000, 2000] as const,
  pointsDefault: 1000,
  timeLimitSecondsMin: 5,
  timeLimitSecondsMax: 120,
  timeLimitSecondsDefault: 20,
  writeSecondsMin: 15,
  writeSecondsMax: 180,
  writeSecondsDefault: 60,
  voteSecondsMin: 10,
  voteSecondsMax: 90,
  voteSecondsDefault: 30,
  numberAbsMax: 1e12,
  screenNameMax: 30,
  teamNameMax: 40,
  partyTextMax: 80,
  typedAnswerMax: 80,
  playersPerSessionMax: 150,
  teamsPerSessionMax: 8,
  maxTeamSizeMin: 2,
  maxTeamSizeMax: 20,
  readPhaseMs: 4000,
  answerGraceMs: 500,
  extraTimeFactor: 1.5,
  addTimeSecondsMin: 5,
  addTimeSecondsMax: 60,
  streakStep: 100,
  streakCap: 500,
  jokerMultiplier: 2,
  closestNumberBand: 0.1,
  lieDetectorTruthPoints: 1000,
  lieDetectorFooledPoints: 500,
  partyVotePoints: 250,
  hostFavouritePoints: 500,
  leaderboardTopCount: 10,
  abandonAfterMs: 7_200_000,
  retentionDays: 30,
  finishedCodeMemoryHours: 12,
  guestPushCooldownMs: 7_200_000,
  importSourcesMax: 50,
} as const;

/** Every bilingual field. A language the quiz does not use may hold ''. */
export interface QuizshowText {
  en: string;
  pt: string;
}

export interface QuizshowRoundSettings {
  timeLimitSeconds: number; // quiz rounds; default 20
  isSpeedBonusOn: boolean; // quiz rounds; default true ("Faster answers score more")
  isJokerAllowed: boolean; // every kind; default true
  writeSeconds: number; // party rounds; default 60
  voteSeconds: number; // party rounds; default 30
}
// All five are always present on every round. A round ignores the ones its
// kind does not use; they are stored as sent.

export interface QuizshowOption {
  id: string;
  text: QuizshowText;
}

export interface QuizshowQuestionBase {
  prompt: QuizshowText;
  /** Bare storage key from `POST /uploads/presign` with kind `event-cover`
   *  (validated with `@IsImageReference()`), or null. */
  mediaRef: string | null;
  /** null falls back to the round's `timeLimitSeconds`. Always null on `prompt`. */
  timeLimitSeconds: number | null;
  /** 500 | 1000 | 2000. Stored on `prompt` questions and ignored there. */
  points: number;
}

export type QuizshowQuestionInput =
  | (QuizshowQuestionBase & {
      type: 'multiple_choice';
      options: QuizshowOption[];
      answer: { correctIndex: number } | null;
      acceptedAnswers: [];
    })
  | (QuizshowQuestionBase & {
      type: 'true_false';
      options: [];
      answer: { isTrue: boolean } | null;
      acceptedAnswers: [];
    })
  | (QuizshowQuestionBase & {
      type: 'type_answer';
      options: [];
      answer: { text: QuizshowText } | null;
      acceptedAnswers: string[];
    })
  | (QuizshowQuestionBase & {
      type: 'order';
      options: QuizshowOption[];
      answer: { orderedIds: string[] } | null;
      acceptedAnswers: [];
    })
  | (QuizshowQuestionBase & {
      type: 'closest_number';
      options: [];
      answer: { value: number } | null;
      acceptedAnswers: [];
    })
  /** Party rounds only. Lie Detector: the real question plus `answer.truth`.
   *  Caption This: `mediaRef` required, prompt optional, `answer` null.
   *  Drag Name Generator: prompt required, `answer` null. */
  | (QuizshowQuestionBase & {
      type: 'prompt';
      options: [];
      answer: { truth: QuizshowText } | null;
      acceptedAnswers: [];
    });

export interface QuizshowRoundInput {
  kind: QuizshowRoundKind;
  title: QuizshowText;
  contentLabel: QuizshowContentLabel;
  settings: QuizshowRoundSettings;
  questions: QuizshowQuestionInput[]; // array order is `position`
}

/** `PUT /events/:slug/quizshow` body. No ids: every save replaces the quiz and
 *  mints new round and question ids, returned in the response. */
export interface QuizshowQuizInput {
  /** `quiz.updatedAt` from the last GET/PUT/import, or null when the event had no quiz. */
  expectedUpdatedAt: string | null;
  title: string;
  languages: QuizshowLanguageMode;
  screenLanguage: QuizshowLanguage;
  rounds: QuizshowRoundInput[]; // array order is `position`
}

/** What GET, PUT and import read back. */
export type QuizshowQuestion = QuizshowQuestionInput & {
  id: string; // uuid; becomes the `questionId` in the session snapshot
  mediaUrl: string | null; // `toImageUrl(mediaRef)`
};
export interface QuizshowRound extends Omit<QuizshowRoundInput, 'questions'> {
  id: string;
  questions: QuizshowQuestion[];
}
export interface QuizshowQuiz {
  title: string;
  languages: QuizshowLanguageMode;
  screenLanguage: QuizshowLanguage;
  starterPackKey: QuizshowStarterPackKey | null; // read only; set by a pack import, copied by an event import
  updatedAt: string;
  rounds: QuizshowRound[];
}

export interface QuizshowLiveSessionRef {
  sessionId: string;
  joinCode: string;
  status: 'lobby' | 'running' | 'paused';
  playMode: QuizshowPlayMode;
  playerCount: number;
  startedAt: string;
}

/** GET, PUT and import response. */
export interface QuizshowQuizResponse {
  quiz: QuizshowQuiz | null;
  /** Completeness problems (table below). [] when the quiz is ready or null. */
  problems: QuizshowQuizProblem[];
  /** `formatDetails.isAdultsOnly === true` on this event: the `adults` label is selectable. */
  isAdultsEvent: boolean;
  liveSession: QuizshowLiveSessionRef | null;
  hasResults: boolean;
}

export interface QuizshowQuizProblem {
  code: QuizshowQuizProblemCode;
  roundIndex: number | null;
  questionIndex: number | null;
  language: QuizshowLanguage | null;
}

export interface QuizshowImportSource {
  eventSlug: string;
  eventTitle: string;
  startAt: string;
  quizTitle: string;
  roundCount: number;
  questionCount: number;
  hasAdultsRounds: boolean;
  /** Same `seriesId` as `:slug`. The empty state's "Copy from the last event in
   *  this series" picks the first item with this flag and `startAt` before the event. */
  isSameSeries: boolean;
}

export interface QuizshowStarterPackCard {
  key: QuizshowStarterPackKey;
  title: QuizshowText;
  description: QuizshowText;
  languages: QuizshowLanguageMode; // 'both' for all four
  roundCount: number;
  questionCount: number;
  hasAdultsRounds: boolean; // false for all four in v1
}

export interface QuizshowOpenSessionInput {
  playMode: QuizshowPlayMode;
  maxTeamSize: number | null; // teams only, 2..20; null = no cap. Must be null in solo.
  isReviewOn: boolean; // default true in the UI
  notifyGuests: boolean; // "Let guests know", default true in the UI
  /** true after the host confirmed that opening deletes the event's kept results. */
  shouldReplaceResults: boolean;
}

export interface QuizshowJoinResponse {
  sessionId: string;
  eventSlug: string;
  eventTitle: string;
  status: 'lobby' | 'running' | 'paused';
  /** The caller already has a player row in this session (reconnect, second device). */
  isRejoin: boolean;
}

export interface QuizshowResultsPodiumEntry {
  place: 1 | 2 | 3; // competition ranking; ties share a place
  kind: 'player' | 'team';
  name: string; // screen name or team name
  colorKey: QuizshowTeamColorKey | null; // teams only
  score: number;
  isMine: boolean; // the viewer, or the viewer's team
}

export interface QuizshowResultsResponse {
  sessionId: string;
  playMode: QuizshowPlayMode;
  startedAt: string;
  endedAt: string;
  podium: QuizshowResultsPodiumEntry[]; // every entry with place <= 3, place ASC then name
  /** The viewer's own placing (their team's in teams mode); null for a viewer who did not play. */
  me: {
    place: number;
    score: number;
    teamName: string | null;
    teamColorKey: QuizshowTeamColorKey | null;
  } | null;
  playerCount: number;
  teamCount: number | null; // null in solo
  /** Organisers only (a co-host who played sees it once the session ended); null for everyone else. */
  recap: QuizshowRecap | null;
}

export interface QuizshowRecap {
  questionsPlayed: number;
  answersGiven: number;
  questions: QuizshowRecapQuestion[];
}
export interface QuizshowRecapQuestion {
  roundIndex: number;
  questionIndex: number;
  roundKind: QuizshowRoundKind;
  type: QuizshowQuestionType;
  prompt: QuizshowText;
  answerCount: number;
  /** 0..100 integer: share of eligible players who scored the full base. null on party questions. */
  percentCorrect: number | null;
  /** Mean `receivedAt - phaseStartedAt` of `open`; null on party questions. */
  averageAnswerMs: number | null;
  wasSkipped: boolean;
}

/** `GET /quizshow/packs` source data: a starter pack with its full quiz. */
export type QuizshowStarterPackQuiz = Omit<
  QuizshowQuizInput,
  'expectedUpdatedAt'
>;
export interface QuizshowStarterPack {
  key: QuizshowStarterPackKey;
  title: QuizshowText;
  description: QuizshowText;
  quiz: QuizshowStarterPackQuiz;
}

/** The `quizshow` field of `EventDetail`; null while the feature is not launched. */
export interface QuizshowEventDetail {
  hasQuiz: boolean;
  /** The open session's code while its status is lobby/running/paused (an abandoned
   *  check runs while building the DTO). null for viewers barred from the event. */
  liveSessionCode: string | null;
  /** Kept results exist AND this viewer may open them (organiser, going RSVP, or played). */
  hasResults: boolean;
}

export type QuizshowScoresScope = 'question' | 'round' | 'final';

export const QUIZSHOW_PUSH_COPY_KEYS = {
  startingTitle: 'push:quizshow.starting.title',
  startingBody: 'push:quizshow.starting.body',
} as const;

/** Same codes as `ChatWsErrorCode` in FE `realtime.ts`. */
export type QuizshowWsTransportCode =
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'SESSION_REVOKED'
  | 'PLATFORM_LOCKED'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR';

/** `exception` frame: handshake refusals (then disconnect), `TOKEN_EXPIRED`
 *  (then disconnect), and payloads the ValidationPipe rejects (socket stays up,
 *  no ack is called). A handshake while the feature is off answers `NOT_FOUND`. */
export interface QuizshowExceptionFrame {
  status: 'error';
  code: QuizshowWsTransportCode;
  message: unknown; // display copy, or the class-validator error array
  domainCode?: string;
  statusCode?: number;
}

export type QuizshowAck<Success extends object = Record<string, never>> =
  ({ ok: true } & Success) | QuizshowAckFailure;

export interface QuizshowAckFailure {
  ok: false;
  code: QuizshowErrorCode;
  message: string; // English, for logs; the FE maps `code` to copy
  /** On `quizshow_stale_phase` and `quizshow_command_not_allowed`: the current cursor. */
  cursor?: QuizshowCursor;
}

export interface QuizshowCursor {
  /** Opaque. Decimal string of a per-session counter that increases on every
   *  phase transition and on a restart replay; checkpointed in `cursor` jsonb.
   *  Compare by equality only. Pause, resume and addTime keep it. */
  phaseId: string;
  status: QuizshowSessionStatus;
  phase: QuizshowPhase;
  roundIndex: number | null; // 0-based; null in lobby, podium, ended
  questionIndex: number | null; // 0-based within the round; null outside question phases
  roundCount: number;
  phaseStartedAt: number | null; // server epoch ms
  /** Standard deadline, server epoch ms. null on untimed phases and while paused. */
  deadline: number | null;
  /** The ×1.5 deadline for players with `hasExtraTime` (open, write, vote).
   *  null when the phase has none or while paused. */
  extraTimeDeadline: number | null;
  pausedRemainingMs: number | null; // set while paused in a timed phase
  pausedExtraTimeRemainingMs: number | null;
  /** Paused by a server restart. `host:resume` replays the question from its
   *  first phase (`read` or `write`), discarding that question's answers and votes. */
  isRestartRecovery: boolean;
}

export type QuizshowAnswerPayload =
  | { type: 'multiple_choice'; optionIndex: number }
  | { type: 'true_false'; isTrue: boolean }
  | { type: 'type_answer'; text: string } // 1..80 after trim
  | { type: 'order'; orderedIds: string[] } // a permutation of the shown option ids
  | { type: 'closest_number'; value: number }
  | { type: 'prompt'; text: string }; // party: 1..80 after trim

/** What the server stored, with no correctness in it. */
export interface QuizshowMyAnswer {
  questionId: string;
  phaseId: string;
  payload: QuizshowAnswerPayload; // trimmed as stored
  receivedAt: number;
}
export interface QuizshowMyVote {
  questionId: string;
  optionId: string;
}

export interface QuizshowRoundCard {
  roundIndex: number;
  kind: QuizshowRoundKind;
  title: QuizshowText;
  contentLabel: QuizshowContentLabel;
  questionCount: number;
  isJokerAllowed: boolean;
  isSpeedBonusOn: boolean;
}

/** Screen and players. Carries no answer key. */
export interface QuizshowQuestionView {
  questionId: string;
  roundIndex: number;
  questionIndex: number;
  roundKind: QuizshowRoundKind;
  type: QuizshowQuestionType;
  prompt: QuizshowText;
  mediaUrl: string | null;
  points: number;
  /** Effective standard limit of `open` (quiz) or `write` (party), seconds. */
  timeLimitSeconds: number;
  /** MC: authored order (index = `optionIndex`). Order: shuffled at lobby open
   *  into an order that differs from the correct one. Every other type: null. Sent from `read` on. */
  options: QuizshowOption[] | null;
}

export type QuizshowAnswerKeyView =
  | { type: 'multiple_choice'; correctIndex: number }
  | { type: 'true_false'; isTrue: boolean }
  | { type: 'type_answer'; text: QuizshowText; acceptedAnswers: string[] }
  | { type: 'order'; orderedIds: string[] }
  | { type: 'closest_number'; value: number }
  | { type: 'lie_detector'; truth: QuizshowText };

/** Hosts only: the answer from the question's first phase. null on Caption This and Drag Name. */
export interface QuizshowHostQuestionView extends QuizshowQuestionView {
  answerKey: QuizshowAnswerKeyView | null;
}

export interface QuizshowPhaseChangeFrame {
  cursor: QuizshowCursor;
  round: QuizshowRoundCard | null;
  question: QuizshowQuestionView | QuizshowHostQuestionView | null; // null outside question phases
}

export interface QuizshowLobbyPlayer {
  playerId: string;
  screenName: string;
  teamId: string | null;
  avatarUrl: string | null; // screen and hosts only; always null to players
}
export interface QuizshowLobbyTeam {
  teamId: string;
  name: string;
  colorKey: QuizshowTeamColorKey;
  memberCount: number;
}
export interface QuizshowLobby {
  players: QuizshowLobbyPlayer[]; // joined order, removed players left out
  teams: QuizshowLobbyTeam[]; // [] in solo
  playerCount: number;
}
export interface QuizshowHostPlayer extends QuizshowLobbyPlayer {
  isCohostPlayer: boolean; // the remote's "co-host" tag
  hasExtraTime: boolean;
  hasUsedJoker: boolean;
  score: number;
  isConnected: boolean;
  joinedAt: number;
}
export interface QuizshowHostTeam extends QuizshowLobbyTeam {
  score: number;
  hasUsedJoker: boolean;
}
export interface QuizshowHostLobby {
  players: QuizshowHostPlayer[];
  teams: QuizshowHostTeam[];
  playerCount: number;
}

export interface QuizshowMe {
  playerId: string;
  screenName: string;
  isAvatarShown: boolean;
  hasExtraTime: boolean;
  teamId: string | null;
  isCohostPlayer: boolean;
  score: number;
  streak: number;
  hasUsedJoker: boolean; // own (solo) or team's (teams)
  jokerRoundIndex: number | null;
}

export interface QuizshowReviewSubmission {
  answerId: string;
  playerId: string; // for host:removePlayer
  screenName: string;
  text: string;
  isHidden: boolean;
  receivedAt: number;
}
export interface QuizshowReviewList {
  phaseId: string;
  questionId: string;
  submissions: QuizshowReviewSubmission[];
}

/** Option ids are opaque and minted per question, the truth's included, so no
 *  id format tells the truth apart. Approved, non-hidden submissions, shuffled. */
export interface QuizshowVoteOption {
  optionId: string;
  text: string;
}
export interface QuizshowVoteOptions {
  phaseId: string;
  questionId: string;
  options: QuizshowVoteOption[];
  ownOptionId: string | null; // the receiving player's own answer, which they cannot pick
}
export interface QuizshowHostVoteOptions extends Omit<
  QuizshowVoteOptions,
  'options'
> {
  options: Array<
    QuizshowVoteOption & {
      answerId: string | null;
      authorName: string | null;
      isTruth: boolean;
    }
  >;
}

export type QuizshowDistribution =
  | { kind: 'options'; counts: number[] } // multiple_choice, by option index
  | { kind: 'true_false'; trueCount: number; falseCount: number }
  | { kind: 'typed'; correctCount: number; incorrectCount: number } // counts only on every screen
  | {
      kind: 'order';
      exactCount: number;
      partialCount: number;
      noneCount: number;
    }
  | {
      kind: 'closest';
      closestValue: number | null;
      closestNames: string[];
      withinBandCount: number;
    }
  | {
      kind: 'votes';
      entries: QuizshowPartyRevealEntry[];
      favouriteOptionId: string | null;
    };

export interface QuizshowPartyRevealEntry {
  optionId: string;
  /** The report subject id. null for the Lie Detector truth. */
  answerId: string | null;
  text: string;
  authorName: string | null; // screen name; null for the truth
  isTruth: boolean;
  voteCount: number;
  authorPoints: number;
}

export interface QuizshowReveal {
  phaseId: string;
  questionId: string;
  /** null on Caption This and Drag Name. */
  correct: QuizshowAnswerKeyView | null;
  answeredCount: number;
  eligibleCount: number;
  distribution: QuizshowDistribution;
}

export interface QuizshowMyReveal {
  phaseId: string;
  questionId: string;
  hasAnswered: boolean;
  ownAnswerId: string | null; // the player's own answer row id on this question; null without an answer
  isCorrect: boolean | null; // null on party questions
  correctPositions: number | null; // order only
  pointsAwarded: number; // everything this question earned the player, streak and joker included
  streakBonus: number;
  isJokerActive: boolean;
  streak: number;
  score: number; // own running total
  teamScore: number | null; // teams only
  rank: number; // own rank (solo) or team rank (teams)
}

export interface QuizshowLeaderboardEntry {
  rank: number; // competition ranking: 1, 1, 3
  kind: 'player' | 'team';
  entrantId: string; // playerId or teamId
  name: string;
  colorKey: QuizshowTeamColorKey | null;
  score: number;
  previousScore: number; // for the RollingNumber count-up
}
export interface QuizshowScores {
  phaseId: string;
  scope: QuizshowScoresScope;
  entries: QuizshowLeaderboardEntry[]; // top 10
  entrantCount: number;
}
export interface QuizshowMyScores {
  phaseId: string;
  rank: number; // own or team rank
  score: number; // own or team score
  previousScore: number;
  ownScore: number; // the player's own total in teams mode, equal to score in solo
}

export interface QuizshowPodiumEntry {
  place: 1 | 2 | 3;
  kind: 'player' | 'team';
  entrantId: string;
  name: string;
  colorKey: QuizshowTeamColorKey | null;
  score: number;
}

export interface QuizshowNextEvent {
  slug: string;
  title: string;
  startAt: string;
}

export interface QuizshowSessionEnd {
  sessionId: string;
  status: 'finished' | 'abandoned';
  podium: QuizshowPodiumEntry[]; // [] when abandoned
  nextEvent: QuizshowNextEvent | null; // next occurrence of the event's series, when there is one
  hasResults: boolean;
}

export interface QuizshowStateBase {
  sessionId: string;
  eventSlug: string;
  eventTitle: string;
  joinCode: string;
  quizTitle: string;
  languages: QuizshowLanguageMode;
  screenLanguage: QuizshowLanguage;
  playMode: QuizshowPlayMode;
  maxTeamSize: number | null;
  isReviewOn: boolean;
  /** Screen sound muted by a host; in-memory, starts false, kept across reconnects for the session (coordinator addition 2026-10-19). Screen and host states carry it; players ignore it. */
  isScreenMuted: boolean;
  cursor: QuizshowCursor;
  rounds: QuizshowRoundCard[]; // the lobby's round list with content labels
  round: QuizshowRoundCard | null;
  reveal: QuizshowReveal | null; // during reveal, scores
  scores: QuizshowScores | null; // during scores, leaderboard, podium
  podium: QuizshowPodiumEntry[] | null;
  nextEvent: QuizshowNextEvent | null; // set in `ended`
}

export interface QuizshowScreenState extends QuizshowStateBase {
  role: 'screen';
  lobby: QuizshowLobby; // with avatars
  question: QuizshowQuestionView | null;
  answerCount: { count: number; total: number } | null;
  voteOptions: QuizshowVoteOptions | null;
}

export interface QuizshowPlayerState extends QuizshowStateBase {
  role: 'player';
  lobby: QuizshowLobby; // avatarUrl null
  question: QuizshowQuestionView | null;
  voteOptions: QuizshowVoteOptions | null;
  me: QuizshowMe | null; // null until `lobby:join`
  /** Member first name trimmed to 30; '' when it hits the blocked-term filter. */
  suggestedScreenName: string;
  isEligibleForQuestion: boolean; // false for a late joiner until the next question
  myAnswer: QuizshowMyAnswer | null; // for the current question
  myVote: QuizshowMyVote | null;
  myReveal: QuizshowMyReveal | null;
  myScores: QuizshowMyScores | null;
}

export interface QuizshowHostState extends QuizshowStateBase {
  role: 'host';
  lobby: QuizshowHostLobby;
  question: QuizshowHostQuestionView | null;
  answerCount: { count: number; total: number } | null;
  voteOptions: QuizshowHostVoteOptions | null;
  reviewList: QuizshowReviewList | null;
}

export type QuizshowSessionState =
  QuizshowScreenState | QuizshowPlayerState | QuizshowHostState;

export const QUIZSHOW_ANSWER_SNAPSHOT_TYPE = 'quizshow-answer-snapshot';
export interface QuizshowAnswerSnapshotEvidence {
  type: typeof QUIZSHOW_ANSWER_SNAPSHOT_TYPE;
  answerId: string;
  sessionId: string;
  eventId: string;
  eventSlug: string;
  roundKind: QuizshowRoundKind;
  questionPrompt: QuizshowText;
  text: string;
  authorScreenName: string;
  /** Server side only, for staff tooling. */
  authorUserId: string;
  receivedAt: string;
  wasHidden: boolean;
  capturedAt: string;
}
