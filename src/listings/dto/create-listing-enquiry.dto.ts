import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body for `POST /directory/:slug/enquiries` — a member writing PRIVATELY to
 * the business behind a listing, through the platform's own messaging.
 *
 * The message stays between the member and the business: "I am trans and I want
 * to know whether your staff will be weird with me before I turn up" is
 * something nobody should have to ask in public.
 *
 * The 8-character floor keeps out one-character enquiries, which are noise a
 * business has to open and read. The 2000-character ceiling leaves room for a
 * private message with real context and sits well inside messaging's own
 * 5000-character `body` limit.
 */
export class CreateListingEnquiryDto {
  @IsString() @MinLength(8) @MaxLength(2000) body!: string;

  /** Task 18: the identity the member is acting as, when the mailbox
   *  switcher has one selected, as `SendMessageDto.asIdentityId` carries it.
   *  Left empty, the member writes as themselves. Only their own profile may
   *  start a conversation, so a business, persona or company named here is
   *  refused with `IDENTITY_CANNOT_INITIATE` and nothing is sent. */
  @IsOptional()
  @IsUUID()
  asIdentityId?: string;
}
