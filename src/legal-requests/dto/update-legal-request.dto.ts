import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  LEGAL_REQUEST_DATA_CATEGORIES,
  LegalRequestOutcome,
  LegalRequestType,
  type LegalRequestDataCategory,
} from '../legal-request-vocabulary';
import {
  ISO_DAY_PATTERN,
  MAX_ACCOUNTS_PER_LEGAL_REQUEST,
  MAX_JURISDICTION_LENGTH,
  MAX_LEGAL_REQUEST_TEXT_LENGTH,
  MAX_REQUESTING_BODY_LENGTH,
} from './create-legal-request.dto';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body for `PATCH /admin/legal-requests/:id`. Every field is optional and only
 * the keys actually present are written, so a demand recorded as `pending` on
 * the day it arrived can be completed later without restating what is already
 * on file.
 *
 * Written by hand rather than as a `PartialType(CreateLegalRequestDto)`,
 * because the nullable fields have to accept an explicit `null` to CLEAR them:
 * a notification date entered against the wrong row has to be removable, and a
 * partial type can only make a field absent. `@IsOptional()` passes `null`
 * through without running the other validators, which is exactly the clearing
 * case.
 */
export class UpdateLegalRequestDto {
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(MAX_REQUESTING_BODY_LENGTH)
  requestingBody?: string;

  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(MAX_JURISDICTION_LENGTH)
  jurisdiction?: string;

  @IsOptional()
  @IsEnum(LegalRequestType)
  requestType?: LegalRequestType;

  @IsOptional()
  @Matches(ISO_DAY_PATTERN, {
    message: 'receivedOn must be a calendar day in YYYY-MM-DD form',
  })
  receivedOn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_ACCOUNTS_PER_LEGAL_REQUEST)
  accountsAffected?: number;

  @IsOptional()
  @IsEnum(LegalRequestOutcome)
  outcome?: LegalRequestOutcome;

  @IsOptional()
  @ArrayMaxSize(LEGAL_REQUEST_DATA_CATEGORIES.length)
  @ArrayUnique()
  @IsIn([...LEGAL_REQUEST_DATA_CATEGORIES], { each: true })
  dataDisclosed?: LegalRequestDataCategory[];

  @IsOptional()
  @Matches(ISO_DAY_PATTERN, {
    message: 'memberNotifiedOn must be a calendar day in YYYY-MM-DD form',
  })
  memberNotifiedOn?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_ACCOUNTS_PER_LEGAL_REQUEST)
  accountsNotified?: number;

  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MaxLength(MAX_LEGAL_REQUEST_TEXT_LENGTH)
  notificationWithheldReason?: string | null;

  @IsOptional()
  @IsBoolean()
  isUnderGagOrder?: boolean;

  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MaxLength(MAX_LEGAL_REQUEST_TEXT_LENGTH)
  internalNote?: string | null;
}
