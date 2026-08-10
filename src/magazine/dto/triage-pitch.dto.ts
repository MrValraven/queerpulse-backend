import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

import { PieceFormat } from '../entities/magazine-piece.entity';

const PIECE_FORMATS: PieceFormat[] = ['article', 'deck'];

export type PitchVerdict = 'maybe' | 'pass' | 'commission';

const PITCH_VERDICTS: PitchVerdict[] = ['maybe', 'pass', 'commission'];

/**
 * Body of `PATCH /magazine/admin/pitches/:id`. `verdict` drives which of
 * the remaining fields matter: `pass` reads `passTemplate`/`passNote`;
 * `commission` reads the commission subset (mirrors the relevant
 * `CreatePieceDto` fields needed to spin up the resulting `MagazinePiece`);
 * `maybe` reads neither. Mirrors `dto/create-deck.dto.ts`.
 */
export class TriagePitchDto {
  @IsIn(PITCH_VERDICTS) verdict!: PitchVerdict;

  @IsOptional() @IsString() passTemplate?: string;

  @IsOptional() @IsString() passNote?: string;

  // Commission fields — used only when `verdict === 'commission'`.
  @IsOptional() @IsUUID() editorId?: string;

  @IsOptional() @IsString() section?: string;

  @IsOptional() @IsIn(PIECE_FORMATS) format?: PieceFormat;

  @IsOptional() @IsDateString() dueOn?: string;

  @IsOptional() @IsInt() wordTarget?: number;
}
