import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_PAGE } from '../../common/pagination';

/** Longest name search the directory accepts; nobody's name runs past it. */
export const ADMIN_MEMBERS_SEARCH_MAX_LENGTH = 100;

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

  /**
   * Name search across the whole directory, matched on the server so a member
   * on a page the admin has not loaded yet is still found. Accent-folded, so
   * "Joao" finds "João".
   */
  @IsOptional()
  @IsString()
  @MaxLength(ADMIN_MEMBERS_SEARCH_MAX_LENGTH)
  q?: string;
}
