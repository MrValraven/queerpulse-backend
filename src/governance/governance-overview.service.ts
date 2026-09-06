import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { toStoredPlainText } from '../communities/community-plain-text';
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
  OverviewAuthoredText,
  OverviewCouncilSeat,
  OverviewDecision,
  OverviewHealthStat,
  OverviewPrinciple,
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

/**
 * PRD-265. Sanitise one authored EN/PT pair for STORAGE.
 *
 * The write boundary is the only place this happens, per this repo's rule and
 * the `sanitizeArticleHtml` / `toStoredPlainText` precedent: a value that
 * reaches a public page is cleaned once, where it is persisted, never stripped
 * again at each render site. That matters more than usual here, because the
 * governance overview is read by an unauthenticated public page and its
 * authored text is the one part of that page a human types.
 *
 * These fields are not rich text at all — a decision reads as a sentence — so
 * the allowlist `toStoredPlainText` applies is empty: every tag is discarded
 * and only its text survives, entity-encoded markup included.
 *
 * A field that strips to nothing is a 400, not an empty string quietly saved:
 * a blank line on the platform's accountability record is worse than a refused
 * save, and the editor is right there to fix it.
 */
function toStoredAuthoredText(
  text: OverviewAuthoredText,
  fieldName: string,
): OverviewAuthoredText {
  const en = toStoredPlainText(text.en);
  const pt = toStoredPlainText(text.pt);
  if (!en.length || !pt.length) {
    throw new BadRequestException(
      `${fieldName} needs real text in both English and Portuguese.`,
    );
  }
  return { en, pt };
}

/** The same, for a field that is only present on an authored entry. */
function toStoredAuthoredTextOrUndefined(
  text: OverviewAuthoredText | undefined,
  fieldName: string,
): OverviewAuthoredText | undefined {
  return text === undefined ? undefined : toStoredAuthoredText(text, fieldName);
}

/**
 * PRD-265. Normalise one submitted section for storage: authored prose is
 * sanitised, seeded entries pass through untouched, and the absent half of the
 * exclusive-or is dropped rather than persisted as `undefined` (jsonb would
 * keep the key with a null, and every reader would then have to tell "authored
 * but empty" from "seeded").
 *
 * The DTO has already guaranteed the exclusive-or and the length caps, so these
 * three only have to clean what is there.
 */
function toStoredDecisions(decisions: OverviewDecision[]): OverviewDecision[] {
  return decisions.map((decision) =>
    decision.key !== undefined
      ? { key: decision.key }
      : {
          lead: toStoredAuthoredTextOrUndefined(
            decision.lead,
            'A decision lead',
          ),
          body: toStoredAuthoredTextOrUndefined(
            decision.body,
            'A decision body',
          ),
        },
  );
}

function toStoredPrinciples(
  principles: OverviewPrinciple[],
): OverviewPrinciple[] {
  return principles.map((principle) =>
    principle.key !== undefined
      ? { key: principle.key, icon: principle.icon }
      : {
          title: toStoredAuthoredTextOrUndefined(
            principle.title,
            'A principle title',
          ),
          text: toStoredAuthoredTextOrUndefined(
            principle.text,
            'A principle description',
          ),
          icon: principle.icon,
        },
  );
}

function toStoredCouncil(
  council: OverviewCouncilSeat[],
): OverviewCouncilSeat[] {
  return council.map((seat) => {
    // `name` and `initials` are typed by the same editor into the same public
    // page, so they get the same strip. They are not part of the
    // seeded/authored exclusive-or: every seat has them.
    const name = toStoredPlainText(seat.name);
    const initials = toStoredPlainText(seat.initials);
    return seat.roleKey !== undefined
      ? { name, initials, roleKey: seat.roleKey, tint: seat.tint }
      : {
          name,
          initials,
          role: toStoredAuthoredTextOrUndefined(seat.role, 'A council role'),
          tint: seat.tint,
        };
  });
}

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
      // PRD-265. The three sections that accept authored prose are normalised
      // BEFORE the diff, not after: the audit row must record what was
      // actually stored, or the history would show markup that the page never
      // held. `recordIfChanged` then compares stored-shape to stored-shape, so
      // re-saving text that only differed by a stripped tag writes no history.
      if (dto.council !== undefined) {
        const council = toStoredCouncil(dto.council);
        recordIfChanged(OverviewSection.Council, overview.council, council);
        overview.council = council;
      }
      if (dto.principles !== undefined) {
        const principles = toStoredPrinciples(dto.principles);
        recordIfChanged(
          OverviewSection.Principles,
          overview.principles,
          principles,
        );
        overview.principles = principles;
      }
      if (dto.decisions !== undefined) {
        const decisions = toStoredDecisions(dto.decisions);
        recordIfChanged(
          OverviewSection.Decisions,
          overview.decisions,
          decisions,
        );
        overview.decisions = decisions;
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
