/**
 * Pulse Live (`quizshow`) engine vocabulary: the in-memory state of one live
 * session, the persistence operations the engine asks for, the effects it
 * hands the runtime and the outcome of every command. Types only.
 */
import type { QuizshowStoredPodiumEntry } from './entities/quizshow-result.entity';
import type {
  QuizshowAckFailure,
  QuizshowAnswerKeyView,
  QuizshowAnswerPayload,
  QuizshowCursor,
  QuizshowGivingLink,
  QuizshowNextEvent,
  QuizshowPairedDeviceKind,
  QuizshowPlayMode,
  QuizshowPodiumEntry,
  QuizshowQuestionType,
  QuizshowReactionId,
  QuizshowRoundKind,
  QuizshowScopeKind,
  QuizshowScoresScope,
  QuizshowSessionStatus,
  QuizshowTeamColorKey,
} from './quizshow.contract';
import type { QuizshowSessionSnapshot } from './quizshow-snapshot';
import type { QuizshowWheelProgress } from './quizshow-wheel';

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
  /**
   * Server ms when the last socket left; null while one is connected
   * (contract 6.2). Memory only: a state loaded from the database sets it to
   * the load time for every player.
   */
  disconnectedAt: number | null;
  /** When the player left with `lobby:leave` or a host removal that allows a rejoin; column `left_at` (contract 6.14). */
  leftAt: number | null;
}

export interface QuizshowLiveTeam {
  teamId: string;
  name: string;
  colorKey: QuizshowTeamColorKey;
  score: number;
  hasUsedJoker: boolean;
  jokerRoundIndex: number | null;
  createdAt: number;
  /** Created by a host, so it stays when its last member leaves the lobby (contract 6.11). */
  isHostMade: boolean;
}

/** A screen or helper remote paired to the session (contract 6.5). */
export interface QuizshowLivePairedDevice {
  pairingId: string;
  kind: QuizshowPairedDeviceKind;
  /** The helper's account; null for a screen. */
  helperUserId: string | null;
  /** Resolved on pair and on load; null for a screen or when the account is gone. Memory only. */
  helperName: string | null;
  pairedAt: number;
  revokedAt: number | null;
  /** Sockets attached with this pairing's ticket. Memory only. */
  connectedSocketCount: number;
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
  /** By answerId; kept in step with `answers` so lookups by answer id cost one read (contract 7.1, W1). */
  answersById: Map<string, QuizshowLiveAnswer>;
  /** Active players left out at open because they were away (contract 6.2). */
  awayPlayerIds: Set<string>;
  /** Streak each eligible player had before this question was first scored (contract 6.4). */
  streakBeforeByPlayer: Map<string, number>;
  /** host:changeCorrectAnswer: the key that replaces the snapshot's (contract 6.4). */
  keyOverride: QuizshowAnswerKeyView | null;
  /** host:acceptAnswer: extra normalised texts judged correct (contract 6.4). */
  acceptedTexts: Set<string>;
  /** A host corrected this question after its reveal (contract 6.4). */
  wasCorrected: boolean;
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
  /** Which rounds and wheels have run, and the open wheel; plain JSON, stored in the cursor. */
  wheelProgress: QuizshowWheelProgress;
  /** In memory only; false after a restart. */
  isScreenMuted: boolean;
  /** Opened as a practice lobby: guests get no push and the session keeps no results (contract 6.9). */
  isPractice: boolean;
  /** New players cannot join while on; a rejoin still can (contract 6.15). */
  isJoinLocked: boolean;
  /** The engine moves on by itself after leaderboards and scores (contract 6.16). */
  isAutoAdvanceOn: boolean;
  /** Every pairing of the session, revoked ones included (contract 6.5). */
  pairedDevices: QuizshowLivePairedDevice[];
  /** When the remote last pushed the guests; null before the first push (contract 6.8). */
  guestPushSentAt: number | null;
  /** The community support link shown at the end; resolved on load (contract 6.27). */
  giving: QuizshowGivingLink | null;
  /** host:adjustPoints request ids, newest last, at most 50. Memory only. */
  adjustRequestIds: string[];
  /** Question ids with a host correction: the keys of `answer_key_overrides` (loaded) plus every rescore since. */
  correctedQuestionIds: Set<string>;
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
          | 'leftAt'
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
      type: 'save_wheel_bonus';
      players: Array<Pick<QuizshowLivePlayer, 'playerId' | 'score'>>; // [] in teams
      teams: Array<Pick<QuizshowLiveTeam, 'teamId' | 'score'>>; // [] in solo
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
  /** Jsonb merge into `answer_key_overrides` under the question id (contract 6.4). */
  | {
      type: 'set_answer_key_override';
      questionId: string;
      keyOverride: QuizshowAnswerKeyView | null;
      acceptedTexts: string[];
    }
  /** A host points adjustment: the entrant's new total. */
  | {
      type: 'adjust_score';
      kind: 'player' | 'team';
      entrantId: string;
      score: number;
    }
  /**
   * Appends `device` to `quizshow_sessions.paired_devices` and removes the
   * stored entries whose `pairingId` is in `droppedPairingIds` (the revoked
   * ones the prune dropped from memory). Every other stored entry is kept as
   * it is stored, so a helper id that erasure scrubbed stays scrubbed.
   */
  | {
      type: 'add_paired_device';
      device: QuizshowLivePairedDevice;
      droppedPairingIds: string[];
    }
  | { type: 'revoke_paired_device'; pairingId: string; revokedAt: number }
  /** Persistence reads `isJoinLocked` and `isAutoAdvanceOn` from the state. */
  | { type: 'set_session_flags' }
  /** Persistence reads `state.snapshot` (contract 6.10). */
  | { type: 'replace_snapshot' }
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
  /** A rescore changed the reveal for every player (contract 6.4). */
  | { kind: 'reveal_updated'; scope: 'everyone' }
  /** The favourite path (contract 6.4 rule 6): `playerId` is the favourite's author, null when the favourite has none. */
  | { kind: 'reveal_updated'; scope: 'favourite'; playerId: string | null }
  | { kind: 'typed_answers_changed' }
  /** A fresh `session:state` to every socket, or to the hosts room only. */
  | { kind: 'state_reset'; scope: 'everyone' | 'hosts' }
  | { kind: 'flags_changed' }
  | { kind: 'reaction'; reactionId: QuizshowReactionId }
  | { kind: 'player_left'; playerId: string }
  | {
      kind: 'answer_hidden';
      questionId: string;
      answerId: string;
      optionId: string | null;
    }
  | { kind: 'scores_shown'; scope: QuizshowScoresScope }
  | { kind: 'podium_shown' }
  | { kind: 'player_removed'; playerId: string; canRejoin: boolean }
  | { kind: 'devices_changed' }
  | { kind: 'session_ended'; status: 'finished' | 'abandoned' }
  | { kind: 'timer'; phaseId: string; fireAt: number }
  | { kind: 'timer_cleared' }
  | { kind: 'persist'; operation: QuizshowPersistOperation };

export type QuizshowCommandOutcome<
  Success extends object = Record<string, never>,
> =
  | { ok: true; success: Success; effects: QuizshowEngineEffect[] }
  | { ok: false; failure: QuizshowAckFailure; effects: [] };
