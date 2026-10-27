import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
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
}
