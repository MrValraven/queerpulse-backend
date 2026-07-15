import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';

export const MOD_ACTION_CODES = [
  'dismiss',
  'warn',
  'hide_content',
  'remove_content',
  'restrict',
  'suspend',
  'ban',
  'shield',
  'escalate',
] as const;

export type ModActionCode = (typeof MOD_ACTION_CODES)[number];

// `PATCH /mod/reports/:id` body — matches `ModActionInput` in
// `queerpulse/src/features/admin/api/moderation.api.ts` exactly (C6).
export class ModActionDto {
  @IsIn(MOD_ACTION_CODES)
  action: ModActionCode;

  @IsIn(REASON_CODES)
  reasonCode: ReasonCode;

  // The exact member-facing text — the reason the member reads.
  @IsString()
  @MaxLength(2000)
  note: string;

  // e.g. "7d" for restrict/suspend.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  duration?: string;
}
