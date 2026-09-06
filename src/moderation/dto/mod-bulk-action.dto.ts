import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';
import {
  MAX_MOD_NOTE_LENGTH,
  RequiresMemberFacingNote,
  trimmedText,
} from './member-facing-note';
import { MOD_ACTION_CODES, ModActionCode } from './mod-action.dto';

// `POST /mod/reports/bulk` body — matches `ModBulkInput` in
// `queerpulse/src/features/admin/api/moderation.api.ts` exactly (C6). One
// action applied to many reports.
export class ModBulkActionDto {
  @IsArray()
  @ArrayMinSize(1)
  // Caps the batch so a single request cannot open one long-held transaction
  // over an unbounded id list in `bulkActOnReports` (that method saves every
  // row and writes an audit entry per report inside one transaction). 100 is
  // comfortably above any real bulk-bar selection.
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];

  // Same PRD-287 rule as the single-report path, and it has to be here rather
  // than on `note` below: `note` is `@IsOptional()`, and class-validator's
  // `@IsOptional()` skips every decorator on its own property when the value
  // is `undefined`, which is precisely the bulk case worth catching (a batch
  // `suspend` sent with no note at all).
  @IsIn(MOD_ACTION_CODES)
  @RequiresMemberFacingNote()
  action!: ModActionCode;

  @IsIn(REASON_CODES)
  reasonCode!: ReasonCode;

  // Optional on the wire, because the bulk bar's everyday action is `dismiss`
  // and a batch of "this was fine" needs no prose. It stops being optional in
  // effect the moment `action` is one that lands on a member: the rule on
  // `action` above then requires it, so a bulk suspend or removal cannot leave
  // a hundred members with a blank reason.
  @Transform(trimmedText)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_MOD_NOTE_LENGTH)
  note?: string;

  // e.g. "7d". Not in `ModBulkInput` on the frontend, which today only offers
  // dismiss/spam/reassign from the bulk bar — but `action` accepts every
  // `MOD_ACTION_CODES` value, and a `suspend` requires a duration. Without this
  // field a bulk suspend could only ever fail validation, which is a worse
  // contract than an optional field the client does not yet send.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  duration?: string;
}
