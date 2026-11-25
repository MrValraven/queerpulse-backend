/**
 * Pulse Live (`quizshow`) wire contract: pure vocabulary with no runtime imports (type imports only).
 * Frontend mirror (by hand, same names and string values):
 * `queerpulse/src/shared/contracts/quizshow.ts`.
 */

import type {
  QuizshowResultsWinBadges,
  QuizshowWinBadgesPreview,
} from '../quiz-win-badges/quiz-win-badges.contract';

export const QUIZSHOW_ROUND_KINDS = [
  'quiz',
  'lie_detector',
  'caption_this',
  'drag_name',
  'wheel', // a wheel step: no questions; its slices are the rounds right after it
] as const;
export type QuizshowRoundKind = (typeof QUIZSHOW_ROUND_KINDS)[number];

/** Every kind that holds questions: the round kind picker and every kind-keyed copy map. */
export const QUIZSHOW_PLAYABLE_ROUND_KINDS = [
  'quiz',
  'lie_detector',
  'caption_this',
  'drag_name',
] as const;
export type QuizshowPlayableRoundKind =
  (typeof QUIZSHOW_PLAYABLE_ROUND_KINDS)[number];
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
  'poll', // quiz rounds only: 2..4 options, no answer, unscored (item 57)
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

/** What the screen shows. 'both' is allowed only when `languages` is 'both' (item 64). */
export const QUIZSHOW_SCREEN_LANGUAGES = ['en', 'pt', 'both'] as const;
export type QuizshowScreenLanguage = (typeof QUIZSHOW_SCREEN_LANGUAGES)[number];

/** The eight shapes; each comes in three tiers (item 26). */
export const QUIZSHOW_TEAM_SHAPES = [
  'circle',
  'triangle',
  'square',
  'diamond',
  'star',
  'hexagon',
  'heart',
  'moon',
] as const;
export type QuizshowTeamShape = (typeof QUIZSHOW_TEAM_SHAPES)[number];

export const QUIZSHOW_CLOSEST_TOLERANCE_MODES = [
  'exact',
  'absolute',
  'percent',
] as const;
export type QuizshowClosestToleranceMode =
  (typeof QUIZSHOW_CLOSEST_TOLERANCE_MODES)[number];

export const QUIZSHOW_MEDIA_REVEALS = ['instant', 'slow'] as const;
export type QuizshowMediaReveal = (typeof QUIZSHOW_MEDIA_REVEALS)[number];

/** Fixed reaction ids (item 46). FE maps each to a react-icons glyph component. */
export const QUIZSHOW_REACTION_IDS = [
  'heart',
  'fire',
  'clap',
  'laugh',
  'wow',
  'party',
] as const;
export type QuizshowReactionId = (typeof QUIZSHOW_REACTION_IDS)[number];

export const QUIZSHOW_TALK_SECONDS_VALUES = [0, 10, 20, 30] as const;
export type QuizshowTalkSeconds = (typeof QUIZSHOW_TALK_SECONDS_VALUES)[number];

export const QUIZSHOW_PAIRED_DEVICE_KINDS = ['screen', 'helper'] as const;
export type QuizshowPairedDeviceKind =
  (typeof QUIZSHOW_PAIRED_DEVICE_KINDS)[number];

export const QUIZSHOW_IMPORT_MODES = ['replace', 'append'] as const;
export type QuizshowImportMode = (typeof QUIZSHOW_IMPORT_MODES)[number];

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
  'read', // quiz question shown for readPhaseMsFor(question), no answers accepted
  'open', // quiz question accepting answers
  'write', // party question accepting written answers
  'review', // party submissions on the host remote; screen shows "checking"
  'vote', // party: players vote on approved submissions
  'reveal', // correct answer / authors, points
  'scores', // quiz rounds only: top of the leaderboard after a question
  'leaderboard', // between rounds
  'wheel', // the wheel picks what plays next; untimed, host-paced
  'podium', // 3rd, 2nd, 1st
  'ended', // thank-you screen; status is finished or abandoned
] as const;
export type QuizshowPhase = (typeof QUIZSHOW_PHASES)[number];
/** Phases with a server deadline. Every other phase waits for a host. */
export const QUIZSHOW_TIMED_PHASES = ['read', 'open', 'write', 'vote'] as const;

export const QUIZSHOW_ATTACH_ROLES = ['screen', 'player', 'host'] as const;
export type QuizshowAttachRole = (typeof QUIZSHOW_ATTACH_ROLES)[number];

/** 24 team keys: tier 1 keeps the old names, tiers 2 and 3 add a suffix. Order is the auto-assign order.
 *  The frontend pairs each with a colour token and an icon (both themes, colour-blind safe); the wire carries the key alone. */
export const QUIZSHOW_TEAM_COLOR_KEYS = [
  'circle',
  'triangle',
  'square',
  'diamond',
  'star',
  'hexagon',
  'heart',
  'moon',
  'circle_2',
  'triangle_2',
  'square_2',
  'diamond_2',
  'star_2',
  'hexagon_2',
  'heart_2',
  'moon_2',
  'circle_3',
  'triangle_3',
  'square_3',
  'diamond_3',
  'star_3',
  'hexagon_3',
  'heart_3',
  'moon_3',
] as const;
export type QuizshowTeamColorKey = (typeof QUIZSHOW_TEAM_COLOR_KEYS)[number];

