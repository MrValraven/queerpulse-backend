/**
 * Pulse Live (`quizshow`) engine vocabulary: the in-memory state of one live
 * session, the persistence operations the engine asks for, the effects it
 * hands the runtime and the outcome of every command. Types only.
 */
import type { QuizshowStoredPodiumEntry } from './entities/quizshow-result.entity';
import type {
  QuizshowAckFailure,
  QuizshowAnswerPayload,
  QuizshowCursor,
  QuizshowNextEvent,
  QuizshowPlayMode,
  QuizshowPodiumEntry,
  QuizshowQuestionType,
  QuizshowRoundKind,
  QuizshowScopeKind,
  QuizshowScoresScope,
  QuizshowSessionStatus,
  QuizshowTeamColorKey,
} from './quizshow.contract';
import type { QuizshowSessionSnapshot } from './quizshow-snapshot';

export interface QuizshowLivePlayer {
  playerId: string;
  userId: string;
  screenName: string;
  teamId: string | null;
  isCohostPlayer: boolean;
  isAvatarShown: boolean;
  /** Resolved at join, served while `isAvatarShown`. */
  avatarUrl: string | null;
  hasExtraTime: boolean;
  score: number;
  streak: number;
  hasUsedJoker: boolean;
  jokerRoundIndex: number | null;
  joinedAt: number;
  removedAt: number | null;
  connectedSocketCount: number;
}

export interface QuizshowLiveTeam {
  teamId: string;
  name: string;
  colorKey: QuizshowTeamColorKey;
  score: number;
  hasUsedJoker: boolean;
  jokerRoundIndex: number | null;
  createdAt: number;
}

export interface QuizshowLiveAnswer {
  answerId: string;
  playerId: string;
  questionId: string;
  phaseId: string;
  payload: QuizshowAnswerPayload;
  receivedAt: number;
  elapsedMs: number | null;
  isCorrect: boolean | null;
  correctPositions: number | null;
  pointsAwarded: number;
  streakBonus: number;
  voteOptionId: string | null;
  hiddenAt: number | null;
}

export interface QuizshowLiveVoteOption {
  optionId: string;
  answerId: string | null;
  authorPlayerId: string | null;
  text: string;
  isTruth: boolean;
}

export interface QuizshowLiveVote {
  voterPlayerId: string;
  questionId: string;
  optionId: string;
  answerId: string | null;
  createdAt: number;
}

export interface QuizshowLiveQuestionPlay {
  questionId: string;
  roundIndex: number;
  questionIndex: number;
  /** First phase start: the eligibility cut. */
  openedAt: number;
  eligiblePlayerIds: Set<string>;
  extraTimePlayerIds: Set<string>;
  /** By playerId. */
  answers: Map<string, QuizshowLiveAnswer>;
  /** By voterPlayerId. */
  votes: Map<string, QuizshowLiveVote>;
  voteOptions: QuizshowLiveVoteOption[] | null;
  favouriteOptionId: string | null;
  isScored: boolean;
  wasSkipped: boolean;
  /** Everything the question earned each player. */
  pointsByPlayer: Map<string, number>;
  teamPoints: Map<string, number>;
}

export interface QuizshowQuestionLogEntry {
  questionId: string;
  roundIndex: number;
  questionIndex: number;
  roundKind: QuizshowRoundKind;
  type: QuizshowQuestionType;
  openedAt: number;
  revealedAt: number | null;
  eligibleCount: number;
  wasSkipped: boolean;
}

export interface QuizshowLastTransition {
  fromPhaseId: string;
  toPhaseId: string;
}

export interface QuizshowLiveState {
  sessionId: string;
  /** Null for a game session. */
  eventId: string | null;
  /** Null for a game session. */
  eventSlug: string | null;
  /** Null for a game session. */
  eventTitle: string | null;
  /** `'event'` for a quiz on an event, `'game'` for a game a member owns. */
  kind: QuizshowScopeKind;
  /** The game id for a game session; null for an event session. */
  gameId: string | null;
  /** The scope's 18+ flag, or true when the session snapshot holds an adults round. */
  isAdultsOnly: boolean;
  /** The event host, or the game owner. */
  hostUserId: string | null;
  openedByUserId: string | null;
  joinCode: string;
  playMode: QuizshowPlayMode;
  maxTeamSize: number | null;
  isReviewOn: boolean;
  snapshot: QuizshowSessionSnapshot;
  status: QuizshowSessionStatus;
  cursor: QuizshowCursor;
  phaseCounter: number;
  pausedAt: number | null;
  lastHostCommandAt: number;
  lastTransition: QuizshowLastTransition | null;
  players: Map<string, QuizshowLivePlayer>;
  teams: Map<string, QuizshowLiveTeam>;
  current: QuizshowLiveQuestionPlay | null;
  questionLog: QuizshowQuestionLogEntry[];
  /** Entrant id to score, for `previousScore`. */
  scoresAtLastFrame: Map<string, number>;
  lastScoresFrame: {
    phaseId: string;
    scope: QuizshowScoresScope;
    previousByEntrant: Map<string, number>;
  } | null;
  podium: QuizshowPodiumEntry[] | null;
  attachedOrganiserUserIds: Set<string>;
  nextEvent: QuizshowNextEvent | null;
  hasScoredQuestion: boolean;
  /** In memory only; false after a restart. */
  isScreenMuted: boolean;
}

