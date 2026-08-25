import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ListingOperatingState } from '../entities/listing.entity';

/**
 * `PATCH /listings/:ref/operating-state` body: the listing OWNER declaring
 * whether their business is still trading.
 *
 * Nothing here can reach `status`. Operating state is the business's own
 * report about itself; moderation status is our review of the submission, and
 * the two are kept apart on purpose (see `ListingOperatingState`).
 *
 * The supporting fields are only meaningful for some states, so the service
 * clears the ones that do not apply rather than letting a listing carry a
 * stale "moved to Rua da Prata 42" note after it reopened where it always was.
 */
export class UpdateOperatingStateDto {
  @IsEnum(ListingOperatingState) state!: ListingOperatingState;

  /**
   * Short public explanation shown in the banner ("Closed for refurbishment,
   * back in September"). Optional for every state, and ignored when the state
   * is `open`, which needs no explanation.
   */
  @IsOptional() @IsString() @MaxLength(300) note?: string;

  /**
   * Where the business went. REQUIRED on `moved`: a "we moved" banner with no
   * destination tells a reader nothing they did not already discover by
   * arriving at a closed door. Ignored for every other state.
   */
  @ValidateIf(
    (dto: UpdateOperatingStateDto) => dto.state === ListingOperatingState.Moved,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  movedToAddress?: string;

  /**
   * The successor listing's id, when the moved business already has its own
   * row in this directory, so the banner can link straight to it. Optional
   * even on `moved` (most moves have no successor listing), and an explicit
   * `null` clears a previously set one: `@IsOptional()` skips both `undefined`
   * and `null`, so only a supplied value is uuid-checked.
   */
  @IsOptional() @IsUUID() movedToListingId?: string | null;
}
