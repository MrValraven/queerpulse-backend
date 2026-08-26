import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CommunityGovernanceLog,
  GovernanceLogAction,
} from '../communities/entities/community-governance-log.entity';
import { MOD_ACTION_CODES } from '../moderation/dto/mod-action.dto';
import { Appeal, AppealStatus } from '../moderation/entities/appeal.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Report } from '../reports/entities/report.entity';
import { TransparencyPeriodSelector } from './dto/transparency-report.query';
import {
  TransparencyPeriod,
  currentPeriod,
  previousPeriod,
  toPeriodDTO,
} from './transparency-period';
import {
  MIN_DECIDED_APPEALS_FOR_RATE,
  MIN_SAMPLE_FOR_MEDIAN,
  MIN_SAMPLE_FOR_P90,
  SMALL_COUNT_FLOOR,
  TRANSPARENCY_REASON_CATEGORIES,
  TransparencyBreakdownRowDTO,
  TransparencyReasonCategory,
  TransparencyReportDTO,
  categoryForReasonCode,
  roundHours,
  suppressBreakdown,
  suppressCount,
} from './transparency-response';

const SECONDS_PER_HOUR = 3600;

/** The outcome buckets an appeal filed in the period can be in, in render
 *  order. Every `AppealStatus` value is covered, so the three always sum to
 *  the appeals filed. */
const APPEAL_OUTCOME_KEYS = ['upheld', 'overturned', 'awaiting'] as const;
type AppealOutcomeKey = (typeof APPEAL_OUTCOME_KEYS)[number];

const OUTCOME_BY_APPEAL_STATUS: Record<AppealStatus, AppealOutcomeKey> = {
  [AppealStatus.Upheld]: 'upheld',
  [AppealStatus.Overturned]: 'overturned',
  [AppealStatus.Awaiting]: 'awaiting',
};

interface GroupedCountRow {
  groupKey: string | null;
  rowCount: string;
}

interface ResolutionStatsRow {
  sampleSize: string;
  medianSeconds: string | null;
  p90Seconds: string | null;
}

/**
 * The read model behind the public Transparency Report
 * (`/about/governance/transparency`).
 *
 * Article VI clause 3 of the Constitution says the collective's accounts are
 * published "as part of the Transparency Report". Until this module existed,
 * that document did not, and the Constitution's own appeal-overturn figure was
 * a sentence in a translation catalogue with nothing behind it. Every figure
 * here is counted from the same tables the moderation queue and the admin
 * dashboards read, at request time, so the published report and the internal
 * one cannot drift apart.
 *
 * ## The privacy contract
 *
 * This service is reachable by anyone on the internet with no session. It
 * therefore reads only what it can turn into a count or a duration, and it
 * never loads a row it could leak. Every query below is a `GROUP BY` or an
 * aggregate: no query in this file selects an id, a name, a note, a reason
 * detail, or an individual timestamp, so there is no per-member value in
 * memory to leak by accident. `transparency-response.ts` documents, field by
 * field, why each published number is safe, and owns the small-count
 * suppression that keeps a count of one from being a person.
 *
 * ## What is deliberately not counted
 *
 * Nothing here estimates. A figure the tables cannot answer honestly is
 * omitted or published as null with the page saying why, rather than filled in:
 *
 *  - Appeal outcomes are attributed to the period the appeal was FILED in,
 *    not the period it was decided in. `appeals` records no decision
 *    timestamp, so a decided-in-period count would have to be reconstructed
 *    from `mod_audit_logs`, which only carries an `appeal_upheld` /
 *    `appeal_overturned` row when the appeal is linked to a report. Cold
 *    appeals would vanish from the denominator and quietly inflate the
 *    overturn rate. Filing date is recorded for every appeal without
 *    exception, so it is the axis that counts all of them.
 *  - Community-level moderation (a community's own owners removing or barring
 *    a member) is not in `actions.byType`. Those rows live in
 *    `community_governance_log`, not `mod_audit_logs`, and merging the two
 *    would present a room's own housekeeping as a platform enforcement
 *    action.
 *  - There is no "reports upheld / dismissed" split beyond the action
 *    breakdown, because `dismiss` is the only action that unambiguously means
 *    "no rule was broken" and it is already published by name.
 *  - The action breakdown is filtered to the action vocabulary the platform
 *    CURRENTLY offers (`MOD_ACTION_CODES`), so a retired code drops out of the
 *    table rather than lingering. The one retired code, `shield` (TS-02), was
 *    selectable in the moderator drawer and implemented nowhere: the report
 *    closed and nothing happened to anyone. Counting those rows under "what
 *    moderators did" would credit the team with an action that never landed.
 */
