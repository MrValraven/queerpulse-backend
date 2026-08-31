import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import {
  ReadingGroupProposalFormat,
  ReadingGroupProposalStatus,
} from '../entities/reading-group-proposal.entity';

/** Query for the admin reading-group-proposal oversight list: paginated,
 * newest-first, optionally narrowed to a single meeting format and/or a single
 * decision state. */
export class ListAdminReadingGroupProposalsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsEnum(ReadingGroupProposalFormat)
  format?: ReadingGroupProposalFormat;

  // The queue filter the console opens on: `?status=pending` is "what still
  // needs a decision" (LOC-19). Omitted means every state, which is the
  // pre-existing behaviour, so no caller changes meaning by not sending it.
  @IsOptional()
  @IsEnum(ReadingGroupProposalStatus)
  status?: ReadingGroupProposalStatus;
}
