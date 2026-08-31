import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

import { PieceFormat, PieceStage } from '../entities/magazine-piece.entity';

const PIECE_FORMATS: PieceFormat[] = ['article', 'deck'];

const PIECE_STAGES: PieceStage[] = [
  'commissioned',
  'drafting',
  'in_review',
  'edit',
  'sensitivity_read',
  'layout',
  'ready',
];

export type SavedViewId = 'v-late' | 'v-art' | 'v-sens' | 'v-pay';

const SAVED_VIEW_IDS: SavedViewId[] = ['v-late', 'v-art', 'v-sens', 'v-pay'];

/**
 * Page size used when the caller sends no `pageSize`. Deliberately larger than
 * the platform-wide `PAGE_SIZE` (20): the desk board renders every stage
 * column at once, so a 20-row page would visibly truncate the pipeline. Kept
 * well under `PIECE_PAGE_SIZE_MAX` so the common load stays one modest query
 * instead of the whole `magazine_piece` table (CNT-09).
 */
export const PIECE_PAGE_SIZE_DEFAULT = 50;

/** Hard ceiling on `pageSize`; a caller cannot ask for the whole table. */
export const PIECE_PAGE_SIZE_MAX = 200;

/**
 * Query params for `GET /magazine/admin/pieces`. Every filter is optional —
 * an absent filter simply doesn't narrow the result set. Mirrors the
 * class-validator style of `dto/create-deck.dto.ts`.
 *
 * `page`/`pageSize` are optional too, but the endpoint is ALWAYS paginated:
 * omitting them means "first page, default size", never "everything". The
 * response is the shared `Paginated<PieceListItem>` envelope
 * (`{items,total,page,pageSize}`) — see `MagazinePieceService.listPieces`.
 */
export class ListPiecesQuery {
  @IsOptional() @IsIn(PIECE_FORMATS) format?: PieceFormat;

  @IsOptional() @IsUUID() editor?: string;

  @IsOptional() @IsIn(PIECE_STAGES) stage?: PieceStage;

  // Capped (CNT-24): `section` is matched with `=` and additionally feeds the
  // free-text `ILIKE`, so an unbounded string is pure waste on the wire.
  @IsOptional() @IsString() @MaxLength(80) section?: string;

  @IsOptional() @IsUUID() issue?: string;

  // Capped (CNT-24): `q` becomes a `%…%` pattern over three columns. The value
  // is LIKE-escaped, so this is a cost bound rather than an injection guard.
  @IsOptional() @IsString() @MaxLength(100) q?: string;

  @IsOptional() @IsIn(SAVED_VIEW_IDS) savedView?: SavedViewId;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PIECE_PAGE_SIZE_MAX)
  pageSize?: number;
}
