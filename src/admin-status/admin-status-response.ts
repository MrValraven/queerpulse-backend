import { ApiProperty } from '@nestjs/swagger';
import {
  StatusIncident,
  StatusIncidentSeverity,
  StatusIncidentStatus,
} from '../status/entities/status-incident.entity';
import { STATUS_COMPONENT_IDS } from '../status/status-components';

/**
 * The staff view of an incident. Hand-mapped, like every other response in this
 * repo (there is no global serializer), and a strict superset of the public
 * `StatusIncidentDto`: it adds who wrote the row and when it was created, both
 * of which are withheld from the public page on purpose.
 *
 * Unknown component ids are NOT filtered here, unlike the public mapper: an
 * operator editing an old incident needs to see the stale id in order to fix it.
 */
export class AdminStatusIncidentDTO {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ enum: STATUS_COMPONENT_IDS, isArray: true })
  affectedComponents!: string[];

  @ApiProperty({ enum: StatusIncidentSeverity })
  severity!: StatusIncidentSeverity;

  @ApiProperty({ enum: StatusIncidentStatus })
  status!: StatusIncidentStatus;

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({
    description:
      'Display name snapshotted at write time, so it survives the author ' +
      'erasing their account.',
  })
  authoredByLabel!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export function toAdminStatusIncidentDTO(
  incident: StatusIncident,
): AdminStatusIncidentDTO {
  return {
    id: incident.id,
    title: incident.title,
    body: incident.body,
    affectedComponents: incident.affectedComponents ?? [],
    severity: incident.severity,
    status: incident.status,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
    authoredByLabel: incident.authoredByLabel,
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
  };
}
