import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
  QUIZSHOW_CLOSEST_TOLERANCE_MODES,
  QUIZSHOW_CONTENT_LABELS,
  QUIZSHOW_LANGUAGE_MODES,
  QUIZSHOW_LIMITS,
  QUIZSHOW_MEDIA_REVEALS,
  QUIZSHOW_QUESTION_TYPES,
  QUIZSHOW_ROUND_KINDS,
  QUIZSHOW_SCREEN_LANGUAGES,
  QUIZSHOW_TALK_SECONDS_VALUES,
  QUIZSHOW_WHEEL_BONUS_VALUES,
  QUIZSHOW_WHEEL_PICKS,
  QuizshowClosestToleranceMode,
  QuizshowMediaReveal,
  QuizshowQuestionType,
  QuizshowScreenLanguage,
  QuizshowTalkSeconds,
  QuizshowWheelBonus,
  QuizshowWheelPick,
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

/** Picture description for screen readers, each language 0..mediaAltMax. */
export class QuizshowMediaAltDto {
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.mediaAltMax)
  en!: string;

  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.mediaAltMax)
  pt!: string;
}

/** The "Fun fact" shown with the answer, each language 0..revealNoteMax. */
export class QuizshowRevealNoteDto {
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.revealNoteMax)
  en!: string;

  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.revealNoteMax)
  pt!: string;
}

/** The unit label beside a closest-number field, each language 0..numberUnitMax. */
export class QuizshowNumberUnitDto {
  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.numberUnitMax)
  en!: string;

  @IsString()
  @MaxLength(QUIZSHOW_LIMITS.numberUnitMax)
  pt!: string;
}

/** Closest-number tolerance. The DTO checks the shape; the amount's range per
 *  mode is a `tolerance_out_of_range` problem from validation. */
export class QuizshowClosestToleranceDto {
  @IsIn(QUIZSHOW_CLOSEST_TOLERANCE_MODES)
  mode!: QuizshowClosestToleranceMode;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  amount!: number;
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

  /** The three wheel fields are optional on input so a studio page cached from
   *  before the wheel still saves; the mapping fills the defaults. */
  @IsOptional()
  @IsIn(QUIZSHOW_WHEEL_BONUS_VALUES)
  wheelBonus?: QuizshowWheelBonus;

  @IsOptional()
  @IsIn(QUIZSHOW_WHEEL_PICKS)
  wheelPick?: QuizshowWheelPick;

  @IsOptional()
  @IsInt()
  @Min(QUIZSHOW_LIMITS.wheelSlicesMin)
  @Max(QUIZSHOW_LIMITS.wheelSlicesMax)
  sliceCount?: number | null;

  /** Warm-up and talk time are optional on input so a studio page cached from
   *  before they existed still saves; the mapping fills false and 0. */
  @IsOptional()
  @IsBoolean()
  isWarmUp?: boolean;

  @IsOptional()
  @IsIn(QUIZSHOW_TALK_SECONDS_VALUES)
  talkSeconds?: QuizshowTalkSeconds;
}

export class QuizshowAnswerInputDto {
  /** Multiple choice. Sorting, duplicates and the 1..options - 1 count are
   *  validation problems, so the DTO checks the array shape only. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(QUIZSHOW_LIMITS.multipleChoiceOptionsMax)
  @IsInt({ each: true })
  @Min(0, { each: true })
  correctIndexes?: number[];

  /** The single correct option a studio page cached before live v2 saves.
   *  The service turns it into `correctIndexes` before validation. */
  @IsOptional()
  @IsInt()
  @Min(0)
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

  /** Closest number, beside `value`. A studio page cached before live v2
   *  saves `value` alone, and the service reads that as "Within 10%". */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowClosestToleranceDto)
  tolerance?: QuizshowClosestToleranceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuizshowShortTextDto)
  truth?: QuizshowShortTextDto;
}

/** The key sets each question type's answer may hold, every key of a set
 *  required. Multiple choice and closest number also take the shape a studio
 *  page cached before live v2 saves (`correctIndex`; `value` with no
 *  tolerance), which the service normalises before validation. A poll takes
 *  none, so its answer must be null. */
const ANSWER_KEY_SETS_BY_TYPE: Record<
  QuizshowQuestionType,
  ReadonlyArray<readonly string[]>
> = {
  multiple_choice: [['correctIndexes'], ['correctIndex']],
  true_false: [['isTrue']],
  type_answer: [['text']],
  order: [['orderedIds']],
  closest_number: [['value', 'tolerance'], ['value']],
  prompt: [['truth']],
  poll: [],
};

/**
 * Class decorator for `QuizshowQuestionInputDto`: a non-null `answer` holds
 * exactly one key set its question type takes and no other key.
 */
export function IsQuizshowAnswerForType(validationOptions?: ValidationOptions) {
  return IsQuizshowClassValid<QuizshowQuestionInputDto>(
    (question) => {
      if (question.answer === null || question.answer === undefined) {
        return true;
      }
      const keySets = ANSWER_KEY_SETS_BY_TYPE[question.type];
      if (keySets === undefined || keySets.length === 0) {
        return false;
      }
      const presentKeys = Object.keys(question.answer).filter(
        (key) =>
          (question.answer as unknown as Record<string, unknown>)[key] !==
          undefined,
      );
      return keySets.some(
        (expectedKeys) =>
          presentKeys.length === expectedKeys.length &&
          expectedKeys.every((expectedKey) =>
            presentKeys.includes(expectedKey),
          ),
      );
    },
    'answer must hold exactly the keys its question type takes',
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

  /** The four fields below are optional on input so a studio page cached from
   *  before they existed still saves; the mapping fills '' both and 'instant'. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowMediaAltDto)
  mediaAlt?: QuizshowMediaAltDto;

  @IsOptional()
  @IsIn(QUIZSHOW_MEDIA_REVEALS)
  mediaReveal?: QuizshowMediaReveal;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowRevealNoteDto)
  revealNote?: QuizshowRevealNoteDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QuizshowNumberUnitDto)
  numberUnit?: QuizshowNumberUnitDto;

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

  @IsIn(QUIZSHOW_SCREEN_LANGUAGES)
  screenLanguage!: QuizshowScreenLanguage;

  @IsArray()
  @ArrayMaxSize(ROUNDS_CEILING)
  @ValidateNested({ each: true })
  @Type(() => QuizshowRoundInputDto)
  rounds!: QuizshowRoundInputDto[];
}
