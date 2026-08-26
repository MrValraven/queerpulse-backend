import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { LandlordIntroRequestStatus } from '../entities/landlord-intro-request.entity';

/**
 * `GET /admin/landlords/intro-requests?landlord=<slug>&status=&page=`
 *
 * `status` and `page` are the LOC-19 additions: this is the queue a moderator
 * works, so it has to be able to answer "who is still waiting on an answer"
 * without scrolling through every introduction ever made.
 */
export class ListIntroRequestsQuery {
  @IsOptional() @IsString() @MaxLength(200) landlord?: string;

  @IsOptional()
  @IsEnum(LandlordIntroRequestStatus)
  status?: LandlordIntroRequestStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
