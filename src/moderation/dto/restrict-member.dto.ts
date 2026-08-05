import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';

/**
 * `POST /admin/members/:id/restrict` body — a direct admin restriction from the
 * member drawer. Mirrors the moderation queue's `ModActionDto`, minus the
 * `action` field: the action is DERIVED from `duration` — a value like `"7d"`
 * makes it a time-boxed suspension, an omitted `duration` a permanent ban. That
 * keeps a malformed duration from ever silently becoming a permanent ban (an
 * unparseable string throws rather than falling through to "no duration").
 */
export class RestrictMemberDto {
  // The reason cited, from the shared taxonomy (`reason-catalogue.ts`).
  @IsIn(REASON_CODES)
  reasonCode!: ReasonCode;

  // The exact member-facing text — the reason the restricted member reads in
  // their `moderation_outcome` notification.
  @IsString()
  @MaxLength(2000)
  note!: string;

  // e.g. "7d" / "24h" / "30d" for a time-boxed suspension. OMIT for a permanent
  // ban. Parsed by `parseDuration` (rejects anything but `\d+[hd]`, capped at
  // `MAX_SUSPENSION_DAYS`).
  @IsOptional()
  @IsString()
  @MaxLength(20)
  duration?: string;
}
