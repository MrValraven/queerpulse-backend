import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import {
  QUIZSHOW_CONTENT_LABELS,
  QUIZSHOW_LANGUAGE_MODES,
  QUIZSHOW_LANGUAGES,
  QUIZSHOW_LIMITS,
  QUIZSHOW_QUESTION_TYPES,
  QUIZSHOW_ROUND_KINDS,
  QuizshowQuestionType,
} from '../quizshow.contract';

/** Array ceilings sit above the structural limits so `too_many_rounds` and its
 *  siblings stay 422 problems from the service; past the ceiling is a 400. */
const ROUNDS_CEILING = 20;
const QUESTIONS_PER_ROUND_CEILING = 40;
const OPTIONS_CEILING = 8;

/**
 * Class-level check: `isValid(instance)` must be true or the request is a 400
 * carrying `message`. Shared by the quizshow request bodies that pair fields.
 */
export function IsQuizshowClassValid<Instance extends object>(
  isValid: (instance: Instance) => boolean,
  message: string,
  validationOptions?: ValidationOptions,
) {
  return function decorateClass(target: object) {
    registerDecorator({
      name: 'isQuizshowClassValid',
      target: target as new (...args: never[]) => unknown,
      propertyName: '',
      options: { message, ...validationOptions },
      validator: {
        validate: (
          _value: unknown,
          validationArguments?: ValidationArguments,
        ) => isValid(validationArguments?.object as Instance),
      },
    });
  };
}

export class QuizshowRoundTitleDto {
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.roundTitleMax)
  en!: string;

  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.roundTitleMax)
  pt!: string;
}

export class QuizshowPromptDto {
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.promptMax)
  en!: string;

  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.promptMax)
  pt!: string;
}

export class QuizshowShortTextDto {
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.optionTextMax)
  en!: string;

  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.optionTextMax)
  pt!: string;
}

export class QuizshowOptionDto {
  @IsString()
  @Matches(QUIZSHOW_LIMITS.optionIdPattern)
  id!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowShortTextDto)
  text!: QuizshowShortTextDto;
}

export class QuizshowRoundSettingsDto {
  @IsInt()
  @Min(QUIZSHOW_LIMITS.timeLimitSecondsMin)
  @Max(QUIZSHOW_LIMITS.timeLimitSecondsMax)
  timeLimitSeconds!: number;

  @IsBoolean()
  isSpeedBonusOn!: boolean;

  @IsBoolean()
  isJokerAllowed!: boolean;

  @IsInt()
  @Min(QUIZSHOW_LIMITS.writeSecondsMin)
  @Max(QUIZSHOW_LIMITS.writeSecondsMax)
  writeSeconds!: number;

  @IsInt()
  @Min(QUIZSHOW_LIMITS.voteSecondsMin)
  @Max(QUIZSHOW_LIMITS.voteSecondsMax)
  voteSeconds!: number;
}

export class QuizshowAnswerInputDto {
  @IsOptional()
  @IsInt()
  correctIndex?: number;

  @IsOptional()
  @IsBoolean()
  isTrue?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuizshowShortTextDto)
  text?: QuizshowShortTextDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QUIZSHOW_LIMITS.orderItemsMax)
  @IsString({ each: true })
  orderedIds?: string[];

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  value?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuizshowShortTextDto)
  truth?: QuizshowShortTextDto;
}

const ANSWER_KEY_BY_TYPE: Record<QuizshowQuestionType, string> = {
  multiple_choice: 'correctIndex',
  true_false: 'isTrue',
  type_answer: 'text',
  order: 'orderedIds',
  closest_number: 'value',
  prompt: 'truth',
};

/**
 * Class decorator for `QuizshowQuestionInputDto`: a non-null `answer` holds
 * exactly the key its question type takes and no other.
 */
export function IsQuizshowAnswerForType(validationOptions?: ValidationOptions) {
  return IsQuizshowClassValid<QuizshowQuestionInputDto>(
    (question) => {
      if (question.answer === null || question.answer === undefined) {
        return true;
      }
      const expectedKey = ANSWER_KEY_BY_TYPE[question.type];
      if (expectedKey === undefined) {
        return false;
      }
      const presentKeys = Object.keys(question.answer).filter(
        (key) =>
          (question.answer as unknown as Record<string, unknown>)[key] !==
          undefined,
      );
      return presentKeys.length === 1 && presentKeys[0] === expectedKey;
    },
    'answer must hold exactly the key its question type takes',
    validationOptions,
  );
}

@IsQuizshowAnswerForType()
export class QuizshowQuestionInputDto {
  @IsIn(QUIZSHOW_QUESTION_TYPES)
  type!: QuizshowQuestionType;

  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowPromptDto)
  prompt!: QuizshowPromptDto;

  @IsOptional()
  @IsImageReference()
  mediaRef!: string | null;

  @IsOptional()
  @IsInt()
  @Min(QUIZSHOW_LIMITS.timeLimitSecondsMin)
  @Max(QUIZSHOW_LIMITS.timeLimitSecondsMax)
  timeLimitSeconds!: number | null;

  @IsIn(QUIZSHOW_LIMITS.pointsValues)
  points!: number;

  @IsArray()
  @ArrayMaxSize(OPTIONS_CEILING)
  @ValidateNested({ each: true })
  @Type(() => QuizshowOptionDto)
  options!: QuizshowOptionDto[];

  @ValidateIf((_question, value: unknown) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowAnswerInputDto)
  answer!: QuizshowAnswerInputDto | null;

  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item: unknown) =>
          typeof item === 'string' ? item.trim() : item,
        )
      : value,
  )
  @IsArray()
  @ArrayMaxSize(QUIZSHOW_LIMITS.acceptedAnswersMax)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(QUIZSHOW_LIMITS.acceptedAnswerMax, { each: true })
  acceptedAnswers!: string[];
}

export class QuizshowRoundInputDto {
  @IsIn(QUIZSHOW_ROUND_KINDS)
  kind!: (typeof QUIZSHOW_ROUND_KINDS)[number];

  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowRoundTitleDto)
  title!: QuizshowRoundTitleDto;

  @IsIn(QUIZSHOW_CONTENT_LABELS)
  contentLabel!: (typeof QUIZSHOW_CONTENT_LABELS)[number];

  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowRoundSettingsDto)
  settings!: QuizshowRoundSettingsDto;

  @IsArray()
  @ArrayMaxSize(QUESTIONS_PER_ROUND_CEILING)
  @ValidateNested({ each: true })
  @Type(() => QuizshowQuestionInputDto)
  questions!: QuizshowQuestionInputDto[];
}

export class QuizshowQuizInputDto {
  @ValidateIf((_quiz, value: unknown) => value !== null)
  @IsDateString()
  expectedUpdatedAt!: string | null;

  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.quizTitleMax)
  title!: string;

  @IsIn(QUIZSHOW_LANGUAGE_MODES)
  languages!: (typeof QUIZSHOW_LANGUAGE_MODES)[number];

  @IsIn(QUIZSHOW_LANGUAGES)
  screenLanguage!: (typeof QUIZSHOW_LANGUAGES)[number];

  @IsArray()
  @ArrayMaxSize(ROUNDS_CEILING)
  @ValidateNested({ each: true })
  @Type(() => QuizshowRoundInputDto)
  rounds!: QuizshowRoundInputDto[];
}
