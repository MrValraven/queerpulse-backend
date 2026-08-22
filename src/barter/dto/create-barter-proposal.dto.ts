import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /barter/:id/proposals`. The message is the whole proposal —
 * it is stored on the row AND delivered to the listing owner's inbox, so the
 * lower bound keeps a one-character "hi" out of both, and the 2000-character
 * ceiling matches `CreateHousingEnquiryDto`, the other cross-domain body that
 * lands in a member's inbox.
 */
export class CreateBarterProposalDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message!: string;
}
