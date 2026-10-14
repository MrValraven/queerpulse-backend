import { IsBoolean, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { STUDIO_CROSSFADE_MAX_SECONDS } from '../entities/member-preferences.entity';

/** Validate whenever the field is present, so `null` fails the type check
 *  (`@IsOptional` would let `null` through to a NOT NULL column). */
const isPresent = (_body: object, value: unknown): boolean =>
  value !== undefined;

/**
 * `PUT /me/studio-playback`: the Studio player's three settings, a PARTIAL
 * replace like `UpdateMessagingPrivacyDto`. Each Studio control saves on its
 * own the moment it changes, so a field absent from the body is left as
 * stored. An empty body changes nothing and echoes the stored state.
 */
export class UpdateStudioPlaybackDto {
  /** Play the next queued track when one ends. */
  @ValidateIf(isPresent)
  @IsBoolean()
  autoplayNext?: boolean;

  /** Leave explicit tracks out of queues and auto-advance. */
  @ValidateIf(isPresent)
  @IsBoolean()
  hideExplicit?: boolean;

  /** Seconds the outgoing and incoming tracks overlap; 0 is off. */
  @ValidateIf(isPresent)
  @IsInt()
  @Min(0)
  @Max(STUDIO_CROSSFADE_MAX_SECONDS)
  crossfadeSeconds?: number;
}
