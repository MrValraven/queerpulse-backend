import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ConnectionSort, ConnectionTab } from '../connections.service';

/** The orderings the list endpoint accepts. `recent` is the default. */
export const CONNECTION_SORTS = [
  'recent',
  'alphabetical',
  'mutuals',
] as const satisfies readonly ConnectionSort[];

/** `GET /connections?tab=&page=&q=&sort=` query params (`getConnections` in the FE). */
export class ListConnectionsQuery {
  @IsOptional()
  @IsIn(['all', 'incoming', 'outgoing', 'vouched'])
  tab?: ConnectionTab;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * Free-text filter over the other member's name, handle, and headline.
   * Matched accent-insensitively (see `connection-search.ts`), so a member
   * typing "Sao" finds "São". Trimmed here so a query of only spaces is the
   * same as no query at all.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;

  @IsOptional()
  @IsIn(CONNECTION_SORTS)
  sort?: ConnectionSort;
}