/** The scope fields access checks and persistence read off a live session. */
export type QuizshowScopeSource = Pick<
  QuizshowLiveState,
  'kind' | 'eventId' | 'gameId' | 'hostUserId'
>;

export type QuizshowPersistOperation =
  | { type: 'insert_player'; player: QuizshowLivePlayer }
  | {
      type: 'update_player';
      playerId: string;
      fields: Partial<
        Pick<
          QuizshowLivePlayer,
          | 'screenName'
          | 'teamId'
          | 'isAvatarShown'
          | 'hasExtraTime'
          | 'hasUsedJoker'
          | 'jokerRoundIndex'
          | 'removedAt'
        >
      >;
    }
  | { type: 'insert_team'; team: QuizshowLiveTeam }
  | {
      type: 'update_team';
      teamId: string;
      fields: Partial<
        Pick<QuizshowLiveTeam, 'name' | 'hasUsedJoker' | 'jokerRoundIndex'>
      >;
    }
  | { type: 'delete_teams'; teamIds: string[] }
  | { type: 'insert_answer'; answer: QuizshowLiveAnswer }
  | { type: 'insert_vote'; vote: QuizshowLiveVote }
  | {
      type: 'set_answer_vote_options';
      options: Array<{ answerId: string; voteOptionId: string }>;
    }
  | {
      type: 'save_scoring';
      questionId: string;
      answers: Array<
        Pick<QuizshowLiveAnswer, 'answerId' | 'isCorrect' | 'pointsAwarded'>
      >;
      players: Array<Pick<QuizshowLivePlayer, 'playerId' | 'score' | 'streak'>>;
      teams: Array<Pick<QuizshowLiveTeam, 'teamId' | 'score'>>;
    }
  | {
      type: 'set_answer_hidden';
      answerId: string;
      hiddenAt: number | null;
      hiddenByUserId: string | null;
    }
  | { type: 'delete_question_plays'; questionId: string }
  | {
      type: 'hide_player_answers';
      playerId: string;
      hiddenAt: number;
      hiddenByUserId: string;
    }
  /** Status, cursor, question_log, paused_at, last_host_command_at. */
  | { type: 'checkpoint' }
  | { type: 'add_attached_organiser'; userId: string }
  | {
      type: 'finish';
      podium: QuizshowStoredPodiumEntry[];
      placings: Record<string, number>;
    }
  | { type: 'abandon' };

export type QuizshowEngineEffect =
  | { kind: 'phase_changed' }
  | { kind: 'lobby_changed' }
  | { kind: 'me_changed'; playerIds: string[] }
  | { kind: 'answer_accepted'; playerId: string; questionId: string }
  | { kind: 'answer_count_changed' }
  | { kind: 'review_list_changed' }
  | { kind: 'vote_options_shown' }
  | { kind: 'revealed' }
  | { kind: 'reveal_updated'; favouriteAuthorPlayerId: string | null }
  | {
      kind: 'answer_hidden';
      questionId: string;
      answerId: string;
      optionId: string | null;
    }
  | { kind: 'scores_shown'; scope: QuizshowScoresScope }
  | { kind: 'podium_shown' }
  | { kind: 'player_removed'; playerId: string }
  | { kind: 'session_ended'; status: 'finished' | 'abandoned' }
  | { kind: 'timer'; phaseId: string; fireAt: number }
  | { kind: 'timer_cleared' }
  | { kind: 'persist'; operation: QuizshowPersistOperation };

export type QuizshowCommandOutcome<
  Success extends object = Record<string, never>,
> =
  | { ok: true; success: Success; effects: QuizshowEngineEffect[] }
  | { ok: false; failure: QuizshowAckFailure; effects: [] };
