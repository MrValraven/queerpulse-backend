import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/** `GET /communities/:slug/invites/candidates?q=&page=` query params. */
export class ListInviteCandidatesQuery {
  /**
   * Free-text filter over the connection's name, handle, and headline.
   * Matched accent-insensitively (see `connection-search.ts`), so a moderator
   * typing "Sao" finds "São". Trimmed here so a query of only spaces is the
   * same as no query at all.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
