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
 * `POST /admin/status/incidents` body.
 *
 * `affectedComponents` is validated against the component registry rather than
 * accepted as free text: an unknown id would be silently dropped by the public
 * read, so an operator who mistypes one would publish an incident that appears
 * to affect nothing. Better to 400 at the desk than to mislead on the page.
 */
export class CreateStatusIncidentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

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

  /** When the trouble began. Defaults to now, which is rarely right. */
  @IsOptional()
  @IsISO8601()
  startedAt?: string;
}
