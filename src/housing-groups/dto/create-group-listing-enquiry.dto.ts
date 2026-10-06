import { IsString, MaxLength, MinLength } from 'class-validator';

/** POST /housing-groups/:slug/listings/:id/enquiries body (PRD-443). The same
 * bounds as `CreateHousingEnquiryDto`, since both are read by the same
 * frontend enquiry modal and its 20-character floor. */
export class CreateGroupListingEnquiryDto {
  @IsString() @MinLength(20) @MaxLength(2000) body!: string;
}
