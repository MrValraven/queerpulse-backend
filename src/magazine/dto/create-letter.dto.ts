import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { DESK_BODY_MAX, DESK_SHORT_TEXT_MAX } from './desk-text-limits';

/**
 * Body of `POST /magazine/admin/pieces/:id/letters` (spec §7.2 After tab).
 * Mirrors `dto/create-piece.dto.ts` style.
 */
export class CreateLetterDto {
  @IsString() @MinLength(1) @MaxLength(DESK_SHORT_TEXT_MAX) who!: string;

  // Capped (CNT-14): every `getPieceRecordFull` ships the whole letters list.
  @IsString() @MinLength(1) @MaxLength(DESK_BODY_MAX) body!: string;

  @IsOptional() @IsBoolean() runInLetters?: boolean;
}
