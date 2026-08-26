import { ApiProperty } from '@nestjs/swagger';
import {
  StatusIncidentSeverity,
  StatusIncidentStatus,
} from '../entities/status-incident.entity';
import {
  STATUS_COMPONENT_IDS,
  STATUS_STATES,
  type StatusComponentId,
  type StatusState,
} from '../status-components';

/**
 * The public shape of `GET /status`. Hand-mapped from the entity and the probe
 * outcomes (this repo runs no global serializer), and the mapping is
 * deliberately lossy: nothing here can carry a stack trace, a hostname, a
 * connection string, a build/commit, a query timing, or the identity of whoever
 * wrote the incident up.
 */

export class StatusComponentDto {
  @ApiProperty({
    enum: STATUS_COMPONENT_IDS,
    description:
      'Stable component id. Display text is the caller’s to resolve; ' +
      'the frontend translates these.',
  })
  id!: StatusComponentId;

  @ApiProperty({ enum: STATUS_STATES })
  state!: StatusState;
}

export class StatusIncidentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Operator-authored, plain text.' })
  title!: string;

  @ApiProperty({ description: 'Operator-authored, plain text.' })
  body!: string;

  @ApiProperty({ enum: StatusIncidentSeverity })
  severity!: StatusIncidentSeverity;

  @ApiProperty({ enum: StatusIncidentStatus })
  status!: StatusIncidentStatus;

  @ApiProperty({
    enum: STATUS_COMPONENT_IDS,
    isArray: true,
    description: 'Known component ids only; unrecognised ids are dropped.',
  })
  affectedComponents!: StatusComponentId[];

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class PublicStatusDto {
  @ApiProperty({
    enum: STATUS_STATES,
    description: 'The worst state across every component.',
  })
  overall!: StatusState;

  @ApiProperty({ type: [StatusComponentDto] })
  components!: StatusComponentDto[];

  @ApiProperty({
    type: [StatusIncidentDto],
    description:
      'Everything unresolved, plus recently resolved incidents, newest first.',
  })
  incidents!: StatusIncidentDto[];

  @ApiProperty({
    description:
      'True when the incident list could not be read (typically because the ' +
      'database is the thing that is down). The page says so rather than ' +
      'implying nobody has written anything up.',
  })
  isIncidentHistoryUnavailable!: boolean;

  @ApiProperty({
    format: 'date-time',
    description:
      'When these probe results were taken. Can trail the request by up to ' +
      'the in-process cache window.',
  })
  checkedAt!: string;
}
