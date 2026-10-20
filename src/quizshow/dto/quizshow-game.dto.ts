import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsDefined,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { QUIZSHOW_LIMITS } from '../quizshow.contract';
import { QuizshowImportDto } from './quizshow-import.dto';
import { QuizshowOpenSessionDto } from './quizshow-open-session.dto';
import { QuizshowQuizInputDto } from './quizshow-quiz-input.dto';
import { trimString } from './quizshow-socket-payloads';

/** `POST /quizshow/games` body: a trimmed title and an optional starting source. */
export class QuizshowCreateGameDto {
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(QUIZSHOW_LIMITS.quizTitleMax)
  title!: string;

  @IsDefined()
  @ValidateIf((_body, value: unknown) => value !== null)
  @ValidateNested()
  @Type(() => QuizshowImportDto)
  source!: QuizshowImportDto | null;
}

/** `PUT /quizshow/games/:gameId` body: the quiz input plus the 18+ switch. */
export class QuizshowGameInputDto extends QuizshowQuizInputDto {
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(QUIZSHOW_LIMITS.quizTitleMax)
  override title!: string;

  @IsBoolean()
  isAdultsOnly!: boolean;
}

/** `POST /quizshow/games/:gameId/sessions` body: a game sends no notification. */
export class QuizshowOpenGameSessionDto extends QuizshowOpenSessionDto {
  @IsBoolean()
  @Equals(false)
  override notifyGuests!: boolean;
}
