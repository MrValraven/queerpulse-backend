import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { DESK_BODY_MAX } from './desk-text-limits';

/**
 * Body of `POST /magazine/admin/pieces/:id/corrections` (spec §7.2 After
 * tab). `publishedOn` defaults to today (in the service) when omitted.
 */
export class CreateCorrectionDto {
  // Capped (CNT-14): a correction is a published note, not a manuscript.
  @IsString() @MinLength(1) @MaxLength(DESK_BODY_MAX) text!: string;

  @IsOptional() @IsDateString() publishedOn?: string;
}
