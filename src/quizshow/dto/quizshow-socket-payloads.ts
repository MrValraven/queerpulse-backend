import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  QUIZSHOW_ATTACH_ROLES,
  QUIZSHOW_LIMITS,
  QUIZSHOW_QUESTION_TYPES,
  QUIZSHOW_TEAM_COLOR_KEYS,
  QuizshowAttachRole,
  QuizshowQuestionType,
  QuizshowTeamColorKey,
} from '../quizshow.contract';
import { IsQuizshowClassValid } from './quizshow-quiz-input.dto';

const PHASE_ID_PATTERN = /^\d{1,12}$/;
const ROUND_INDEX_MAX = 9;

export function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class QuizshowAttachPayload {
  @IsUUID()
  sessionId!: string;

  @IsIn(QUIZSHOW_ATTACH_ROLES)
  as!: QuizshowAttachRole;
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
  @Max(ROUND_INDEX_MAX)
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
