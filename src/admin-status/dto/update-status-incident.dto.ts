import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  StatusIncidentSeverity,
  StatusIncidentStatus,
} from '../../status/entities/status-incident.entity';
import { STATUS_COMPONENT_IDS } from '../../status/status-components';

/**
 * `PATCH /admin/status/incidents/:id` body — a partial update, so every field
 * is optional and an omitted field is left alone (never nulled).
 *
 * Setting `status` to `resolved` here does the same thing the dedicated resolve
 * route does, including stamping `resolvedAt`; moving it back off `resolved`
 * clears that stamp, so a prematurely closed incident reopens cleanly.
 */
export class UpdateStatusIncidentDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(STATUS_COMPONENT_IDS.length)
  @IsIn(STATUS_COMPONENT_IDS, { each: true })
  affectedComponents?: string[];

  @IsOptional()
  @IsEnum(StatusIncidentSeverity)
  severity?: StatusIncidentSeverity;

  @IsOptional()
  @IsEnum(StatusIncidentStatus)
  status?: StatusIncidentStatus;

  @IsOptional()
  @IsISO8601()
  startedAt?: string;
}
