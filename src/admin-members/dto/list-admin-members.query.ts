import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_PAGE } from '../../common/pagination';

export class ListAdminMembersQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsIn(['all', 'verified', 'new'])
  filter?: 'all' | 'verified' | 'new';
}
