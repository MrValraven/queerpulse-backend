import { IsIn, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
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
}
