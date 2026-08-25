import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * The `reasonCode` every `POST /listings/:ref/dispute` files its report under
 * (`ReportsService.create`'s taxonomy; see `reports/reason-catalogue.ts`).
 *
 * Exported as a constant rather than repeated as a literal because two places
 * now depend on the exact string: `ListingsService.dispute`, which writes it,
 * and `ListingOwnerPendingService`, which reads it back to tell a listing's
 * owner that a dispute is open. A drifting literal there would silently report
 * "no disputes" forever.
 */
export const LISTING_DISPUTE_REASON_CODE = 'listing_dispute';

/**
 * `POST /listings/:ref/dispute` body (item #13). Anyone — including the named
 * business itself — can contest a "friendly"/unowned listing: `reason` is the
 * free-text explanation a moderator reads in the queue, `contactEmail` an
 * optional way to reach a disputer who has no reason to be reachable via their
 * member account. The dispute is filed through the existing report+moderation
 * pipeline as a `listing_dispute`-coded report against the listing.
 */
export class DisputeListingDto {
  @IsString() @IsNotEmpty() @MaxLength(2000) reason!: string;

  @IsOptional() @IsEmail() @MaxLength(200) contactEmail?: string;
}
