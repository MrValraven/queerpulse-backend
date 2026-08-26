import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toStoredPlainText } from '../communities/community-plain-text';
import {
  StatusIncident,
  StatusIncidentSeverity,
  StatusIncidentStatus,
} from '../status/entities/status-incident.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminStatusIncidentDTO,
  toAdminStatusIncidentDTO,
} from './admin-status-response';
import { CreateStatusIncidentDto } from './dto/create-status-incident.dto';
import { UpdateStatusIncidentDto } from './dto/update-status-incident.dto';

/** Newest first, capped: the authoring pane is a desk, not an archive. */
const ADMIN_INCIDENT_LIMIT = 100;

/** Used when the author has no profile row (a system or freshly seeded staff account). */
const UNKNOWN_AUTHOR_LABEL = 'Unknown';

@Injectable()
export class AdminStatusIncidentsService {
  constructor(
    @InjectRepository(StatusIncident)
    private readonly incidents: Repository<StatusIncident>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  async list(): Promise<AdminStatusIncidentDTO[]> {
    const rows = await this.incidents.find({
      order: { startedAt: 'DESC' },
      take: ADMIN_INCIDENT_LIMIT,
    });
    return rows.map(toAdminStatusIncidentDTO);
  }

  async create(
    actorUserId: string,
    dto: CreateStatusIncidentDto,
  ): Promise<AdminStatusIncidentDTO> {
    const status = dto.status ?? StatusIncidentStatus.Open;
    const incident = this.incidents.create({
      // Stripped once, here at the write boundary, rather than at every render
      // site: this text is shown verbatim to unauthenticated visitors, and a
      // crafted API call bypasses whatever the admin pane does on the way in.
      title: toStoredPlainText(dto.title),
      body: toStoredPlainText(dto.body),
      affectedComponents: dto.affectedComponents ?? [],
      severity: dto.severity ?? StatusIncidentSeverity.Minor,
      status,
      startedAt: dto.startedAt ? new Date(dto.startedAt) : new Date(),
      resolvedAt: status === StatusIncidentStatus.Resolved ? new Date() : null,
      authoredByUserId: actorUserId,
      authoredByLabel: await this.labelFor(actorUserId),
    });
    return toAdminStatusIncidentDTO(await this.incidents.save(incident));
  }

  async update(
    id: string,
    dto: UpdateStatusIncidentDto,
  ): Promise<AdminStatusIncidentDTO> {
    const incident = await this.requireIncident(id);

    if (dto.title !== undefined) incident.title = toStoredPlainText(dto.title);
    if (dto.body !== undefined) incident.body = toStoredPlainText(dto.body);
    if (dto.affectedComponents !== undefined) {
      incident.affectedComponents = dto.affectedComponents;
    }
    if (dto.severity !== undefined) incident.severity = dto.severity;
    if (dto.startedAt !== undefined) {
      incident.startedAt = new Date(dto.startedAt);
    }
    if (dto.status !== undefined) this.applyStatus(incident, dto.status);

    return toAdminStatusIncidentDTO(await this.incidents.save(incident));
  }

  /**
   * The one-click close. Idempotent: resolving an already-resolved incident
   * keeps the original `resolvedAt` rather than moving the timestamp, so a
   * double click cannot rewrite when the trouble ended.
   */
  async resolve(id: string): Promise<AdminStatusIncidentDTO> {
    const incident = await this.requireIncident(id);
    this.applyStatus(incident, StatusIncidentStatus.Resolved);
    return toAdminStatusIncidentDTO(await this.incidents.save(incident));
  }

  /**
   * `resolvedAt` is derived from `status` in one place, so the two can never
   * disagree: a resolved incident always carries a timestamp, and one moved
   * back to open/monitoring always loses it.
   */
  private applyStatus(
    incident: StatusIncident,
    status: StatusIncidentStatus,
  ): void {
    incident.status = status;
    if (status === StatusIncidentStatus.Resolved) {
      incident.resolvedAt = incident.resolvedAt ?? new Date();
    } else {
      incident.resolvedAt = null;
    }
  }

  private async requireIncident(id: string): Promise<StatusIncident> {
    const incident = await this.incidents.findOne({ where: { id } });
    if (!incident) throw new NotFoundException('Incident not found');
    return incident;
  }

  private async labelFor(userId: string): Promise<string> {
    const profile = await this.profiles.findOne({
      where: { userId },
      select: { userId: true, firstName: true, lastName: true },
    });
    if (!profile) return UNKNOWN_AUTHOR_LABEL;
    // Never the email: this label is a snapshot kept for years, and an address
    // is not what a colleague reading the desk needs.
    return (
      `${profile.firstName} ${profile.lastName}`.trim() || UNKNOWN_AUTHOR_LABEL
    );
  }
}