@Injectable()
export class TransparencyService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    @InjectRepository(Appeal) private readonly appeals: Repository<Appeal>,
    @InjectRepository(CommunityGovernanceLog)
    private readonly governanceLogs: Repository<CommunityGovernanceLog>,
  ) {}

  async getReport(
    selector: TransparencyPeriodSelector = 'current',
  ): Promise<TransparencyReportDTO> {
    const generatedAt = new Date();
    const period =
      selector === 'previous'
        ? previousPeriod(generatedAt)
        : currentPeriod(generatedAt);

    const [
      reportsByReasonCode,
      resolvedReportCount,
      resolutionStats,
      actionRows,
      appealRows,
      frozenCommunityCount,
    ] = await Promise.all([
      this.countReportsByReasonCode(period),
      this.countReportsResolved(period),
      this.loadResolutionStats(period),
      this.countActionsByType(period),
      this.countAppealsByStatus(period),
      this.countCommunitiesFrozen(period),
    ]);

    const receivedCount = reportsByReasonCode.reduce(
      (runningTotal, row) => runningTotal + row.count,
      0,
    );

    const actionsByType = suppressBreakdown(actionRows);
    const bannedRow = actionsByType.find((row) => row.key === 'ban');

    const appealsByOutcome = suppressBreakdown(appealRows);
    const filedCount = appealRows.reduce(
      (runningTotal, row) => runningTotal + row.count,
      0,
    );

    return {
      period: toPeriodDTO(period, generatedAt),
      availablePeriods: [
        {
          selector: 'current',
          ...periodOption(currentPeriod(generatedAt), generatedAt),
        },
        {
          selector: 'previous',
          ...periodOption(previousPeriod(generatedAt), generatedAt),
        },
      ],
      generatedAt: generatedAt.toISOString(),
      smallCountFloor: SMALL_COUNT_FLOOR,
      reports: {
        received: suppressCount(receivedCount),
        resolved: suppressCount(resolvedReportCount),
        byCategory: this.buildCategoryBreakdown(reportsByReasonCode),
        medianHoursToResolution:
          resolutionStats.sampleSize >= MIN_SAMPLE_FOR_MEDIAN
            ? roundHours(resolutionStats.medianHours)
            : null,
        p90HoursToResolution:
          resolutionStats.sampleSize >= MIN_SAMPLE_FOR_P90
            ? roundHours(resolutionStats.p90Hours)
            : null,
      },
      actions: {
        byType: actionsByType,
        // The identical published value, never a second count of the same
        // rows: if the `ban` bucket was withheld this is withheld too.
        accountsRemoved: bannedRow?.count ?? suppressCount(0),
      },
      appeals: {
        filed: suppressCount(filedCount),
        byOutcome: appealsByOutcome,
        overturnRatePercent: overturnRatePercent(appealRows, appealsByOutcome),
      },
      communities: {
        frozen: suppressCount(frozenCommunityCount),
      },
    };
  }

  /** Reports FILED in the period, grouped by their stored reason code. Selects
   *  the code and a count and nothing else. */
  private async countReportsByReasonCode(
    period: TransparencyPeriod,
  ): Promise<{ reasonCode: string; count: number }[]> {
    const rows = await this.reports
      .createQueryBuilder('report')
      .select('report.reasonCode', 'groupKey')
      .addSelect('COUNT(*)', 'rowCount')
      .where('report.createdAt >= :startsAt', { startsAt: period.startsAt })
      .andWhere('report.createdAt < :endsAt', { endsAt: period.endsAt })
      .groupBy('report.reasonCode')
      .getRawMany<GroupedCountRow>();
    return rows.map((row) => ({
      reasonCode: row.groupKey ?? 'other',
      count: Number(row.rowCount),
    }));
  }

  /** Reports CLOSED OUT in the period, by `resolvedAt`. A different set from
   *  the reports filed in it, on purpose. */
  private countReportsResolved(period: TransparencyPeriod): Promise<number> {
    return this.reports
      .createQueryBuilder('report')
      .where('report.resolvedAt >= :startsAt', { startsAt: period.startsAt })
      .andWhere('report.resolvedAt < :endsAt', { endsAt: period.endsAt })
      .getCount();
  }

  /**
   * Median and p90 hours from filing to resolution, over the reports resolved
   * in the period.
   *
   * Computed with Postgres's `percentile_cont` rather than by loading the
   * deltas and sorting them in Node. On a public, uncredentialed endpoint the
   * row count is whatever the quarter happened to produce, and a summary
   * statistic should not need the whole set resident in memory to answer. The
   * database returns three numbers.
   */
  private async loadResolutionStats(period: TransparencyPeriod): Promise<{
    sampleSize: number;
    medianHours: number | null;
    p90Hours: number | null;
  }> {
    const elapsedSeconds = `EXTRACT(EPOCH FROM ("report"."resolved_at" - "report"."created_at"))`;
    const row = await this.reports
      .createQueryBuilder('report')
      .select('COUNT(*)', 'sampleSize')
      .addSelect(
        `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${elapsedSeconds})`,
        'medianSeconds',
      )
      .addSelect(
        `percentile_cont(0.9) WITHIN GROUP (ORDER BY ${elapsedSeconds})`,
        'p90Seconds',
      )
      .where('report.resolvedAt >= :startsAt', { startsAt: period.startsAt })
      .andWhere('report.resolvedAt < :endsAt', { endsAt: period.endsAt })
      .getRawOne<ResolutionStatsRow>();

    if (!row) return { sampleSize: 0, medianHours: null, p90Hours: null };
    return {
      sampleSize: Number(row.sampleSize),
      medianHours: toHours(row.medianSeconds),
      p90Hours: toHours(row.p90Seconds),
    };
  }

  /**
   * Moderator actions recorded in the period, by action type. Filtered to the
   * `MOD_ACTION_CODES` vocabulary, so the role-management and appeal-decision
   * rows that share `mod_audit_logs` never appear here as enforcement.
   */
  private async countActionsByType(
    period: TransparencyPeriod,
  ): Promise<{ key: string; count: number }[]> {
    const rows = await this.auditLogs
      .createQueryBuilder('log')
      .select('log.action', 'groupKey')
      .addSelect('COUNT(*)', 'rowCount')
      .where('log.createdAt >= :startsAt', { startsAt: period.startsAt })
      .andWhere('log.createdAt < :endsAt', { endsAt: period.endsAt })
      .andWhere('log.action IN (:...actions)', {
        actions: [...MOD_ACTION_CODES],
      })
      .groupBy('log.action')
      .getRawMany<GroupedCountRow>();

    const countByAction = new Map(
      rows.map((row) => [row.groupKey ?? '', Number(row.rowCount)]),
    );
    // Every action code is listed even at zero: a reader learns as much from
    // "no accounts were removed this quarter" as from a number, and a bucket
    // that only appears when it is non-empty makes the table's shape itself a
    // signal.
    return MOD_ACTION_CODES.map((action) => ({
      key: action,
      count: countByAction.get(action) ?? 0,
    }));
  }

  /** Appeals FILED in the period, grouped by the outcome they now carry. */
  private async countAppealsByStatus(
    period: TransparencyPeriod,
  ): Promise<{ key: AppealOutcomeKey; count: number }[]> {
    const rows = await this.appeals
      .createQueryBuilder('appeal')
      .select('appeal.status', 'groupKey')
      .addSelect('COUNT(*)', 'rowCount')
      .where('appeal.createdAt >= :startsAt', { startsAt: period.startsAt })
      .andWhere('appeal.createdAt < :endsAt', { endsAt: period.endsAt })
      .groupBy('appeal.status')
      .getRawMany<GroupedCountRow>();

    const countByOutcome = new Map<AppealOutcomeKey, number>();
    for (const row of rows) {
      const outcome = OUTCOME_BY_APPEAL_STATUS[row.groupKey as AppealStatus];
      if (outcome === undefined) continue;
      countByOutcome.set(
        outcome,
        (countByOutcome.get(outcome) ?? 0) + Number(row.rowCount),
      );
    }
    return APPEAL_OUTCOME_KEYS.map((outcome) => ({
      key: outcome,
      count: countByOutcome.get(outcome) ?? 0,
    }));
  }

  /**
   * Communities frozen at least once in the period, counted once each. A
   * community frozen, unfrozen and frozen again is one community that was
   * frozen, and counting the log rows instead would let a single troubled room
   * read as several.
   */
  private async countCommunitiesFrozen(
    period: TransparencyPeriod,
  ): Promise<number> {
    const row = await this.governanceLogs
      .createQueryBuilder('log')
      .select('COUNT(DISTINCT "log"."community_id")', 'rowCount')
      .where('log.action = :action', { action: GovernanceLogAction.Frozen })
      .andWhere('log.createdAt >= :startsAt', { startsAt: period.startsAt })
      .andWhere('log.createdAt < :endsAt', { endsAt: period.endsAt })
      .getRawOne<{ rowCount: string }>();
    return row ? Number(row.rowCount) : 0;
  }

  private buildCategoryBreakdown(
    reportsByReasonCode: { reasonCode: string; count: number }[],
  ): TransparencyBreakdownRowDTO<TransparencyReasonCategory>[] {
    const countByCategory = new Map<TransparencyReasonCategory, number>();
    for (const row of reportsByReasonCode) {
      const category = categoryForReasonCode(row.reasonCode);
      countByCategory.set(
        category,
        (countByCategory.get(category) ?? 0) + row.count,
      );
    }
    return suppressBreakdown(
      TRANSPARENCY_REASON_CATEGORIES.map((category) => ({
        key: category,
        count: countByCategory.get(category) ?? 0,
      })),
    );
  }
}

