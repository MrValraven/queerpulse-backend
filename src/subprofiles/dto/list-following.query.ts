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
import { FOLLOWING_CURSOR_MAX_LENGTH } from '../subprofile-following-cursor';

/**
 * `?page=` / `?before=` for `GET /subprofiles/following`, the viewer's own
 * "personas I follow" list.
 *
 * Page size is fixed at `PAGE_SIZE` and takes no client parameter: this list
 * has one caller and one layout, so a client-chosen size would only widen what
 * a hostile caller can ask the database for. `page` is bounded by `MAX_PAGE`
 * for the reason spelled out there (a huge `page` becomes a huge `OFFSET` that
 * Postgres walks row by row before discarding).
 */
export class ListFollowingQuery {
  // 1-based page index. `@Type` coerces the raw query string to a number before
  // the numeric validators run (query params arrive as strings even under the
  // global `transform: true` pipe). Ignored when `before` is present.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  // Keyset cursor: the previous page's `nextCursor`, opaque to the client. When
  // present the page is the rows strictly after that position and `page` is
  // ignored, so unfollowing a row in place never makes the next page skip one.
  // Only the length is checked here; the service decodes it and refuses a
  // malformed cursor with a 400 carrying `FOLLOWING_CURSOR_INVALID`.
  @IsOptional()
  @IsString()
  @MaxLength(FOLLOWING_CURSOR_MAX_LENGTH)
  before?: string;
}
