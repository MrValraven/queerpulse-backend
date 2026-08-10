import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

/**
 * Body of `POST /magazine/writer/pitches` (Magazine Desk Phase 6, Task 2).
 * Unlike the editor-side `CreatePitchDto`, there is no `from` field — the
 * pitch is stamped with the authenticated writer's id (`submitterId`) by
 * `MagazinePieceService.submitPitch`, and the editor desk resolves a display
 * name from the writer's account rather than free text.
 */
export class SubmitPitchDto {
  @IsString() @MinLength(1) title!: string;

  @IsString() @MinLength(1) note!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];
}
