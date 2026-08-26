import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The four things a moderator can do to a housing listing.
 *
 * Expressed as an ACTION rather than as a target status, because three of the
 * four carry obligations the raw status could not: a reason is mandatory, the
 * lister is notified, and `take_down` is only legal from `live`. The endpoint
 * this feeds replaced a bare `PATCH :ref/status` that took any status with no
 * reason, no notification and no audit row, and which no client ever called.
 */
export enum HousingListingDecision {
  /** Publish. Moves the listing to `live` and fires the saved-search alerts. */
  Approve = 'approve',
  /** Send it back to the lister to fix (status `question`). Reason required. */
  RequestChanges = 'request_changes',
  /** Refuse it (status `rejected`). Reason required. */
  Reject = 'reject',
  /** Pull an already-live listing (status `taken_down`). Reason required. */
  TakeDown = 'take_down',
}

/** POST /admin/housing-listings/:ref/decision body (moderator/admin only). */
export class DecideHousingListingDto {
  @IsEnum(HousingListingDecision)
  decision!: HousingListingDecision;

  /**
   * Why. REQUIRED for `request_changes`, `reject` and `take_down` (enforced in
   * `HousingListingModerationService.decide`, which 400s on a blank one),
   * optional as a note on `approve`.
   *
   * It is shown to the LISTER verbatim in their notification and on their own
   * management view, so it is the moderator writing to a member, never an
   * internal shorthand. Stripped of markup at the write boundary.
   */
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
