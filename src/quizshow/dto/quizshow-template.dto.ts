import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { QUIZSHOW_LIMITS } from '../quizshow.contract';
import { QuizshowQuizInputDto } from './quizshow-quiz-input.dto';
import { trimString } from './quizshow-socket-payloads';

/** A template card title in both languages. */
export class QuizshowTemplateTitleDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.templateCardTitleMax)
  en!: string;

  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.templateCardTitleMax)
  pt!: string;
}

/** A template card description in both languages. */
export class QuizshowTemplateDescriptionDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.templateCardDescriptionMax)
  en!: string;

  @Transform(trimString)
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.templateCardDescriptionMax)
  pt!: string;
}

/** Longest staff change note per language (contract 2.5: 0..300 each). */
const CHANGE_NOTE_MAX = 300;

/** The staff note on a publish, shown to quizzes based on this template. */
export class QuizshowTemplateChangeNoteDto {
  @Transform(trimString)
  @IsString()
  @MaxLength(CHANGE_NOTE_MAX)
  en!: string;

  @Transform(trimString)
  @IsString()
  @MaxLength(CHANGE_NOTE_MAX)
  pt!: string;
}

/** The card text hosts see in the template picker. */
export class QuizshowTemplateCardTextDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => QuizshowTemplateTitleDto)
  title!: QuizshowTemplateTitleDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => QuizshowTemplateDescriptionDto)
  description!: QuizshowTemplateDescriptionDto;
}

/** The quiz inside a template: the quiz input with a required, trimmed title. */
export class QuizshowTemplateQuizInputDto extends QuizshowQuizInputDto {
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(QUIZSHOW_LIMITS.quizTitleMax)
  override title!: string;
}

/**
 * `PUT /admin/quizshow/templates/:templateId` body: the card text, the staff
 * notes and the quiz. `quiz.expectedUpdatedAt` is the concurrency token.
 */
export class QuizshowTemplateInputDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => QuizshowTemplateCardTextDto)
  card!: QuizshowTemplateCardTextDto;

  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.templateStaffNotesMax)
  staffNotes!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => QuizshowTemplateQuizInputDto)
  quiz!: QuizshowTemplateQuizInputDto;

  /** Optional so an older staff page still saves; the service then keeps the
   *  stored note. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowTemplateChangeNoteDto)
  changeNote?: QuizshowTemplateChangeNoteDto;
}
