import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

import { ArtState, PieceFormat } from '../entities/magazine-piece.entity';

const PIECE_FORMATS: PieceFormat[] = ['article', 'deck'];
const ART_STATES: ArtState[] = ['none', 'brief', 'in', 'na'];

/**
 * Body of `POST /magazine/admin/pieces`. Metadata fields mirror
 * `MagazinePiece` (see `entities/magazine-piece.entity.ts`) —
 * class-validator, `dto/create-deck.dto.ts` style. `brief`/`care` are not
 * accepted here — a piece is commissioned bare and those jsonb fields are
 * filled in later via `UpdatePieceDto`.
 */
export class CreatePieceDto {
  @IsIn(PIECE_FORMATS) format!: PieceFormat;

  @IsString() @MinLength(1) title!: string;

  @IsString() @MinLength(1) section!: string;

  @IsUUID() editorId!: string;

  @IsOptional() @IsUUID() writerId?: string;

  @IsOptional() @IsDateString() dueOn?: string;

  @IsOptional() @IsInt() wordTarget?: number;

  @IsOptional() @IsInt() slideTarget?: number;

  @IsOptional() @IsUUID() pitchId?: string;

  @IsOptional() @IsBoolean() fresh?: boolean;

  @IsOptional() @IsString() byline?: string;

  @IsOptional() @IsString() kind?: string;

  @IsOptional() @IsUUID() issueId?: string;

  /**
   * Art-workflow status (Magazine Desk Phase 7, Task A3); defaults to
   * `'none'` at the entity/DB level when omitted. Inherited by
   * `UpdatePieceDto` via `PartialType`, same as every other field here.
   */
  @IsOptional() @IsIn(ART_STATES) art?: ArtState;

  /**
   * The issue Cover & Contents blurb for this piece (Magazine Desk Phase 7,
   * Task B2); defaults to `''` at the entity/DB level when omitted. In
   * practice this is set later via `UpdatePieceDto` (`PATCH
   * /magazine/admin/pieces/:id`) from the CoverContentsTab, not at
   * commission time.
   */
  @IsOptional() @IsString() contentsBlurb?: string;
}
