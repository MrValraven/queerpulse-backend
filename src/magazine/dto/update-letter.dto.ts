import { IsBoolean } from 'class-validator';

/**
 * Body of `PATCH /magazine/admin/pieces/:id/letters/:letterId` (spec §7.2
 * After tab "Run in letters" toggle, Magazine Desk Phase 7, Task B3). The
 * only mutable field on a `MagazineLetter` — flips its `runInLetters` flag on
 * the existing row rather than creating a new one.
 */
export class UpdateLetterDto {
  @IsBoolean() runInLetters!: boolean;
}
