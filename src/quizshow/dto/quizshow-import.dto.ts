import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  QUIZSHOW_IMPORT_MODES,
  QUIZSHOW_LIMITS,
  QuizshowImportMode,
} from '../quizshow.contract';
import { IsQuizshowClassValid } from './quizshow-quiz-input.dto';

const IMPORT_SOURCES = ['template', 'event', 'game'] as const;

/** `POST /events/:slug/quizshow/import` body. */
@IsQuizshowClassValid<QuizshowImportDto>(
  (body) =>
    (body.from === 'template' &&
      body.eventSlug === undefined &&
      body.gameId === undefined) ||
    (body.from === 'event' &&
      body.templateId === undefined &&
      body.gameId === undefined) ||
    (body.from === 'game' &&
      body.templateId === undefined &&
      body.eventSlug === undefined),
  'each source takes its own field alone',
)
export class QuizshowImportDto {
  @IsIn(IMPORT_SOURCES)
  from!: (typeof IMPORT_SOURCES)[number];

  @ValidateIf((body: QuizshowImportDto) => body.from === 'template')
  @IsUUID()
  templateId?: string;

  @ValidateIf((body: QuizshowImportDto) => body.from === 'event')
  @IsString()
  @MaxLength(200)
  eventSlug?: string;

  @ValidateIf((body: QuizshowImportDto) => body.from === 'game')
  @IsUUID()
  gameId?: string;

  /** The three fields below are optional so an older studio page still
   *  imports; a missing mode means 'replace'. Which fields append needs is
   *  the service's check, so the DTO checks shapes only. */
  @IsOptional()
  @IsIn(QUIZSHOW_IMPORT_MODES)
  mode?: QuizshowImportMode;

  /** Source row indexes to copy, in source order; null copies every row. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QUIZSHOW_LIMITS.roundRowsMax)
  @IsInt({ each: true })
  @Min(0, { each: true })
  roundIndexes?: number[] | null;

  /** The target quiz's updatedAt, or null when it has none. */
  @IsOptional()
  @IsISO8601()
  expectedUpdatedAt?: string | null;
}
