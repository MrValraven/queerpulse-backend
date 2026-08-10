import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

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
 * Query params for `GET /magazine/admin/pieces`. Every field is optional —
 * an absent filter simply doesn't narrow the result set. Mirrors the
 * class-validator style of `dto/create-deck.dto.ts`.
 */
export class ListPiecesQuery {
  @IsOptional() @IsIn(PIECE_FORMATS) format?: PieceFormat;

  @IsOptional() @IsUUID() editor?: string;

  @IsOptional() @IsIn(PIECE_STAGES) stage?: PieceStage;

  @IsOptional() @IsString() section?: string;

  @IsOptional() @IsUUID() issue?: string;

  @IsOptional() @IsString() q?: string;

  @IsOptional() @IsIn(SAVED_VIEW_IDS) savedView?: SavedViewId;
}
