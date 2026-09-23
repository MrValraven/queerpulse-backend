import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Task 18: body for `POST /subprofiles/:id/enquiries` and
 * `POST /companies/:slug/enquiries`, a member writing privately to a persona
 * or a company through messaging. The same bounds as
 * `CreateListingEnquiryDto`, for the same reasons: an 8-character floor keeps
 * noise out of a shared mailbox, and 2000 sits well inside messaging's own
 * limit.
 */
export class CreateIdentityEnquiryDto {
  @IsString() @MinLength(8) @MaxLength(2000) body!: string;

  /** The identity the member is acting as, when the mailbox switcher has one
   *  selected. Left empty, the member writes as themselves. Only their own
   *  profile may start a conversation, so a business, persona or company
   *  named here is refused with `IDENTITY_CANNOT_INITIATE`. */
  @IsOptional()
  @IsUUID()
  asIdentityId?: string;
}
