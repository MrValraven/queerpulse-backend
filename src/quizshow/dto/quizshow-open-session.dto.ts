import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
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
}
