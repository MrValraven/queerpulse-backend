import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { SavedKind } from '../entities/saved-item.entity';

/** `GET /me/saved?kind=&listId=&page=&cursor=` query params (`getSaved` in
 *  `saved.api.ts`). */
export class ListSavedQuery {
  @IsOptional()
  @IsEnum(SavedKind)
  kind?: SavedKind;

  /**
   * Narrow to one of the caller's own named lists (`GET /me/saved/lists`).
   * Absent means the whole flat saved set, which is what every existing caller
   * sends and what they keep getting. A list id belonging to somebody else
   * returns an empty page rather than an error, since whether a given uuid is
   * a real list is not something a stranger gets to learn.
   */
  @IsOptional()
  @IsUUID()
  listId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  /**
   * ENG-04: the `nextCursor` of the page before. Opaque; a malformed value
   * reads as the first page. When present, `page` is ignored and the page
   * starts right after the item the cursor names.
   */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
