import { IsBoolean } from 'class-validator';

/**
 * `PATCH /listings/:ref/visibility` body: the listing OWNER pausing or
 * resuming their own entry in the directory.
 *
 * Nothing here can reach `status` (the moderation lifecycle) or
 * `operatingState` (whether the business is trading). This is only about
 * whether the LISTING is currently shown, and hiding one keeps its reviews,
 * photos and history exactly where they are so unhiding restores it whole.
 * Owners were deleting listings to get this effect, and a delete takes the
 * reviews with it.
 */
export class UpdateListingVisibilityDto {
  /** `true` withdraws the listing from the directory; `false` puts it back. */
  @IsBoolean()
  isHiddenByOwner!: boolean;
}
