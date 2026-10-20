import { IsIn, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import {
  QUIZSHOW_STARTER_PACK_KEYS,
  QuizshowStarterPackKey,
} from '../quizshow.contract';
import { IsQuizshowClassValid } from './quizshow-quiz-input.dto';

const IMPORT_SOURCES = ['pack', 'event', 'game'] as const;

/** `POST /events/:slug/quizshow/import` body. */
@IsQuizshowClassValid<QuizshowImportDto>(
  (body) =>
    (body.from === 'pack' &&
      body.eventSlug === undefined &&
      body.gameId === undefined) ||
    (body.from === 'event' &&
      body.packKey === undefined &&
      body.gameId === undefined) ||
    (body.from === 'game' &&
      body.packKey === undefined &&
      body.eventSlug === undefined),
  'each source takes its own field alone',
)
export class QuizshowImportDto {
  @IsIn(IMPORT_SOURCES)
  from!: (typeof IMPORT_SOURCES)[number];

  @ValidateIf((body: QuizshowImportDto) => body.from === 'pack')
  @IsIn(QUIZSHOW_STARTER_PACK_KEYS)
  packKey?: QuizshowStarterPackKey;

  @ValidateIf((body: QuizshowImportDto) => body.from === 'event')
  @IsString()
  @MaxLength(200)
  eventSlug?: string;

  @ValidateIf((body: QuizshowImportDto) => body.from === 'game')
  @IsUUID()
  gameId?: string;
}
