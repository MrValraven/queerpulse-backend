import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsObject,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  QUIZSHOW_ATTACH_ROLES,
  QUIZSHOW_LIMITS,
  QUIZSHOW_PAIRING_CODE_PATTERN,
  QUIZSHOW_QUESTION_TYPES,
  QUIZSHOW_REACTION_IDS,
  QUIZSHOW_TEAM_COLOR_KEYS,
  QuizshowAttachRole,
  QuizshowQuestionType,
  QuizshowReactionId,
  QuizshowTeamColorKey,
} from '../quizshow.contract';
import { IsQuizshowClassValid } from './quizshow-quiz-input.dto';

const PHASE_ID_PATTERN = /^\d{1,12}$/;

/** A device ticket is a short JWT; the ceiling only stops an oversized string. */
const DEVICE_TICKET_MAX = 2048;

export function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Class decorator for a frame that takes no fields. class-validator refuses an
 * instance of a class with no validation metadata at all, so this registers
 * one check that always passes; `forbidNonWhitelisted` then refuses any key.
 */
function IsQuizshowEmptyPayload() {
  return IsQuizshowClassValid<object>(() => true, 'this frame takes no fields');
}

export class QuizshowAttachPayload {
  @IsUUID()
  sessionId!: string;

  @IsIn(QUIZSHOW_ATTACH_ROLES)
  as!: QuizshowAttachRole;

  /** A helper's ticket on `as: 'host'`, or a paired screen's own ticket. */
  @IsOptional()
  @IsString()
  @MaxLength(DEVICE_TICKET_MAX)
  deviceTicket?: string;
}

export class QuizshowReauthPayload {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  ticket!: string;
}

export class QuizshowTimePingPayload {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  clientSentAt!: number;
}

export class QuizshowLobbyNewTeamDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.teamNameMax)
  name!: string;

  @IsIn(QUIZSHOW_TEAM_COLOR_KEYS)
  colorKey!: QuizshowTeamColorKey;
}

/** Exactly one of `teamId` (join a team) or `newTeam` (found one). */
@IsQuizshowClassValid<QuizshowLobbyTeamChoiceDto>(
  (choice) => (choice.teamId === undefined) !== (choice.newTeam === undefined),
  'exactly one of teamId or newTeam is required',
)
export class QuizshowLobbyTeamChoiceDto {
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuizshowLobbyNewTeamDto)
  newTeam?: QuizshowLobbyNewTeamDto;
}

export class QuizshowLobbyJoinPayload {
  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.screenNameMax)
  screenName!: string;

  @IsBoolean()
  isAvatarShown!: boolean;

  @IsBoolean()
  hasExtraTime!: boolean;

  @IsOptional()
  @IsBoolean()
  hasAcceptedAdultContent?: boolean;

  @IsDefined()
  @ValidateIf((_payload, value: unknown) => value !== null)
  @ValidateNested()
  @Type(() => QuizshowLobbyTeamChoiceDto)
  team!: QuizshowLobbyTeamChoiceDto | null;
}

export class QuizshowSetNamePayload {
  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.screenNameMax)
  screenName!: string;
}

export class QuizshowPickTeamPayload {
  @IsUUID()
  teamId!: string;
}

export class QuizshowCreateTeamPayload {
  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.teamNameMax)
  name!: string;

  @IsIn(QUIZSHOW_TEAM_COLOR_KEYS)
  colorKey!: QuizshowTeamColorKey;
}

export class QuizshowExtraTimePayload {
  @IsBoolean()
  hasExtraTime!: boolean;
}

export class QuizshowAvatarPayload {
  @IsBoolean()
  isAvatarShown!: boolean;
}

export class QuizshowAnswerPayloadDto {
  @IsIn(QUIZSHOW_QUESTION_TYPES)
  type!: QuizshowQuestionType;

  @IsOptional()
  @IsInt()
  optionIndex?: number;

  @IsOptional()
  @IsBoolean()
  isTrue?: boolean;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.typedAnswerMax)
  text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QUIZSHOW_LIMITS.orderItemsMax)
  @IsString({ each: true })
  @MaxLength(12, { each: true })
  orderedIds?: string[];

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  value?: number;
}

export class QuizshowAnswerSubmitPayload {
  @Matches(PHASE_ID_PATTERN)
  phaseId!: string;

  @IsUUID()
  questionId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowAnswerPayloadDto)
  payload!: QuizshowAnswerPayloadDto;
}

export class QuizshowVoteSubmitPayload {
  @Matches(PHASE_ID_PATTERN)
  phaseId!: string;

  @IsUUID()
  questionId!: string;

  @IsUUID()
  optionId!: string;
}

export class QuizshowJokerPayload {
  @IsInt()
  @Min(0)
  @Max(QUIZSHOW_LIMITS.roundRowsMax - 1)
  roundIndex!: number;
}

export class QuizshowPhaseCommandPayload {
  @Matches(PHASE_ID_PATTERN)
  phaseId!: string;
}

export class QuizshowAddTimePayload {
  @Matches(PHASE_ID_PATTERN)
  phaseId!: string;

  @IsInt()
  @Min(QUIZSHOW_LIMITS.addTimeSecondsMin)
  @Max(QUIZSHOW_LIMITS.addTimeSecondsMax)
  seconds!: number;

  @IsInt()
  expectedDeadline!: number;
}

export class QuizshowHideAnswerPayload {
  @IsUUID()
  answerId!: string;

  @IsBoolean()
  isHidden!: boolean;
}

