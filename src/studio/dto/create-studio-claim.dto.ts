import { Transform } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsSafeUrl } from '../../common/validators/is-safe-url.decorator';
import { StudioClaimantRole } from '../entities/studio-copyright-claim.entity';
import {
  STUDIO_CLAIMANT_ROLES,
  STUDIO_CLAIM_LIMITS,
} from '../studio-safety.constants';
import { trimStringValue } from './create-studio-release.dto';

/** A trimmed link; an empty one reads as null, so both store null. */
const toLinkOrNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmedLink = value.trim();
  return trimmedLink === '' ? null : trimmedLink;
};

/** `POST /studio/tracks/:id/copyright-claims` (Studio safety). */
export class CreateStudioClaimDto {
  @IsIn(STUDIO_CLAIMANT_ROLES)
  claimantRole!: StudioClaimantRole;

  /** Title and creator of the original. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_CLAIM_LIMITS.originalWorkMax)
  originalWork!: string;

  /** Optional. `IsSafeUrl` takes `https://` (and `mailto:`, which the
   *  pattern then refuses), so only an https link passes. */
  @Transform(toLinkOrNull)
  @ValidateIf(
    (_body: object, value: unknown) => value !== null && value !== undefined,
  )
  @IsString()
  @MaxLength(STUDIO_CLAIM_LIMITS.originalLinkMax)
  @IsSafeUrl()
  @Matches(/^https?:\/\//i, { message: 'originalLink must be a web link' })
  originalLink?: string | null;

  /** What the track copies and where; timestamps welcome. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_CLAIM_LIMITS.detailsMax)
  details!: string;

  /** The good-faith statement, ticked. */
  @Equals(true)
  goodFaith!: true;
}
