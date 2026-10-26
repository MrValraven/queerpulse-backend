import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

export class ListAdminInviteQuotasQuery {
  // Partial, case-insensitive match on first name, last name, full name or
  // profile slug. Trimmed in the service, one leading "@" stripped, and an
  // empty term reads as no search at all.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
