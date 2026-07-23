import { IsOptional, IsString, MaxLength } from 'class-validator';

/** GET /admin/landlords/intro-requests?landlord=<slug> */
export class ListIntroRequestsQuery {
  @IsOptional() @IsString() @MaxLength(200) landlord?: string;
}
