import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';
import {
  MAX_MOD_NOTE_LENGTH,
  MEMBER_FACING_NOTE_MESSAGE,
  MIN_MEMBER_FACING_NOTE_LENGTH,
  trimmedText,
} from './member-facing-note';

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
  //
  // PRD-287: bounded on BOTH ends now, unconditionally. Unlike `ModActionDto`
  // there is no action to branch on here — every request to this endpoint is a
  // suspension or a ban, so every one of them reaches a member. Trimmed first,
  // so a note of spaces fails rather than arriving as a blank reason attached
  // to a locked account.
  @Transform(trimmedText)
  @IsString()
  @MinLength(MIN_MEMBER_FACING_NOTE_LENGTH, {
    message: MEMBER_FACING_NOTE_MESSAGE,
  })
  @MaxLength(MAX_MOD_NOTE_LENGTH)
  note!: string;

  // e.g. "7d" / "24h" / "30d" for a time-boxed suspension. OMIT for a permanent
  // ban. Parsed by `parseDuration` (rejects anything but `\d+[hd]`, capped at
  // `MAX_SUSPENSION_DAYS`).
  @IsOptional()
  @IsString()
  @MaxLength(20)
  duration?: string;
}
