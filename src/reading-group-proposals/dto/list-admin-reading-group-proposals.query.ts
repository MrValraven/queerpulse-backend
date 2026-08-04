import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { ReadingGroupProposalFormat } from '../entities/reading-group-proposal.entity';

/** Query for the admin reading-group-proposal oversight list: paginated,
 * newest-first, optionally narrowed to a single meeting format. */
export class ListAdminReadingGroupProposalsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsEnum(ReadingGroupProposalFormat)
  format?: ReadingGroupProposalFormat;
}
