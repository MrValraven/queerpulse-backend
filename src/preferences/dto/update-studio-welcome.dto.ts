import {
  ArrayMaxSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsIn,
  ValidateIf,
} from 'class-validator';
import {
  STUDIO_GENRES,
  STUDIO_MOODS,
  StudioGenre,
  StudioMood,
} from '../../studio/studio.constants';

/** Validate whenever the field is present, so `null` fails the type check
 *  (`@IsOptional` would let `null` through to a NOT NULL column). */
const isPresent = (_body: object, value: unknown): boolean =>
  value !== undefined;

/**
 * `PUT /me/studio-welcome`: the Studio welcome, once per account. A PARTIAL
 * replace like `UpdateStudioPlaybackDto`: a field absent from the body is left
 * as stored, and an empty body changes nothing and echoes the stored state.
 */
export class UpdateStudioWelcomeDto {
  /** Marks the welcome as seen. Only `true` is accepted; the stamp is set
   *  once and a later call keeps the first date. */
  @ValidateIf(isPresent)
  @Equals(true)
  hasSeenWelcome?: true;

  /** The picked genres, replacing the stored list. May be empty. */
  @ValidateIf(isPresent)
  @IsArray()
  @ArrayMaxSize(STUDIO_GENRES.length)
  @ArrayUnique()
  @IsIn(STUDIO_GENRES, { each: true })
  genres?: StudioGenre[];

  /** The picked moods, replacing the stored list. May be empty. */
  @ValidateIf(isPresent)
  @IsArray()
  @ArrayMaxSize(STUDIO_MOODS.length)
  @ArrayUnique()
  @IsIn(STUDIO_MOODS, { each: true })
  moods?: StudioMood[];
}
