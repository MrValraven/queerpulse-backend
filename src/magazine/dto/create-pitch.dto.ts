import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

import { PieceFormat } from '../entities/magazine-piece.entity';

const PIECE_FORMATS: PieceFormat[] = ['article', 'deck'];

/**
 * Body of `POST /magazine/admin/pitches`. A pitch lands in the editor
 * inbox with `status: 'waiting'`; triage (`TriagePitchDto`) moves it on.
 * Mirrors `dto/create-deck.dto.ts`.
 */
export class CreatePitchDto {
  @IsString() @MinLength(1) title!: string;

  @IsString() @MinLength(1) from!: string;

  @IsString() @MinLength(1) note!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsIn(PIECE_FORMATS) suggestFormat?: PieceFormat;

  @IsOptional() @IsBoolean() fresh?: boolean;

  @IsOptional() @IsUUID() issueId?: string;
}
