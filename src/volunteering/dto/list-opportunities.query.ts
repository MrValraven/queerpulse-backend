import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import {
  OpportunityCause,
  OpportunityCommitLevel,
} from '../entities/volunteer-opportunity.entity';

export class ListOpportunitiesQuery {
  // Matches an opportunity that lists this cause anywhere in
  // `VolunteerOpportunity.causes`, not only the one it leads with. Still a
  // single value: the board's chip row picks one cause at a time.
  @IsOptional() @IsEnum(OpportunityCause) cause?: OpportunityCause;

  // Filters `VolunteerOpportunity.commit`.
  @IsOptional() @IsEnum(OpportunityCommitLevel) commit?: OpportunityCommitLevel;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