export const QUIZSHOW_TEMPLATE_STATUSES = ['draft', 'published'] as const;
export type QuizshowTemplateStatus =
  (typeof QUIZSHOW_TEMPLATE_STATUSES)[number];

/** The card fields a publish checks; these are the `missing` details of `quizshow_template_card_incomplete`. */
export const QUIZSHOW_TEMPLATE_CARD_FIELDS = [
  'title.en',
  'title.pt',
  'description.en',
  'description.pt',
] as const;
export type QuizshowTemplateCardField =
  (typeof QUIZSHOW_TEMPLATE_CARD_FIELDS)[number];

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
  'quizshow_game_not_found',
  'quizshow_game_limit_reached',
  'quizshow_lobby_rate_limited',
  'quizshow_game_adults_rounds_need_switch',
  'quizshow_template_not_found',
  'quizshow_template_card_incomplete',
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
  'quizshow_adult_consent_required',
  'quizshow_wheel_not_spun',
  'quizshow_wheel_spinning',
  'quizshow_wheel_spin_too_few_rounds',
  'quizshow_wheel_already_next',
  'quizshow_joker_wheel_next',
  // item 8: the causes behind a refused host or player command
  'quizshow_session_not_started',
  'quizshow_already_started',
  'quizshow_session_paused',
  'quizshow_session_ended',
  'quizshow_spin_not_available',
  'quizshow_no_wheel_open',
  'quizshow_no_timer_running',
  'quizshow_already_revealed',
  'quizshow_nothing_to_reveal',
  'quizshow_nothing_to_skip',
  'quizshow_review_not_open',
  'quizshow_unhide_review_only',
  'quizshow_author_removed',
  'quizshow_favourite_not_available',
  'quizshow_teams_off',
  // Pulse Live v2 features
  'quizshow_screen_name_taken',
  'quizshow_joining_locked',
  'quizshow_not_in_lobby',
  'quizshow_move_during_question',
  'quizshow_player_left',
  'quizshow_rescore_not_now',
  'quizshow_accept_needs_typed_answer',
  'quizshow_change_needs_choice_question',
  'quizshow_answer_text_not_found',
  'quizshow_answer_already_correct',
  'quizshow_correct_option_not_found',
  'quizshow_every_option_correct',
  'quizshow_adjust_not_now',
  'quizshow_adjust_below_zero',
  'quizshow_entrant_not_found',
  'quizshow_pairing_code_not_found',
  'quizshow_pairing_code_expired',
  'quizshow_pairing_code_used',
  'quizshow_paired_devices_full',
  'quizshow_helper_cannot_pair',
  'quizshow_helper_is_playing',
  'quizshow_device_not_found',
  'quizshow_device_unpaired',
  'quizshow_device_ticket_expired',
  'quizshow_pairing_not_found',
  'quizshow_pairing_rate_limited',
  'quizshow_pairing_too_many_tries', // per host: 10 wrong pairing codes in 10 minutes
  'quizshow_guest_push_cooldown',
  'quizshow_guest_push_already_sent',
  'quizshow_guest_push_needs_event',
  'quizshow_guest_push_practice',
  'quizshow_refresh_quiz_incomplete',
  'quizshow_refresh_adults_mismatch',
  'quizshow_refresh_adults_lobby_joined',
  'quizshow_refresh_quiz_gone',
  'quizshow_rematch_not_found',
  'quizshow_rematch_expired',
  'quizshow_reaction_not_now',
  'quizshow_import_round_not_found',
  'quizshow_import_too_many_rounds',
  'quizshow_import_too_many_questions',
  'quizshow_import_too_many_wheels',
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
  'too_many_wheels',
  'wheel_too_few_slices',
  'correct_option_missing', // MC: correctIndexes empty
  'too_many_correct_options', // MC: correctIndexes covers every option
  'tolerance_out_of_range', // closest: amount outside the mode's range
  'poll_in_party_round', // poll outside a quiz round
  'slow_reveal_needs_picture', // mediaReveal 'slow' with mediaRef null
  'warm_up_not_first', // isWarmUp on a round other than the first playable round
] as const;
export type QuizshowQuizProblemCode =
  (typeof QUIZSHOW_QUIZ_PROBLEM_CODES)[number];

/** Unambiguous: no I, L, O, 0, 1. */
export const QUIZSHOW_JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const QUIZSHOW_JOIN_CODE_PATTERN =
  /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