function periodOption(
  period: TransparencyPeriod,
  generatedAt: Date,
): { id: string; isComplete: boolean } {
  return {
    id: period.id,
    isComplete: generatedAt.getTime() >= period.endsAt.getTime(),
  };
}

function toHours(seconds: string | null): number | null {
  if (seconds === null) return null;
  const parsed = Number(seconds);
  return Number.isFinite(parsed) ? parsed / SECONDS_PER_HOUR : null;
}

/**
 * Overturned as a percentage of decided appeals, or null.
 *
 * Two conditions both have to hold, and they guard different things. The
 * sample floor (`MIN_DECIDED_APPEALS_FOR_RATE`) guards honesty: below it a
 * rate is one decision wide and would be quoted as if it meant something. The
 * suppression check guards the members: if either outcome bucket was withheld
 * for being small, publishing the rate alongside the decided total would hand
 * the withheld count straight back by multiplication.
 */
function overturnRatePercent(
  rawCounts: readonly { key: AppealOutcomeKey; count: number }[],
  publishedOutcomes: readonly TransparencyBreakdownRowDTO<AppealOutcomeKey>[],
): number | null {
  const rawCountFor = (outcome: AppealOutcomeKey) =>
    rawCounts.find((row) => row.key === outcome)?.count ?? 0;
  const isPublished = (outcome: AppealOutcomeKey) =>
    publishedOutcomes.find((row) => row.key === outcome)?.count.isSuppressed ===
    false;

  const decidedCount = rawCountFor('upheld') + rawCountFor('overturned');
  if (decidedCount < MIN_DECIDED_APPEALS_FOR_RATE) return null;
  if (!isPublished('upheld') || !isPublished('overturned')) return null;
  return Math.round((rawCountFor('overturned') / decidedCount) * 100);
}
