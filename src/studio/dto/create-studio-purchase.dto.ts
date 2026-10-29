import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { STUDIO_PURCHASE_LIMITS } from '../studio-purchase-rules';
import { trimStringValue } from './create-studio-release.dto';

/** `POST /studio/purchases` ("I've paid"): exactly one of `releaseId` and
 *  `trackId`, which the service checks. */
export class CreateStudioPurchaseDto {
  @IsOptional()
  @IsUUID()
  releaseId?: string;

  @IsOptional()
  @IsUUID()
  trackId?: string;

  @IsInt()
  @Min(0)
  @Max(STUDIO_PURCHASE_LIMITS.amountMaxCents)
  amountCents!: number;

  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_PURCHASE_LIMITS.payerNameMaxLength)
  payerName?: string | null;

  @IsBoolean()
  isOnWall!: boolean;

  /** Required key; null shows the account. Ignored when isOnWall is false
   *  (stored as account, null). */
  @ValidateIf((_body, value) => value !== null)
  @IsUUID()
  shownAsSubprofileId!: string | null;

  /** From route 18: the code the buyer put in their payment note. */
  @Matches(/^[2-9A-HJKMNP-Z]{6}$/)
  referenceCode!: string;

  @IsString()
  @MaxLength(200)
  referenceToken!: string;
}
