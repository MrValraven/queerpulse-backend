import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `POST /me/affiliation` body — matches
 * `affiliation.api.ts#postAffiliation`'s `{ companySlug, role }` exactly.
 * `status` is never accepted from the client; it is derived server-side.
 */
export class SetAffiliationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  companySlug: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  role: string;
}
