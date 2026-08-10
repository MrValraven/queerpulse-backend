import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Body of `POST /magazine/admin/pieces/:id/letters` (spec §7.2 After tab).
 * Mirrors `dto/create-piece.dto.ts` style.
 */
export class CreateLetterDto {
  @IsString() @MinLength(1) who!: string;

  @IsString() @MinLength(1) body!: string;

  @IsOptional() @IsBoolean() runInLetters?: boolean;
}
