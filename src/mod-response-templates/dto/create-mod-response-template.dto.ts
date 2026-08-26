import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { REASON_CODES, ReasonCode } from '../../reports/reason-catalogue';
import {
  MOD_ACTION_CODES,
  ModActionCode,
} from '../../moderation/dto/mod-action.dto';

// `POST /admin/mod-response-templates` body. Mirrors
// `ModResponseTemplateWriteBody` in
// `queerpulse/src/features/admin/api/adminModResponseTemplates.api.ts`.
export class CreateModResponseTemplateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label!: string;

  // Same 2000 cap as `ModActionDto.note`: a template must never be able to
  // prefill a note the action endpoint would then reject.
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  body!: string;

  // Null (or absent) means "fits any reason".
  @IsOptional()
  @IsIn(REASON_CODES)
  reasonCode?: ReasonCode | null;

  // Null (or absent) means "fits any action".
  @IsOptional()
  @IsIn(MOD_ACTION_CODES)
  actionCode?: ModActionCode | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
