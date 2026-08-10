import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator';

import { PieceStage } from '../entities/magazine-piece.entity';
import { CreatePieceDto } from './create-piece.dto';

const PIECE_STAGES: PieceStage[] = [
  'commissioned',
  'drafting',
  'in_review',
  'edit',
  'sensitivity_read',
  'layout',
  'ready',
];

/**
 * `PATCH /magazine/admin/pieces/:id`. Every creation field is patchable,
 * plus workflow fields that only make sense post-commission. `brief`/`care`
 * are typed `unknown` on purpose: the jsonb shapes (`PieceBrief`/`PieceCare`)
 * aren't expressible as class-validator decorators, so they're validated by
 * hand via `validatePieceBrief`/`validatePieceCare` in
 * `piece-jsonb.validation.ts`, called by the service before `save()`
 * (mirrors the `CreateDeckDto.slides` idiom).
 */
export class UpdatePieceDto extends PartialType(CreatePieceDto) {
  @IsOptional() @IsIn(PIECE_STAGES) stage?: PieceStage;

  @IsOptional() brief?: unknown;

  @IsOptional() care?: unknown;

  @IsOptional() @IsInt() orderIndex?: number;

  @IsOptional() @IsString() pages?: string;

  @IsOptional() @IsBoolean() laidOut?: boolean;
}