/** TV pairing code: 6 digits from '23456789' (item 9). */
export const QUIZSHOW_PAIRING_CODE_PATTERN = /^[2-9]{6}$/;

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
  questionsPerQuizMax: 100,
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
  teamsPerSessionMax: 24,
  maxTeamSizeMin: 2,
  maxTeamSizeMax: 20,
  answerGraceMs: 500,
  extraTimeFactor: 1.5,
  addTimeSecondsMin: 5,
  addTimeSecondsMax: 60,
  streakStep: 100,
  streakCap: 500,
  jokerMultiplier: 2,
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
  templateCardTitleMax: 120,
  templateCardDescriptionMax: 300,
  templateStaffNotesMax: 20000,
  roundRowsMax: 13, // roundsMax + wheelStepsMax: every row of a quiz, wheels included
  wheelStepsMax: 3,
  wheelSlicesMin: 2,
  wheelSlicesMax: 8,
  wheelSpinMs: 5500,
  wheelSpinReducedMotionMs: 1200,
  wheelTurnsMin: 5,
  wheelTurnsMax: 6,
  wheelJitterSeedMax: 1000,
  wheelJitterSpread: 0.7, // share of one slice the landing may drift from its middle
  wheelPointerAngle: 270, // degrees clockwise from 12 o'clock: the pointer at 9 o'clock
  wheelLandingToleranceMs: 250,
  readPhaseBaseMs: 1500, // readPhaseMsFor (section 6.12) replaces the flat 4 s read
  readPhaseMsPerChar: 25,
  readPhaseMinMs: 3000,
  readPhaseMaxMs: 8000,
  closestPercentMin: 1, // tolerance is per question (section 6.1)
  closestPercentMax: 50,
  closestLegacyPercent: 10, // what a stored question without tolerance means
  revealNoteMax: 200,
  mediaAltMax: 200,
  numberUnitMax: 20,
  awayAfterMs: 20_000,
  latencyAllowanceMaxMs: 400,
  latencyProbeIntervalMs: 30_000,
  latencyProbeSamples: 5,
  latencyProbeTimeoutMs: 3_000,
  sessionPingTimeoutMs: 1_500, // FE only reads it
  pairingCodeLength: 6,
  pairingCodeTtlMs: 600_000,
  pairingPollMs: 2_000,
  pairedDevicesMax: 6,
  deviceTicketTtlMs: 43_200_000, // 12 h; also capped by the session staying open
  reactionBurst: 3,
  reactionRefillMs: 1_500,
  reactionsFrameMs: 500,
  autoAdvanceRoundIntroMs: 5_000,
  autoAdvanceRevealMs: 6_000,
  autoAdvanceScoresMs: 6_000,
  rematchWindowMs: 1_800_000,
  adjustPointsMax: 5_000, // |delta| per host:adjustPoints
  leaderboardStreakMin: 3,
  podiumWinnerHoldMs: 2_000, // FE: the held beat before 1st place
  hostTeamsPerCommandMax: 24,
  answerWriteCoalesceMs: 150,
} as const;

/** Every bilingual field. A language the quiz does not use may hold ''. */
export interface QuizshowText {
  en: string;
  pt: string;
}

export const QUIZSHOW_WHEEL_PICKS = ['round', 'question'] as const;
export type QuizshowWheelPick = (typeof QUIZSHOW_WHEEL_PICKS)[number];

export const QUIZSHOW_WHEEL_BONUS_VALUES = [0, 250, 500, 1000] as const;
export type QuizshowWheelBonus = (typeof QUIZSHOW_WHEEL_BONUS_VALUES)[number];

export interface QuizshowRoundSettings {
  timeLimitSeconds: number; // quiz rounds; default 20
  isSpeedBonusOn: boolean; // quiz rounds; default true ("Faster answers score more")
  isJokerAllowed: boolean; // every playable kind; default true; ignored on wheel rows
  writeSeconds: number; // party rounds; default 60
  voteSeconds: number; // party rounds; default 30
  /** A round inside a wheel's range: the flat bonus of its slice. 0 on every other row after a save. */
  wheelBonus: QuizshowWheelBonus; // default 0
  /** Wheel rows: what one spin picks. 'round' on every other row after a save. */
  wheelPick: QuizshowWheelPick; // default 'round'
  /** Wheel rows: 2..8 slices, null = Auto. null on every other row after a save. */
  sliceCount: number | null; // default null
  /** Quiz rounds: every question scores 0 and streaks stay as they were. Only the first playable row. Default false. */
  isWarmUp: boolean;
  /** Quiz rounds in teams play: seconds added to `read` for the team to talk. Default 0. Ignored in solo. */
  talkSeconds: QuizshowTalkSeconds;
}
// All ten are present on every round a GET, PUT, import or snapshot returns.
// Normalisation on save: wheel rows and party rows store isWarmUp false and talkSeconds 0.

export const QUIZSHOW_WHEEL_SETTINGS_DEFAULTS: Readonly<
  Pick<QuizshowRoundSettings, 'wheelBonus' | 'wheelPick' | 'sliceCount'>
> = { wheelBonus: 0, wheelPick: 'round', sliceCount: null };

/** What `host:next` opens from the lobby or a leaderboard. */
export type QuizshowUpNext =
  | { kind: 'round'; roundIndex: number }
  | { kind: 'wheel'; wheelRoundIndex: number }
  | { kind: 'podium' };

