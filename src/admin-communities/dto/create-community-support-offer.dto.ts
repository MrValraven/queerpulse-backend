import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  MAX_SUPPORT_OFFER_NOTE_LENGTH,
  MAX_SUPPORT_OPTIONS_PER_OFFER,
  MIN_SUPPORT_OPTIONS_PER_OFFER,
  OFFERABLE_COMMUNITY_SUPPORT_OPTIONS,
  type CommunitySupportOption,
} from '../../communities/community-support-options';

/**
 * Body for `POST /admin/communities/:slug/support-offers`.
 *
 * `options` is validated against the code registry rather than accepted as
 * free strings: every reader of this row has copy for exactly those four keys,
 * and a fifth would render as nothing. `@ArrayUnique` because offering the
 * same thing twice is a client bug, not an instruction.
 *
 * `note` is stored as plain text — `AdminCommunitySupportService` runs it
 * through `toStoredPlainText` before it reaches the column, so no markup is
 * ever persisted (see `communities/community-plain-text.ts`). It reaches other
 * members, which is why the strip happens at the write boundary once rather
 * than at every render site.
 */
export class CreateCommunitySupportOfferDto {
  @ArrayMinSize(MIN_SUPPORT_OPTIONS_PER_OFFER)
  @ArrayMaxSize(MAX_SUPPORT_OPTIONS_PER_OFFER)
  @ArrayUnique()
  @IsIn([...OFFERABLE_COMMUNITY_SUPPORT_OPTIONS], { each: true })
  options!: CommunitySupportOption[];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUPPORT_OFFER_NOTE_LENGTH)
  note?: string | null;
}
