import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';
import {
  MAX_MOD_NOTE_LENGTH,
  RequiresMemberFacingNote,
  trimmedText,
} from './member-facing-note';

/**
 * `shield` is deliberately absent. It was a selectable action code with no
 * implementation anywhere: picking it resolved the report, wrote an audit row
 * reading "shielded member", and did nothing to anyone. A moderator running the
 * graduated ladder believed a protective step had been taken when none had.
 * Removing it is the honest half of TS-02; the other half is `warn` now
 * actually reaching the member. Old `mod_audit_logs` rows carrying the code
 * still read fine: `outcomeLabelFor` falls through to the raw code for anything
 * it has no label for.
 */
export const MOD_ACTION_CODES = [
  'dismiss',
  'warn',
  'hide_content',
  'remove_content',
  'restrict',
  'suspend',
  'ban',
  'escalate',
] as const;

export type ModActionCode = (typeof MOD_ACTION_CODES)[number];

// `PATCH /mod/reports/:id` body — matches `ModActionInput` in
// `queerpulse/src/features/admin/api/moderation.api.ts` exactly (C6).
export class ModActionDto {
  // `@RequiresMemberFacingNote` sits HERE rather than on `note` on purpose:
  // see its doc comment. It is the PRD-287 rule, and it reads `note` off the
  // whole DTO.
  @IsIn(MOD_ACTION_CODES)
  @RequiresMemberFacingNote()
  action!: ModActionCode;

  @IsIn(REASON_CODES)
  reasonCode!: ReasonCode;

  // The exact member-facing text — the reason the member reads, and the thing
  // their appeal answers. Trimmed on the way in, so a note of spaces is stored
  // and measured as the empty string it is. Required and non-blank for every
  // action that lands on a member (`member-facing-note.ts` says which, and
  // why); still accepted empty for `dismiss` and `escalate`, which reach
  // nobody.
  @Transform(trimmedText)
  @IsString()
  @MaxLength(MAX_MOD_NOTE_LENGTH)
  note!: string;

  // e.g. "7d" for restrict/suspend.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  duration?: string;
}
