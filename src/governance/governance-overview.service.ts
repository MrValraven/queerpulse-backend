import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import {
  GovernanceOverviewResponseDTO,
  GovernancePublishResponseDTO,
  toGovernanceOverviewResponse,
} from './governance-overview-response';
import {
  AdminOverviewResponseDTO,
  toAdminOverviewResponse,
} from './admin-overview-response';
import {
  AdminOverviewChangeDTO,
  toAdminOverviewChange,
} from './admin-overview-changes';
import { UpdateAdminOverviewDto } from './dto/update-admin-overview.dto';
import {
  GOVERNANCE_OVERVIEW_ID,
  GovernanceOverview,
  OverviewHealthStat,
} from './entities/governance-overview.entity';
import {
  GovernanceOverviewChange,
  OverviewSection,
} from './entities/governance-overview-change.entity';

// The one `health` stat key that is a real, cheaply queryable number rather
// than admin-typed prose (COM-4) — every read forces its `n` to the live
// active-member count, and it is never persisted as anything else (see
// `withLiveActiveMemberCount`/`updateOverview` below). `AdminGovernanceHealthEditor`
// (frontend) matches this by disabling that one row's value field.
const ACTIVE_MEMBERS_HEALTH_KEY = 'activeMembers';

@Injectable()
export class GovernanceOverviewService {
  constructor(
    @InjectRepository(GovernanceOverview)
    private readonly overview: Repository<GovernanceOverview>,
    @InjectRepository(GovernanceOverviewChange)
    private readonly changes: Repository<GovernanceOverviewChange>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly usersService: UsersService,
    private readonly dataSource: DataSource,
  ) {}

  // Replaces the `activeMembers` row's `n` with the live account-standing
  // count (active, non-suspended members — the same figure
  // `AdminOverviewService`/press-kit already report elsewhere), leaving every
  // other health stat untouched. A no-op if the row isn't present.
  private async withLiveActiveMemberCount(
    health: OverviewHealthStat[],
  ): Promise<OverviewHealthStat[]> {
    if (!health.some((stat) => stat.key === ACTIVE_MEMBERS_HEALTH_KEY)) {
      return health;
    }
    const activeMemberCount = await this.usersService.countActiveMembers();
    return health.map((stat) =>
      stat.key === ACTIVE_MEMBERS_HEALTH_KEY
        ? { ...stat, n: String(activeMemberCount) }
        : stat,
    );
  }

  // The Governance page's non-financial structure (health snapshot, moderation
  // steps, advisory council, principles, decision log). A singleton row keyed
  // on `GOVERNANCE_OVERVIEW_ID` — the lookup carries a `where`, so it never
  // hits the bare-`findOne` "you must provide selection conditions" error.
  async getOverview(): Promise<GovernanceOverviewResponseDTO> {
    const overview = await this.overview.findOne({
      where: { id: GOVERNANCE_OVERVIEW_ID },
    });

    if (!overview) {
      throw new NotFoundException('Governance overview not found');
    }
    overview.health = await this.withLiveActiveMemberCount(overview.health);
    return toGovernanceOverviewResponse(overview);
  }

  // POST /admin/governance/publish (P3-7) — mark the current singleton snapshot
  // as published *now*, so the public `GET /governance/overview` can surface a
  // "last published" line. Idempotent in intent (re-publishing simply advances
  // the timestamp to the latest deliberate act); mirrors the seeded-singleton
  // model — there is exactly one row to stamp.
  async publish(): Promise<GovernancePublishResponseDTO> {
    const overview = await this.overview.findOne({
      where: { id: GOVERNANCE_OVERVIEW_ID },
    });
    if (!overview) {
      throw new NotFoundException('Governance overview not found');
    }
    overview.publishedAt = new Date();
    await this.overview.save(overview);
    return { publishedAt: overview.publishedAt.toISOString() };
  }

