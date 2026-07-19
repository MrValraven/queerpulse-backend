import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';
import { MOD_ACTION_CODES, ModActionCode } from './mod-action.dto';

// `POST /mod/reports/bulk` body — matches `ModBulkInput` in
// `queerpulse/src/features/admin/api/moderation.api.ts` exactly (C6). One
// action applied to many reports.
export class ModBulkActionDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  ids: string[];

  @IsIn(MOD_ACTION_CODES)
  action: ModActionCode;

  @IsIn(REASON_CODES)
  reasonCode: ReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
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
