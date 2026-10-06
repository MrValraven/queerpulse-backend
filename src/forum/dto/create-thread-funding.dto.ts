import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
} from 'class-validator';
import {
  ASK_BENEFICIARIES,
  ASK_PURPOSES,
  FUNDING_ELIGIBILITIES,
  FUNDING_SCOPES,
  MAX_ASK_GOAL_AMOUNT,
  MAX_FUNDER_NAME_LENGTH,
  MAX_FUNDING_AMOUNT,
  MAX_FUNDING_LINK_URL_LENGTH,
  describeFundingInstantProblem,
} from '../forum-funding';
import type {
  AskBeneficiary,
  AskPurpose,
  FundingEligibility,
  FundingScope,
} from '../forum-funding';

/**
 * One constraint for the whole instant check, so a bad value yields exactly
 * one message (class-validator reports every failing decorator). The text
 * comes from forum-funding.ts and starts with the property name, so Nest's
 * parent prefix reads "funding.deadline needs a time zone, ...".
 */
function IsFundingInstant() {
  return (target: object, propertyName: string): void => {
    registerDecorator({
      name: 'isFundingInstant',
      target: target.constructor,
      propertyName,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          describeFundingInstantProblem(value, propertyName) === null,
        defaultMessage: (validationArguments) =>
          describeFundingInstantProblem(
            String(validationArguments?.value),
            propertyName,
          ) ?? `${propertyName} must be a date and time`,
      },
    });
  };
}

/**
 * The optional `funding` object on `POST /forum/threads` and
 * `PATCH /forum/threads/:slug` (wire contract "Create / update payload").
 * Mirrors `CreateThreadPollDto`: validated as a nested object, shape only.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This class checks each field's own shape
 * (types, closed vocabularies, whole euros, column widths). Everything that
 * needs the kind, the clock or another field (which fields are required, an
 * https link, the host allow-list, a deadline in the future, a range the right
 * way up) lives in `validateFundingInput` and answers with a coded error the
 * composer can map. `linkUrl` is therefore any string here.
 *
 * `null` is accepted wherever `@IsOptional` sits, which is how the composer
 * clears a field on PATCH.
 */
export class CreateThreadFundingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_FUNDING_LINK_URL_LENGTH)
  linkUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FUNDER_NAME_LENGTH)
  funderName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_FUNDING_AMOUNT)
  amountMin?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_FUNDING_AMOUNT)
  amountMax?: number | null;

  @IsOptional()
  @IsFundingInstant()
  deadline?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FUNDING_ELIGIBILITIES.length)
  @IsIn(FUNDING_ELIGIBILITIES, { each: true })
  eligibility?: FundingEligibility[];

  @IsOptional()
  @IsIn(FUNDING_SCOPES)
  scope?: FundingScope | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_ASK_GOAL_AMOUNT)
  goalAmount?: number | null;

  @IsOptional()
  @IsIn(ASK_PURPOSES)
  askPurpose?: AskPurpose | null;

  @IsOptional()
  @IsIn(ASK_BENEFICIARIES)
  beneficiary?: AskBeneficiary | null;

  @IsOptional()
  @IsFundingInstant()
  endsAt?: string | null;
}
