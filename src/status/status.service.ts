import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Not, Repository } from 'typeorm';
import {
  DATABASE_PROBE_KEY,
  PlatformProbesService,
  type PlatformProbeKey,
  type PlatformProbeOutcome,
} from '../health/platform-probes.service';
import {
  StatusIncident,
  StatusIncidentSeverity,
  StatusIncidentStatus,
} from './entities/status-incident.entity';
import {
  STATUS_COMPONENT_DEPENDENCIES,
  STATUS_COMPONENT_IDS,
  isStatusComponentId,
  worstState,
  type StatusComponentId,
  type StatusState,
} from './status-components';
import {
  PublicStatusDto,
  StatusComponentDto,
  StatusIncidentDto,
} from './dto/public-status.dto';
import { STATUS_MEMO_TTL_MS } from './status.cache';

/** Resolved incidents stay on the page this long, then drop off. */
const RESOLVED_WINDOW_DAYS = 30;

/** Hard ceiling on the public list, so one noisy month cannot bloat the page. */
const PUBLIC_INCIDENT_LIMIT = 20;

/** How an unresolved incident's severity degrades the components it names. */
const SEVERITY_IMPACT: Record<StatusIncidentSeverity, StatusState> = {
  [StatusIncidentSeverity.Minor]: 'degraded',
  [StatusIncidentSeverity.Major]: 'degraded',
  [StatusIncidentSeverity.Critical]: 'down',
};

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);

  /**
   * One memoised payload, reused for `STATUS_MEMO_TTL_MS`. Deliberately a plain
   * field rather than a cache module: this endpoint has to keep working when
   * the platform's dependencies do not, and an in-process object depends on
   * nothing.
   */
  private memo: { payload: PublicStatusDto; expiresAt: number } | null = null;

  constructor(
    private readonly probes: PlatformProbesService,
    @InjectRepository(StatusIncident)
    private readonly incidents: Repository<StatusIncident>,
  ) {}

  async getPublicStatus(): Promise<PublicStatusDto> {
    const now = Date.now();
    if (this.memo && this.memo.expiresAt > now) return this.memo.payload;

    const payload = await this.buildPublicStatus();
    this.memo = { payload, expiresAt: Date.now() + STATUS_MEMO_TTL_MS };
    return payload;
  }

  /**
   * NEVER REJECTS. Every step is individually guarded, because the one request
   * this endpoint must answer correctly is the one made while the platform is
   * broken. A failure to probe reads as "unreachable"; a failure to read the
   * incident table reads as "history unavailable"; neither turns into a 500 on
   * the page whose entire job is to explain the 500s elsewhere.
   */
  private async buildPublicStatus(): Promise<PublicStatusDto> {
    const outcomes = await this.probes.probeDependencies();
    const reachable = new Map<PlatformProbeKey, boolean>(
      outcomes.map((outcome: PlatformProbeOutcome) => [
        outcome.key,
        outcome.isReachable,
      ]),
    );
    const isDatabaseReachable = reachable.get(DATABASE_PROBE_KEY) === true;

    const incidents = isDatabaseReachable ? await this.readIncidents() : null;

    const components = this.deriveComponents(reachable, incidents ?? []);

    return {
      overall: worstState(components.map((component) => component.state)),
      components,
      incidents: (incidents ?? []).map((incident) =>
        this.toIncidentDto(incident),
      ),
      // A database that will not answer a ping will not answer this table
      // either, so say the history is missing instead of rendering an empty
      // list that reads as "nothing is wrong".
      isIncidentHistoryUnavailable: incidents === null,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Returns `null` when the read failed, which the caller reports honestly. */
  private async readIncidents(): Promise<StatusIncident[] | null> {
    const resolvedSince = new Date(
      Date.now() - RESOLVED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    try {
      return await this.incidents.find({
        where: [
          { status: Not(StatusIncidentStatus.Resolved) },
          {
            status: StatusIncidentStatus.Resolved,
            resolvedAt: MoreThanOrEqual(resolvedSince),
          },
        ],
        order: { startedAt: 'DESC' },
        take: PUBLIC_INCIDENT_LIMIT,
      });
    } catch (error) {
      this.logger.warn(
        `Public status could not read incidents: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  /**
   * A component's state is the worse of two things: what the probes it depends
   * on report, and what any unresolved incident naming it declares. Both halves
   * matter — the probes catch a hard outage nobody has written up yet, and the
   * incidents catch everything a `SELECT 1` cannot see.
   */
  private deriveComponents(
    reachable: Map<PlatformProbeKey, boolean>,
    incidents: StatusIncident[],
  ): StatusComponentDto[] {
    const declared = this.declaredStates(incidents);

    return STATUS_COMPONENT_IDS.map((id) => {
      const probed: StatusState = STATUS_COMPONENT_DEPENDENCIES[id].every(
        (key) => reachable.get(key) === true,
      )
        ? 'operational'
        : 'down';
      return {
        id,
        state: worstState([probed, declared.get(id) ?? 'operational']),
      };
    });
  }

  private declaredStates(
    incidents: StatusIncident[],
  ): Map<StatusComponentId, StatusState> {
    const declared = new Map<StatusComponentId, StatusState>();
    for (const incident of incidents) {
      // A resolved incident describes the past and degrades nothing. An
      // incident still being monitored does: a fix nobody trusts yet is not a
      // fix, and saying "operational" while watching it would be a lie of
      // exactly the kind this page exists to avoid.
      if (incident.status === StatusIncidentStatus.Resolved) continue;
      const impact = SEVERITY_IMPACT[incident.severity] ?? 'degraded';
      for (const id of this.knownComponents(incident)) {
        declared.set(
          id,
          worstState([declared.get(id) ?? 'operational', impact]),
        );
      }
    }
    return declared;
  }

  /** Ids the registry still recognises. A stale id is dropped, never rendered. */
  private knownComponents(incident: StatusIncident): StatusComponentId[] {
    return (incident.affectedComponents ?? []).filter(isStatusComponentId);
  }

  private toIncidentDto(incident: StatusIncident): StatusIncidentDto {
    return {
      id: incident.id,
      title: incident.title,
      body: incident.body,
      severity: incident.severity,
      status: incident.status,
      affectedComponents: this.knownComponents(incident),
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt
        ? incident.resolvedAt.toISOString()
        : null,
      updatedAt: incident.updatedAt.toISOString(),
      // Note what is NOT here: `authoredByUserId`, `authoredByLabel` and
      // `createdAt`. An unauthenticated visitor learns what broke and when,
      // never who operates the platform or when they were at their desk.
    };
  }
}
