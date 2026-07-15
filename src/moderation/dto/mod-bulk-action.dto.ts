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
}