  // Admin Policy tab: the singleton plus, per section, who last edited it and
  // when — computed from the newest `governance_overview_changes` row for
  // that section, not a stored column, so editing Council never makes the
  // Health badge look touched.
  async getAdminOverview(): Promise<AdminOverviewResponseDTO> {
    const overview = await this.overview.findOne({
      where: { id: GOVERNANCE_OVERVIEW_ID },
    });
    if (!overview) {
      throw new NotFoundException('Governance overview not found');
    }
    overview.health = await this.withLiveActiveMemberCount(overview.health);

    // `DISTINCT ON (section)` — at most five rows, one per section (BE-COM-36).
    // This used to `find()` the entire `governance_overview_changes` table
    // ordered newest-first and then keep the first row per section in JS, so
    // every Policy-tab load scanned the whole edit history just to find five
    // rows, and the scan grew with every edit ever made.
    //
    // `id DESC` is the tiebreak: two sections saved in the same
    // `updateOverview` transaction share a `created_at` to the microsecond,
    // and without a deterministic second key `DISTINCT ON` would pick
    // arbitrarily between them.
    const latestChanges = await this.changes
      .createQueryBuilder('change')
      .distinctOn(['change.section'])
      .orderBy('change.section', 'ASC')
      .addOrderBy('change.created_at', 'DESC')
      .addOrderBy('change.id', 'DESC')
      .getMany();
    const latestChangeBySection = new Map<
      OverviewSection,
      GovernanceOverviewChange
    >(latestChanges.map((change) => [change.section, change]));

    const actorIds = [
      ...new Set(
        [...latestChangeBySection.values()]
          .map((change) => change.actorId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const editorsByActorId = await new MemberLookup(this.profiles).byUserIds(
      actorIds,
    );

    return toAdminOverviewResponse(
      overview,
      latestChangeBySection,
      editorsByActorId,
    );
  }

  /**
   * Replaces any subset of the five overview sections and records one audit
   * row per section that actually changed, all inside one transaction.
   * Sections absent from the DTO, and sections whose submitted array is
   * deep-equal to the stored one, are neither written nor audited — saving a
   * section untouched produces no history.
   */
  async updateOverview(
    dto: UpdateAdminOverviewDto,
    actorId: string,
  ): Promise<AdminOverviewResponseDTO> {
    await this.dataSource.transaction(async (manager) => {
      const overview = await manager.findOne(GovernanceOverview, {
        where: { id: GOVERNANCE_OVERVIEW_ID },
      });
      if (!overview) {
        throw new NotFoundException('Governance overview not found');
      }

      const auditRows: GovernanceOverviewChange[] = [];
      const recordIfChanged = <T>(
        section: OverviewSection,
        before: T,
        after: T,
      ): boolean => {
        if (JSON.stringify(before) === JSON.stringify(after)) return false;
        auditRows.push(
          manager.create(GovernanceOverviewChange, {
            section,
            actorId,
            before,
            after,
            note: dto.note ?? null,
          }),
        );
        return true;
      };

      if (dto.health !== undefined) {
        // Force the `activeMembers` row's `n` to the live count on BOTH sides
        // of the diff before recording/saving (COM-4) — an admin can no
        // longer hand-type that one figure, and the live count ticking
        // between fetch and save never produces a phantom audit entry for a
        // field nobody actually edited.
        const liveBefore = await this.withLiveActiveMemberCount(
          overview.health,
        );
        const liveAfter = await this.withLiveActiveMemberCount(dto.health);
        recordIfChanged(OverviewSection.Health, liveBefore, liveAfter);
        overview.health = liveAfter;
      }
      if (dto.moderationSteps !== undefined) {
        recordIfChanged(
          OverviewSection.ModerationSteps,
          overview.moderationSteps,
          dto.moderationSteps,
        );
        overview.moderationSteps = dto.moderationSteps;
      }
      if (dto.council !== undefined) {
        recordIfChanged(OverviewSection.Council, overview.council, dto.council);
        overview.council = dto.council;
      }
      if (dto.principles !== undefined) {
        recordIfChanged(
          OverviewSection.Principles,
          overview.principles,
          dto.principles,
        );
        overview.principles = dto.principles;
      }
      if (dto.decisions !== undefined) {
        recordIfChanged(
          OverviewSection.Decisions,
          overview.decisions,
          dto.decisions,
        );
        overview.decisions = dto.decisions;
      }

      if (auditRows.length === 0) return;
      await manager.save(overview);
      await manager.save(auditRows);
    });

    return this.getAdminOverview();
  }

  /** The per-section audit trail, newest first, each row enriched with its
   *  actor's display ref. */
  async listChanges(
    limit: number,
    offset: number,
  ): Promise<AdminOverviewChangeDTO[]> {
    const rows = await this.changes.find({
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    const actorIds = [
      ...new Set(
        rows
          .map((row) => row.actorId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const actors = await new MemberLookup(this.profiles).byUserIds(actorIds);
    return rows.map((row) =>
      toAdminOverviewChange(
        row,
        row.actorId ? (actors.get(row.actorId) ?? null) : null,
      ),
    );
  }
}
