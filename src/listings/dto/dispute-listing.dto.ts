import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

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
