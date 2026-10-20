import { Transform } from 'class-transformer';
import { Equals, IsString, MaxLength, MinLength } from 'class-validator';
import { STUDIO_CLAIM_LIMITS } from '../studio-safety.constants';
import { trimStringValue } from './create-studio-release.dto';

/** `POST /studio/copyright-claims/:id/counter` (Studio safety). */
export class CounterStudioClaimDto {
  /** The artist's counter-notice. No member id is stored with it. */
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_CLAIM_LIMITS.counterNoteMax)
  note!: string;

  /** The good-faith statement, ticked. */
  @Equals(true)
  goodFaith!: true;
}
