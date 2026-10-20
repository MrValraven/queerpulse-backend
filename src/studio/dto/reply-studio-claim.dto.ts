import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_CLAIM_LIMITS } from '../studio-safety.constants';
import { trimStringValue } from './create-studio-release.dto';

/** `POST /me/studio/copyright-claims/:id/reply` (Studio safety). */
export class ReplyStudioClaimDto {
  /** The claimant's one reply to the counter-notice. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_CLAIM_LIMITS.replyMax)
  reply!: string;
}