/** One slice: a round of the wheel's range (pick a round) or a category (pick a question). */
export interface QuizshowWheelSlice {
  roundIndex: number; // the slice round's row index
  title: QuizshowText; // the round title
  kind: QuizshowPlayableRoundKind;
  contentLabel: QuizshowContentLabel;
  wheelBonus: QuizshowWheelBonus; // always 0 on an unplanned spin
  /** Pick a round: the round's questions. Pick a question: questions still in the pile. */
  questionCount: number;
  /** Pick a round: the round has started. Pick a question: the pile is empty. */
  isPlayed: boolean;
}

/** One spin, decided by the server. Every surface animates to the same stop. */
export interface QuizshowWheelSpin {
  /** Index into the drawn slices: `slices` with `isPlayed` false, in running order. */
  landedSliceIndex: number;
  startedAt: number; // server epoch ms
  durationMs: number; // QUIZSHOW_LIMITS.wheelSpinMs (5500)
  turns: number; // 5 or 6 full turns
  jitterSeed: number; // integer 0..1000
  /** Wheel rotation in degrees when the spin starts. */
  startAngle: number;
}

export interface QuizshowWheelView {
  /** The wheel step's row; null for an unplanned spin from a leaderboard. */
  wheelRoundIndex: number | null;
  pick: QuizshowWheelPick; // always 'round' on an unplanned spin
  /** Every slice of the range in running order, played ones included. */
  slices: QuizshowWheelSlice[];
  spinNumber: number; // N of "spin N of M"
  spinTotal: number; // M of "spin N of M"
  /** null before the first spin, and once the landed pick has started. */
  spin: QuizshowWheelSpin | null;
  /** Pick a question, during the question it picked: that category's row. null in `wheel`. */
  playingRoundIndex: number | null;
}

export interface QuizshowWheelBonusWinner {
  entrantId: string; // playerId (solo) or teamId (teams)
  kind: 'player' | 'team';
  name: string;
  colorKey: QuizshowTeamColorKey | null;
}

/** "+500 to Ana for Music", shown on the screen that follows the award. */
export interface QuizshowWheelBonusView {
  points: QuizshowWheelBonus; // 250, 500 or 1000
  pick: QuizshowWheelPick;
  sliceRoundIndex: number;
  sliceTitle: QuizshowText;
  winners: QuizshowWheelBonusWinner[]; // entrant order of `entrantTotals`; 1+ entries
}

export interface QuizshowOption {
  id: string;
  text: QuizshowText;
}

export interface QuizshowClosestTolerance {
  mode: QuizshowClosestToleranceMode;
  /** 'exact': 0. 'absolute': 0 < amount <= numberAbsMax. 'percent': integer closestPercentMin..closestPercentMax. */
  amount: number;
}
export const QUIZSHOW_CLOSEST_TOLERANCE_DEFAULT: Readonly<QuizshowClosestTolerance> =
  {
    mode: 'exact',
    amount: 0,
  }; // new questions (call); stored questions migrate to { mode: 'percent', amount: 10 }

export interface QuizshowQuestionBase {
  prompt: QuizshowText;
  /** Bare storage key from `POST /uploads/presign` with kind `event-cover`
   *  (validated with `@IsImageReference()`), or null. */
  mediaRef: string | null;
  /** Describes the picture for screen readers; '' both when none. 0..mediaAltMax each. */
  mediaAlt: QuizshowText;
  /** 'slow' needs mediaRef and a quiz round. Default 'instant'. */
  mediaReveal: QuizshowMediaReveal;
  /** Shown with the answer at reveal ("Fun fact"); '' both when none. 0..revealNoteMax each. Never on prompt. */
  revealNote: QuizshowText;
  /** closest_number only: unit label shown by the number field ("years"); '' both on every other type. */
  numberUnit: QuizshowText;
  /** null falls back to the round's `timeLimitSeconds`. Always null on `prompt`. */
  timeLimitSeconds: number | null;
  /** 500 | 1000 | 2000. Stored on `prompt` questions and ignored there. */
  points: number;
}

