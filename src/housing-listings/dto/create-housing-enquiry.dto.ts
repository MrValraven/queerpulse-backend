import { IsString, MaxLength, MinLength } from 'class-validator';

/** POST /housing-listings/:ref/enquiries body. The 20-char floor matches the
 * frontend housing MessageModal's min-length validation. */
export class CreateHousingEnquiryDto {
  @IsString() @MinLength(20) @MaxLength(2000) body: string;
}
