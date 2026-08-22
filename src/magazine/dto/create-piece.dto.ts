import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ArtState, PieceFormat } from '../entities/magazine-piece.entity';
import {
  DESK_BLURB_MAX,
  DESK_SHORT_TEXT_MAX,
  DESK_TITLE_MAX,
} from './desk-text-limits';

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

  // Capped (CNT-14). See `DESK_TITLE_MAX` for why the headline is looser than
  // the other one-line fields.
  @IsString() @MinLength(1) @MaxLength(DESK_TITLE_MAX) title!: string;

  @IsString() @MinLength(1) @MaxLength(DESK_SHORT_TEXT_MAX) section!: string;

  @IsUUID() editorId!: string;

  @IsOptional() @IsUUID() writerId?: string;

  @IsOptional() @IsDateString() dueOn?: string;

  @IsOptional() @IsInt() wordTarget?: number;

  @IsOptional() @IsInt() slideTarget?: number;

  @IsOptional() @IsUUID() pitchId?: string;

  @IsOptional() @IsBoolean() fresh?: boolean;

  @IsOptional() @IsString() @MaxLength(DESK_SHORT_TEXT_MAX) byline?: string;

  @IsOptional() @IsString() @MaxLength(DESK_SHORT_TEXT_MAX) kind?: string;

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
  @IsOptional() @IsString() @MaxLength(DESK_BLURB_MAX) contentsBlurb?: string;
}
