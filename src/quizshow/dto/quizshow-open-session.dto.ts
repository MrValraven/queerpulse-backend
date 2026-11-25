import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_PLAY_MODES,
  QuizshowPlayMode,
} from '../quizshow.contract';
import { IsQuizshowClassValid } from './quizshow-quiz-input.dto';

/** `POST /events/:slug/quizshow/sessions` body. */
@IsQuizshowClassValid<QuizshowOpenSessionDto>(
  (body) =>
    body.playMode !== 'solo' ||
    body.maxTeamSize === null ||
    body.maxTeamSize === undefined,
  'maxTeamSize must be null in solo play',
)
export class QuizshowOpenSessionDto {
  @IsIn(QUIZSHOW_PLAY_MODES)
  playMode!: QuizshowPlayMode;

  @IsOptional()
  @IsInt()
  @Min(QUIZSHOW_LIMITS.maxTeamSizeMin)
  @Max(QUIZSHOW_LIMITS.maxTeamSizeMax)
  maxTeamSize!: number | null;

  @IsBoolean()
  isReviewOn!: boolean;

  @IsBoolean()
  notifyGuests!: boolean;

  @IsBoolean()
  shouldReplaceResults!: boolean;

  /** A practice lobby keeps no results and sends no guest push; a draft event
   *  may host it. */
  @IsBoolean()
  isPractice!: boolean;

  /** The finished session this lobby replays. Optional and nullable: a body
   *  without it or with null opens a fresh lobby. */
  @IsOptional()
  @IsUUID()
  rematchOfSessionId?: string | null;
}
