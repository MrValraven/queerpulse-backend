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

/** `YYYY-MM-DD`, the shape every `date` column in this repo is written with. */
export const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_REQUESTING_BODY_LENGTH = 200;
export const MAX_JURISDICTION_LENGTH = 120;
/** Long enough for a paragraph of legal reasoning, short enough that the
 *  register stays a register rather than a document store. */
export const MAX_LEGAL_REQUEST_TEXT_LENGTH = 4000;
/**
 * A single demand cannot name more accounts than the platform has members
 * several times over. The cap is a typo guard: an operator entering `100000`
 * where they meant `10` would move a published figure by orders of magnitude,
 * and the report has no way to notice.
 */
export const MAX_ACCOUNTS_PER_LEGAL_REQUEST = 100000;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body for `POST /admin/legal-requests`: one demand from a court, a police
 * force, a ministry or another arm of a state, as an admin records it.
 *
 * `requestingBody` and `jurisdiction` are required and non-empty. A register
 * entry that does not say who asked is not a record of anything, and the
 * public report counts rows, so a placeholder row would move a published
 * number.
 *
 * `outcome` defaults to `pending` at the column, so a demand can be recorded
 * the hour it arrives and answered later. That is the intended flow: the value
 * of this register comes from rows being written immediately.
 */
export class CreateLegalRequestDto {
  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(MAX_REQUESTING_BODY_LENGTH)
  requestingBody!: string;

  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(MAX_JURISDICTION_LENGTH)
  jurisdiction!: string;

  @IsEnum(LegalRequestType)
  requestType!: LegalRequestType;

  @Matches(ISO_DAY_PATTERN, {
    message: 'receivedOn must be a calendar day in YYYY-MM-DD form',
  })
  receivedOn!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_ACCOUNTS_PER_LEGAL_REQUEST)
  accountsAffected?: number;

  @IsOptional()
  @IsEnum(LegalRequestOutcome)
  outcome?: LegalRequestOutcome;

  /** Stable keys from the code registry, never free strings: every reader has
   *  copy for exactly those categories. An absent or empty array means nothing
   *  was handed over. */
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

  /** Staff-only. Never leaves the admin surface, at any aggregation. */
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MaxLength(MAX_LEGAL_REQUEST_TEXT_LENGTH)
  internalNote?: string | null;
}
