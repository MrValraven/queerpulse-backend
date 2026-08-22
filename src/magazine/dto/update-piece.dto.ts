import { OmitType, PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { PieceStage } from '../entities/magazine-piece.entity';
import { CreatePieceDto } from './create-piece.dto';
import { DESK_SHORT_TEXT_MAX } from './desk-text-limits';

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
// `issueId` is omitted from the partial base and re-declared below so it can
// be widened to `string | null` (detach → standalone). Re-widening an
// inherited property in place is a TS override error (TS2416: the derived
// property type must be assignable to the base's `string`), so the field is
// dropped from the base and added fresh here instead.
export class UpdatePieceDto extends PartialType(
  OmitType(CreatePieceDto, ['issueId'] as const),
) {
  @IsOptional() @IsIn(PIECE_STAGES) stage?: PieceStage;

  @IsOptional() brief?: unknown;

  @IsOptional() care?: unknown;

  /**
   * Overrides the inherited `CreatePieceDto.issueId` (`@IsOptional()
   * @IsUUID()`, which rejects `null`) so a piece can be detached back to a
   * standalone highlight by sending `issueId: null`. `ValidateIf` skips the
   * `@IsUUID()` check for an explicit `null`, so both a UUID and `null`
   * validate; the update path then writes `{ issueId: null }` (the entity
   * column is nullable).
   */
  @IsOptional()
  @ValidateIf((updatePiece: UpdatePieceDto) => updatePiece.issueId !== null)
  @IsUUID()
  issueId?: string | null;

  @IsOptional() @IsInt() orderIndex?: number;

  // Capped (CNT-14): a page range like `18–23`, never prose.
  @IsOptional() @IsString() @MaxLength(DESK_SHORT_TEXT_MAX) pages?: string;

  @IsOptional() @IsBoolean() laidOut?: boolean;
}