export type QuizshowQuestionInput =
  | (QuizshowQuestionBase & {
      type: 'multiple_choice';
      options: QuizshowOption[];
      /** Sorted ascending, unique, 1..options.length - 1 entries (item 57). */
      answer: { correctIndexes: number[] } | null;
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
      answer: { value: number; tolerance: QuizshowClosestTolerance } | null;
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
    })
  | (QuizshowQuestionBase & {
      type: 'poll';
      options: QuizshowOption[]; // 2..4, same id rules as MC
      answer: null;
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
  screenLanguage: QuizshowScreenLanguage; // widened
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
export interface QuizshowSourceTemplateRef {
  templateId: string;
  title: QuizshowText; // the template's card title
  copiedAt: string; // when this quiz copied it
  lastPublishedAt: string; // the template's latest publish
  /** true when lastPublishedAt is after copiedAt. */
  hasUpdate: boolean;
  /** Staff note of the latest publish; '' both when none. */
  changeNote: QuizshowText;
}

export interface QuizshowQuiz {
  title: string;
  languages: QuizshowLanguageMode;
  screenLanguage: QuizshowScreenLanguage; // widened
  sourceTemplateId: string | null; // read only; set by a template import, copied by an event or game import, null once the template is deleted
  /** null when sourceTemplateId is null or the template is unpublished. */
  sourceTemplate: QuizshowSourceTemplateRef | null;
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
  isPractice: boolean;
  /** The quiz was saved after this lobby took its snapshot (item 18). Always false once running. */
  isBehindQuiz: boolean;
}

/** What the open dialog last used on this quiz (item 52). */
export interface QuizshowOpenSettingsMemory {
  playMode: QuizshowPlayMode;
  maxTeamSize: number | null;
  isReviewOn: boolean;
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
  lastOpenSettings: QuizshowOpenSettingsMemory | null;
}

export interface QuizshowQuizProblem {
  code: QuizshowQuizProblemCode;
  roundIndex: number | null;
  questionIndex: number | null;
  language: QuizshowLanguage | null;
}

/** Whether a quiz belongs to an event or stands alone as a game of one member. */
export type QuizshowScopeKind = 'event' | 'game';

export const QUIZSHOW_GAMES_PER_MEMBER_MAX = 50;
export const QUIZSHOW_LOBBY_OPENS_PER_HOUR_MAX = 10;

/** The import body: a published template, an event the caller organises, or a game the caller owns.
 *  Item 23: the three sources are unchanged; the new fields are optional for old clients. */
export type QuizshowImportInput = (
  | { from: 'template'; templateId: string }
  | { from: 'event'; eventSlug: string }
  | { from: 'game'; gameId: string }
) & {
  mode?: QuizshowImportMode; // default 'replace'
  /** append only: row indexes of the source to copy, in source order; null = every row. */
  roundIndexes?: number[] | null;
  /** append only, required there: the target quiz's updatedAt, or null when it has none. */
  expectedUpdatedAt?: string | null;
};

export interface QuizshowImportRoundRef {
  roundIndex: number;
  kind: QuizshowRoundKind;
  title: QuizshowText;
  questionCount: number;
  /** Wheel rows: 2..8 slices, null = Auto; null on every other row (item 23). */
  sliceCount: number | null;
  /** The round's 18+ label; an append holds only the adults rows when the event is not 18+. */
  contentLabel: QuizshowContentLabel;
}

export interface QuizshowGameSummary {
  id: string;
  title: string;
  roundCount: number;
  questionCount: number;
  isAdultsOnly: boolean;
  liveSession: QuizshowLiveSessionRef | null;
  hasResults: boolean;
  updatedAt: string;
}
export interface QuizshowGameListResponse {
  games: QuizshowGameSummary[]; // newest updatedAt first
  limit: number; // QUIZSHOW_GAMES_PER_MEMBER_MAX
}
export interface QuizshowCreateGameInput {
  title: string; // 1..120 after trim
  source: QuizshowImportInput | null; // null = blank game
}
/** PUT body: the quiz input plus the game's 18+ switch. */
export type QuizshowGameInput = QuizshowQuizInput & { isAdultsOnly: boolean };
/** `isAdultsEvent` mirrors `isAdultsOnly`, so the builder's adults-label gate reads one field for both kinds. */
export interface QuizshowGameResponse extends QuizshowQuizResponse {
  gameId: string;
  isAdultsOnly: boolean;
}

export interface QuizshowImportSource {
  kind: QuizshowScopeKind;
  eventSlug: string | null; // event sources
  eventTitle: string | null;
  startAt: string | null;
  gameId: string | null; // game sources
  quizTitle: string;
  roundCount: number;
  questionCount: number;
  hasAdultsRounds: boolean;
  /** Same `seriesId` as `:slug`. The empty state's "Copy from the last event in
   *  this series" picks the first item with this flag and `startAt` before the event. */
  isSameSeries: boolean; // always false for game sources
  rounds: QuizshowImportRoundRef[];
}

/** GET /quizshow/templates/:templateId/preview (item 23). Prompts only: no options, answers or notes. */
export interface QuizshowTemplatePreview {
  templateId: string;
  title: QuizshowText;
  description: QuizshowText;
  languages: QuizshowLanguageMode;
  rounds: Array<
    QuizshowImportRoundRef & {
      prompts: QuizshowText[];
    }
  >;
}

/** Host-facing card. Never carries questions or answers. */
export interface QuizshowTemplateCard {
  id: string; // uuid of the template
  title: QuizshowText;
  description: QuizshowText;
  languages: QuizshowLanguageMode;
  roundCount: number;
  questionCount: number;
  hasAdultsRounds: boolean;
  lastPublishedAt: string;
}

/** Staff list row. */
export interface QuizshowTemplateRow {
  id: string;
  title: QuizshowText; // card title
  status: QuizshowTemplateStatus;
  roundCount: number;
  questionCount: number;
  hasAdultsRounds: boolean;
  updatedAt: string; // the quiz's updatedAt
  updatedByName: string | null; // display name of updated_by_user_id; null when that account is gone
  publishedAt: string | null;
}

export interface QuizshowTemplateCardText {
  title: QuizshowText;
  description: QuizshowText;
}

/** Staff detail: what GET, PUT, create, duplicate, publish and unpublish return. */
export interface QuizshowTemplateDetail {
  id: string;
  card: QuizshowTemplateCardText;
  staffNotes: string; // '' when empty
  status: QuizshowTemplateStatus;
  publishedAt: string | null;
  publishedByName: string | null;
  quiz: QuizshowQuiz; // same shape the builder reads today
  changeNote: QuizshowText;
  lastPublishedAt: string | null;
}

/** Staff PUT body. `quiz.expectedUpdatedAt` is the concurrency token. */
export interface QuizshowTemplateInput {
  card: QuizshowTemplateCardText;
  staffNotes: string;
  quiz: QuizshowQuizInput;
  changeNote: QuizshowText; // 0..300 each, staff only
}

export interface QuizshowOpenSessionInput {
  playMode: QuizshowPlayMode;
  maxTeamSize: number | null; // teams only, 2..20; null = no cap. Must be null in solo.
  isReviewOn: boolean; // default true in the UI
  notifyGuests: boolean; // the dialog's switch now defaults to false (item 16)
  /** true after the host confirmed that opening deletes the event's kept results. Ignored when isPractice. */
  shouldReplaceResults: boolean;
  isPractice: boolean; // item 17
  /** item 38: the finished session this one replays; null otherwise. */
  rematchOfSessionId: string | null;
}

export interface QuizshowJoinHost {
  name: string; // the owner's member display name
  avatarUrl: string | null;
  memberSlug: string; // the frontend links /members/:slug
}
export interface QuizshowJoinResponse {
  sessionId: string;
  kind: QuizshowScopeKind;
  eventSlug: string | null; // event games
  eventTitle: string | null;
  quizTitle: string;
  isAdultsOnly: boolean; // event: formatDetails.isAdultsOnly; game: is_adults_only
  host: QuizshowJoinHost | null; // game only; null for event games
  status: 'lobby' | 'running' | 'paused';
  /** The caller already has a player row in this session (reconnect, second device). */
  isRejoin: boolean;
}

/** GET /quizshow/join-preview/:code, signed out (item 29). Nothing else is safe to show. */
export interface QuizshowJoinPreview {
  quizTitle: string;
  status: 'lobby' | 'running' | 'paused';
}

/** REST details of `quizshow_quiz_changed` (item 54). */
export interface QuizshowQuizChangedDetails {
  updatedAt: string | null;
  updatedByName: string | null; // display name; null when the account is gone
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
  /** Win badges of this game: its winners and the viewer's own; null when the game gave none. */
  winBadges: QuizshowResultsWinBadges | null;
}

export interface QuizshowRecapStanding {
  rank: number;
  kind: 'player' | 'team';
  name: string;
  colorKey: QuizshowTeamColorKey | null;
  score: number;
}
export interface QuizshowRecap {
  questionsPlayed: number;
  answersGiven: number;
  questions: QuizshowRecapQuestion[];
  /** Every entrant of the night, rank ASC then name. Organisers only, like the rest of the recap (item 59). */
  standings: QuizshowRecapStanding[];
}
export interface QuizshowRecapQuestion {
  roundIndex: number;
  questionIndex: number;
  roundKind: QuizshowRoundKind;
  type: QuizshowQuestionType;
  prompt: QuizshowText;
  answerCount: number;
  /** 0..100 integer: share of eligible players who scored the full base. null on party, poll and warm-up questions. */
  percentCorrect: number | null;
  /** Mean `receivedAt - phaseStartedAt` of `open`; null on party questions. */
  averageAnswerMs: number | null;
  wasSkipped: boolean;
  isWarmUp: boolean;
  wasCorrected: boolean;
}

/** The quiz without the concurrency token: what an import copies and a write stores. */
export type QuizshowQuizShape = Omit<QuizshowQuizInput, 'expectedUpdatedAt'>;

/** The `quizshow` field of `EventDetail`; null while the feature is hidden from this viewer (unlaunched, and no early-access grant). */
export interface QuizshowEventDetail {
  hasQuiz: boolean;
  /** The open session's code while its status is lobby/running/paused (an abandoned
   *  check runs while building the DTO). null for viewers barred from the event. */
  liveSessionCode: string | null;
  /** Kept results exist AND this viewer may open them (organiser, going RSVP, or played). */
  hasResults: boolean;
  /** "Win to earn": the badges the next game of this event gives; null when it gives none or the event has no quiz. */
  winBadges: QuizshowWinBadgesPreview | null;
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
  /** On `quizshow_stale_phase` and every phase or status refusal of contract 3.2: the current cursor. */
  cursor?: QuizshowCursor;
  /** Only on quizshow_screen_name_taken: the first free "<name> 2".."<name> 99". */
  suggestedScreenName?: string;
}

export interface QuizshowCursor {
  /** Opaque. Decimal string of a per-session counter that increases on every
   *  phase transition and on a restart replay; checkpointed in `cursor` jsonb.
   *  Compare by equality only. Pause, resume and addTime keep it. */
  phaseId: string;
  status: QuizshowSessionStatus;
  phase: QuizshowPhase;
  /** 0-based row index; null in lobby, podium, ended. In `wheel`: the wheel step's row,
   *  or null for an unplanned spin. In `leaderboard` after a pick-a-question wheel: the wheel step's row. */
  roundIndex: number | null;
  questionIndex: number | null; // 0-based within the round; null outside question phases
  /** M of "Round N of M". Was `snapshot.rounds.length`. */
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
  /** N of "Round N of M": rounds started so far, the current one included; 0 before the first. */
  roundNumber: number;
  /** Set in `lobby` and `leaderboard`; null in every other phase. */
  upNext: QuizshowUpNext | null;
  /** True only in `leaderboard` when the remote may offer "Spin for the next round". */
  canSpinForNextRound: boolean;
  /** read in teams play with talkSeconds > 0: when the talk beat starts (server ms); null otherwise. */
  talkStartsAt: number | null;
  /** When the server moves on by itself (auto-advance); null when it will not. Cleared by pause. */
  autoAdvanceAt: number | null;
  /** podium only: places revealed so far, 0..3, counted from 3rd; null in every other phase. */
  podiumRevealedCount: number | null;
}

export type QuizshowAnswerPayload =
  | { type: 'multiple_choice'; optionIndex: number }
  | { type: 'true_false'; isTrue: boolean }
  | { type: 'type_answer'; text: string } // 1..80 after trim
  | { type: 'order'; orderedIds: string[] } // a permutation of the shown option ids
  | { type: 'closest_number'; value: number }
  | { type: 'prompt'; text: string } // party: 1..80 after trim
  | { type: 'poll'; optionIndex: number };

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
  isWarmUp: boolean;
  talkSeconds: QuizshowTalkSeconds; // 0 in solo play whatever the setting
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
  mediaAlt: QuizshowText;
  mediaReveal: QuizshowMediaReveal;
  numberUnit: QuizshowText;
  /** The `read` length this question got, ms (item 30). */
  readMs: number;
  /** MC and poll: authored order (index = `optionIndex`). Order: shuffled at lobby open
   *  into an order that differs from the correct one. Others: null. Sent from `read` on. */
  options: QuizshowOption[] | null;
}

export type QuizshowAnswerKeyView =
  | { type: 'multiple_choice'; correctIndexes: number[] }
  | { type: 'true_false'; isTrue: boolean }
  | { type: 'type_answer'; text: QuizshowText; acceptedAnswers: string[] }
  | { type: 'order'; orderedIds: string[] }
  | {
      type: 'closest_number';
      value: number;
      tolerance: QuizshowClosestTolerance;
    }
  | { type: 'lie_detector'; truth: QuizshowText };
// poll has no key: toAnswerKeyView returns null for it, as for Caption This.

/** Hosts only: the answer from the question's first phase. null on Caption This, Drag Name and poll. */
export interface QuizshowHostQuestionView extends QuizshowQuestionView {
  answerKey: QuizshowAnswerKeyView | null;
  revealNote: QuizshowText; // hosts see it from read on
}

export interface QuizshowPhaseChangeFrame {
  cursor: QuizshowCursor;
  round: QuizshowRoundCard | null;
  question: QuizshowQuestionView | QuizshowHostQuestionView | null; // null outside question phases
  wheel: QuizshowWheelView | null;
  wheelBonus: QuizshowWheelBonusView | null;
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
  isHostMade: boolean; // item 26: created by a host
}
export interface QuizshowLobby {
  players: QuizshowLobbyPlayer[]; // joined order, removed players left out
  teams: QuizshowLobbyTeam[]; // [] in solo
  playerCount: number;
}
/** lobby:update and session:state for the players room (W2). No roster. */
export interface QuizshowPlayerLobby {
  teams: QuizshowLobbyTeam[]; // [] in solo
  playerCount: number;
}
export interface QuizshowHostPlayer extends QuizshowLobbyPlayer {
  isCohostPlayer: boolean; // the remote's "co-host" tag
  hasExtraTime: boolean;
  hasUsedJoker: boolean;
  score: number;
  streak: number;
  isConnected: boolean;
  /** Server ms when the last socket left; null while connected. The remote tags "Away" at awayAfterMs (item 3). */
  disconnectedAt: number | null;
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

export interface QuizshowPairedDevice {
  pairingId: string;
  kind: QuizshowPairedDeviceKind;
  /** helper: the member's display name; screen: null. */
  helperName: string | null;
  pairedAt: number;
  isConnected: boolean;
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
  /** null on Caption This, Drag Name and poll. */
  correct: QuizshowAnswerKeyView | null;
  answeredCount: number;
  eligibleCount: number;
  distribution: QuizshowDistribution; // poll uses { kind: 'options', counts }
  /** The question's revealNote; null when both languages are ''. */
  note: QuizshowText | null;
  /** The host changed the key or accepted an answer on this question (item 5). */
  wasCorrected: boolean;
}

/** type_answer reveal, hosts only (item 5): distinct wrong answers, most written first. */
export interface QuizshowTypedAnswerGroup {
  normalisedText: string; // the accept key the server compares
  sampleText: string; // the first stored spelling, as written
  count: number;
}
export interface QuizshowHostTypedAnswers {
  phaseId: string;
  questionId: string;
  groups: QuizshowTypedAnswerGroup[]; // max 30 groups
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
  /** Solo: the player's streak. Teams: the highest streak among active members (item 45). */
  streak: number;
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

export interface QuizshowAnswerCountFrame {
  phaseId: string;
  count: number;
  total: number;
}

export interface QuizshowPodiumFrame {
  phaseId: string;
  /** Screen and players: places already revealed. Hosts: every podium entry. */
  entries: QuizshowPodiumEntry[];
  revealedCount: number; // 0..3, equals cursor.podiumRevealedCount
}

export interface QuizshowReactionsFrame {
  /** Reactions received in the window, by id; ids with 0 left out. Anonymous: no player ids. */
  counts: Partial<Record<QuizshowReactionId, number>>;
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
  hasResults: boolean; // false for a practice session
  isPractice: boolean;
  giving: QuizshowGivingLink | null;
}

export interface QuizshowGivingLink {
  communitySlug: string;
  communityName: string;
}

export interface QuizshowRematch {
  fromSessionId: string;
  sessionId: string;
  joinCode: string;
  playMode: QuizshowPlayMode;
}

export interface QuizshowStateBase {
  sessionId: string;
  eventSlug: string | null;
  eventTitle: string | null;
  kind: QuizshowScopeKind;
  gameId: string | null;
  isAdultsOnly: boolean;
  joinCode: string;
  quizTitle: string;
  languages: QuizshowLanguageMode;
  screenLanguage: QuizshowScreenLanguage; // widened
  playMode: QuizshowPlayMode;
  maxTeamSize: number | null;
  isReviewOn: boolean;
  isPractice: boolean;
  isJoinLocked: boolean;
  isAutoAdvanceOn: boolean;
  /** Set in `ended` of a finished event session (item 66); null otherwise. */
  giving: QuizshowGivingLink | null;
  /** Screen sound muted by a host; in-memory, starts false, kept across reconnects for the session (coordinator addition 2026-10-19). Screen and host states carry it; players ignore it. */
  isScreenMuted: boolean;
  cursor: QuizshowCursor;
  rounds: QuizshowRoundCard[]; // the lobby's round list with content labels
  round: QuizshowRoundCard | null;
  reveal: QuizshowReveal | null; // during reveal, scores
  scores: QuizshowScores | null; // during scores, leaderboard, podium
  podium: QuizshowPodiumEntry[] | null;
  nextEvent: QuizshowNextEvent | null; // set in `ended`
  wheel: QuizshowWheelView | null;
  wheelBonus: QuizshowWheelBonusView | null;
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
  lobby: QuizshowPlayerLobby; // was QuizshowLobby (W2)
  answerCount: { count: number; total: number } | null; // item 48
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
  pairedDevices: QuizshowPairedDevice[]; // item 9
  typedAnswers: QuizshowHostTypedAnswers | null; // item 5, reveal and scores of type_answer
  guestPushSentAt: number | null; // item 16
}

export type QuizshowSessionState =
  QuizshowScreenState | QuizshowPlayerState | QuizshowHostState;

/** TV pairing and helper remote (item 9). */
export interface QuizshowPairingStart {
  pairingId: string; // uuid
  pairingCode: string; // 6 digits from '23456789'
  pollToken: string; // 32 bytes base64url; sent in the claim body only
  expiresAt: number; // server ms
}
export type QuizshowPairingClaim =
  | { status: 'waiting'; expiresAt: number }
  | {
      status: 'paired';
      deviceTicket: string; // JWT, section 6.5
      sessionId: string;
      kind: QuizshowScopeKind;
      eventSlug: string | null;
      gameId: string | null;
    };

export const QUIZSHOW_ANSWER_SNAPSHOT_TYPE = 'quizshow-answer-snapshot';
export interface QuizshowAnswerSnapshotEvidence {
  type: typeof QUIZSHOW_ANSWER_SNAPSHOT_TYPE;
  answerId: string;
  sessionId: string;
  eventId: string | null;
  eventSlug: string | null;
  gameId: string | null;
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

export const QUIZSHOW_GAME_SNAPSHOT_TYPE = 'quizshow-game-snapshot';
export interface QuizshowGameSnapshotEvidence {
  type: typeof QUIZSHOW_GAME_SNAPSHOT_TYPE;
  sessionId: string;
  gameId: string;
  quizTitle: string;
  /** Server side only, for staff tooling. */
  ownerUserId: string;
  /** Every question the session had shown when the report was filed, in play order; never an unshown one. */
  shownQuestions: {
    roundKind: QuizshowRoundKind;
    prompt: QuizshowText;
    options: QuizshowText[];
  }[];
  capturedAt: string;
}