export class QuizshowPickFavouritePayload {
  @Matches(PHASE_ID_PATTERN)
  phaseId!: string;

  @IsUUID()
  questionId!: string;

  @IsUUID()
  optionId!: string;
}

export class QuizshowRemovePlayerPayload {
  @IsUUID()
  playerId!: string;

  /** Missing means false: the player stays out of this session. */
  @IsOptional()
  @IsBoolean()
  canRejoin?: boolean;
}

export class QuizshowRenameTeamPayload {
  @IsUUID()
  teamId!: string;

  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.teamNameMax)
  name!: string;
}

export class QuizshowSetScreenMutedPayload {
  @IsBoolean()
  isMuted!: boolean;
}

/** `lobby:leave`: a player leaves the lobby for good. */
@IsQuizshowEmptyPayload()
export class QuizshowLeavePayload {}

/** `reaction:send`: one of the fixed reaction ids. */
export class QuizshowReactionPayload {
  @IsIn(QUIZSHOW_REACTION_IDS)
  reactionId!: QuizshowReactionId;
}

/** `session:ping`: any socket checks that the server still knows it. */
@IsQuizshowEmptyPayload()
export class QuizshowSessionPingPayload {}

/** `host:acceptAnswer`: one normalised typed answer the host counts as correct. */
export class QuizshowAcceptAnswerPayload {
  @Matches(PHASE_ID_PATTERN)
  phaseId!: string;

  @IsUUID()
  questionId!: string;

  @IsString()
  @Length(1, QUIZSHOW_LIMITS.typedAnswerMax)
  normalisedText!: string;
}

const CORRECT_ANSWER_TYPES = ['multiple_choice', 'true_false'] as const;

/** The new key of a choice question: each type carries its own field alone. */
@IsQuizshowClassValid<QuizshowCorrectAnswerChangeDto>(
  (answer) =>
    (answer.type === 'multiple_choice' && answer.isTrue === undefined) ||
    (answer.type === 'true_false' && answer.correctIndexes === undefined),
  'each answer type takes its own field alone',
)
export class QuizshowCorrectAnswerChangeDto {
  @IsIn(CORRECT_ANSWER_TYPES)
  type!: (typeof CORRECT_ANSWER_TYPES)[number];

  /** Range, duplicates and "every option" are engine refusals with their own codes. */
  @ValidateIf(
    (answer: QuizshowCorrectAnswerChangeDto) =>
      answer.type === 'multiple_choice',
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(QUIZSHOW_LIMITS.multipleChoiceOptionsMax)
  @IsInt({ each: true })
  @Min(0, { each: true })
  correctIndexes?: number[];

  @ValidateIf(
    (answer: QuizshowCorrectAnswerChangeDto) => answer.type === 'true_false',
  )
  @IsBoolean()
  isTrue?: boolean;
}

/** `host:changeCorrectAnswer`: a new key for a multiple choice or true or false question. */
export class QuizshowChangeCorrectAnswerPayload {
  @Matches(PHASE_ID_PATTERN)
  phaseId!: string;

  @IsUUID()
  questionId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowCorrectAnswerChangeDto)
  answer!: QuizshowCorrectAnswerChangeDto;
}

/** `host:adjustPoints`: a non-zero whole delta; a repeated requestId is a no-op. */
export class QuizshowAdjustPointsPayload {
  @IsUUID()
  entrantId!: string;

  @IsInt()
  @Min(-QUIZSHOW_LIMITS.adjustPointsMax)
  @Max(QUIZSHOW_LIMITS.adjustPointsMax)
  @NotEquals(0)
  delta!: number;

  @IsUUID()
  requestId!: string;
}

/** `host:pairDevice`: the six-digit code a TV or a helper phone shows. */
export class QuizshowPairDevicePayload {
  @IsString()
  @Matches(QUIZSHOW_PAIRING_CODE_PATTERN)
  pairingCode!: string;
}

/** `host:unpairDevice`. */
export class QuizshowUnpairDevicePayload {
  @IsUUID()
  pairingId!: string;
}

/** `host:notifyGuests`: push the join code to the event's guests once. */
@IsQuizshowEmptyPayload()
export class QuizshowNotifyGuestsPayload {}

/**
 * `host:createTeams`: every name or none. Names arrive untrimmed so a blank
 * one reaches the engine and answers `quizshow_text_blank`.
 */
export class QuizshowCreateTeamsPayload {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(QUIZSHOW_LIMITS.hostTeamsPerCommandMax)
  @IsString({ each: true })
  @Length(1, QUIZSHOW_LIMITS.teamNameMax, { each: true })
  names!: string[];
}

/**
 * `host:renamePlayer`. The name arrives untrimmed so a blank one reaches the
 * engine and answers `quizshow_text_blank`.
 */
export class QuizshowRenamePlayerPayload {
  @IsUUID()
  playerId!: string;

  @IsString()
  @Length(1, QUIZSHOW_LIMITS.screenNameMax)
  screenName!: string;
}

/** `host:movePlayer`. */
export class QuizshowMovePlayerPayload {
  @IsUUID()
  playerId!: string;

  @IsUUID()
  teamId!: string;
}

/** `host:setJoinLock`. */
export class QuizshowSetJoinLockPayload {
  @IsBoolean()
  isLocked!: boolean;
}

/** `host:setAutoAdvance`. */
export class QuizshowSetAutoAdvancePayload {
  @IsBoolean()
  isOn!: boolean;
}
