import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_CLAIM_LIMITS } from '../studio-safety.constants';
import { trimStringValue } from './create-studio-release.dto';

/** `POST /admin/studio/copyright-claims/:id/decline`, `/uphold`, `/reject`. */
export class DecideStudioClaimDto {
  /** Shown to both sides. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_CLAIM_LIMITS.staffNoteMax)
  note!: string;
}
