import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Not, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminFinanceChangeDTO,
  toAdminFinanceChange,
} from './admin-finance-changes';
import {
  FinanceAuditEntry,
  applyLedgerEdits,
  replaceEventNotes,
  replacePartners,
  replaceReserve,
  replaceStats,
} from './admin-finance-edits';
import {
  AdminFinanceResponseDTO,
  toAdminFinanceHistory,
  toAdminFinanceLatest,
} from './admin-finance-response';
import { OpenFinanceQuarterDto } from './dto/open-finance-quarter.dto';
import { UpdateAdminFinancesDto } from './dto/update-admin-finances.dto';
import {
  GovernanceFinanceResponseDTO,
  isEnteredByPeople,
  toEmptyGovernanceFinanceResponse,
  toGovernanceFinanceResponse,
} from './governance-finance-response';
import { GovernanceFinanceChange } from './entities/governance-finance-change.entity';
import {
  FinanceMetricSource,
  GovernanceFinanceReport,
} from './entities/governance-finance-report.entity';

/** The editable scalar metrics, each paired with its provenance column. Drives
 *  the update loop and keeps the value/source columns in lockstep. */
const SCALAR_FIELDS = [
  { key: 'mrr', sourceKey: 'mrrSource' },
  { key: 'sustainerCount', sourceKey: 'sustainerCountSource' },
  { key: 'solidarityRate', sourceKey: 'solidarityRateSource' },
  { key: 'incomeTotal', sourceKey: 'incomeTotalSource' },
  { key: 'expenseTotal', sourceKey: 'expenseTotalSource' },
] as const;

/**
 * PRD-447. The public endpoint only ever reads a report whose five headline
 * figures were all entered by people (the SQL twin of `isEnteredByPeople`).
 * A seeded or half-entered report stays on the admin tab.
 */
const ENTERED_BY_PEOPLE_WHERE = {
  mrrSource: Not(FinanceMetricSource.Seeded),
  sustainerCountSource: Not(FinanceMetricSource.Seeded),
  solidarityRateSource: Not(FinanceMetricSource.Seeded),
  incomeTotalSource: Not(FinanceMetricSource.Seeded),
  expenseTotalSource: Not(FinanceMetricSource.Seeded),
};

@Injectable()
export class GovernanceFinanceService {
  constructor(
    @InjectRepository(GovernanceFinanceReport)
    private readonly reports: Repository<GovernanceFinanceReport>,
    @InjectRepository(GovernanceFinanceChange)
    private readonly changes: Repository<GovernanceFinanceChange>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
  ) {}

  // A specific `quarter` fetches that snapshot exactly (404 when it is
  // missing or not yet public); omitted fetches the most recently published
  // public one. With no public report at all, the latest read answers with
  // the empty response (`quarter: null`), which the Governance page renders
  // as "nothing published yet" (PRD-447).
  async getFinances(quarter?: string): Promise<GovernanceFinanceResponseDTO> {
    if (quarter) {
      const report = await this.reports.findOne({
        where: { quarter, ...ENTERED_BY_PEOPLE_WHERE },
      });
      if (!report) {
        throw new NotFoundException('Governance finance report not found');
      }
      return toGovernanceFinanceResponse(report);
    }

    // `find` with `take: 1`: the "latest" read has no keyed lookup, and the
    // repo's convention keeps `findOne` for keyed reads.
    const [latest] = await this.reports.find({
      where: ENTERED_BY_PEOPLE_WHERE,
      order: { publishedAt: 'DESC' },
      take: 1,
    });
    return latest
      ? toGovernanceFinanceResponse(latest)
      : toEmptyGovernanceFinanceResponse();
  }

  /**
   * PRD-447. Opens an empty report for the next quarter, so the governance
   * team can enter real figures with no SQL. Every headline figure starts
   * unentered (`seeded` provenance, null value), which keeps the report off
   * the public page until each one is typed in.
   *
   * The quarter must sort after every existing one: the tab always edits the
   * newest report, and opening an older quarter would silently take its
   * place. The newest report must also be public first: the tab only edits
   * the newest one, so opening past an unfinished quarter would strand it.
   */
  async openQuarter(
    dto: OpenFinanceQuarterDto,
    actorId: string,
  ): Promise<AdminFinanceResponseDTO> {
    try {
      await this.insertQuarter(dto, actorId);
    } catch (error) {
      // Two admins opening the same quarter at once: both pass the lookup
      // below and one loses on the unique index. Same answer as the lookup.
      if (isUniqueViolation(error, 'UQ_governance_finance_report_quarter')) {
        throw new ConflictException(
          `A finance report for ${dto.quarter} already exists`,
        );
      }
      throw error;
    }
    return this.getAdminFinances();
  }

  private async insertQuarter(
    dto: OpenFinanceQuarterDto,
    actorId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(GovernanceFinanceReport, {
        where: { quarter: dto.quarter },
      });
      if (existing) {
        throw new ConflictException(
          `A finance report for ${dto.quarter} already exists`,
        );
      }
      const [newest] = await manager.find(GovernanceFinanceReport, {
        order: { quarter: 'DESC' },
        take: 1,
      });
      if (newest && newest.quarter.localeCompare(dto.quarter) > 0) {
        throw new BadRequestException(
          `Open a quarter after ${newest.quarter}, the newest report`,
        );
      }
      if (newest && !isEnteredByPeople(newest)) {
        throw new ConflictException(
          `Enter every headline figure for ${newest.quarter} before opening the next quarter`,
        );
      }

      await manager.save(
        manager.create(GovernanceFinanceReport, {
          quarter: dto.quarter,
          stats: [],
          income: [],
          expense: [],
          eventNotes: [],
          reserve: null,
          partners: null,
          publishedAt: new Date(),
        }),
      );
      await this.saveAudit(manager, actorId, null, [
        { field: 'quarter', oldValue: null, newValue: dto.quarter },
      ]);
    });
  }

  // Admin governance Finances tab: the latest quarter's full metrics + ledgers
  // plus a historical series (all published quarters, oldest first) for the
  // trend chart. Unlike `getFinances`, this never 404s — an empty table simply
  // renders an empty state on the admin tab.
  async getAdminFinances(): Promise<AdminFinanceResponseDTO> {
    const reports = await this.reports.find({ order: { publishedAt: 'DESC' } });
    if (reports.length === 0) return { latest: null, history: [] };
    // invariant: length > 0 checked above, so index 0 exists.
    const latestReport = reports[0]!;
    const historyAscending = [...reports].sort((firstReport, secondReport) =>
      firstReport.quarter.localeCompare(secondReport.quarter),
    );
    const editor = await this.resolveMember(latestReport.metricsEditedBy);
    return {
      latest: toAdminFinanceLatest(latestReport, editor),
      history: toAdminFinanceHistory(historyAscending),
    };
  }

  /**
   * Corrects the editable figures on the latest published report and records
   * one audit row per *changed* field, all inside one transaction. Fields
   * absent from the DTO, and fields whose submitted value equals the stored
   * value, are neither written nor audited — saving the form untouched
   * produces no history and does not stamp an editor.
   *
   * Editing a figure flips its provenance to `manual` and stamps
   * `metricsEditedBy`/`At`. `surplus` is never edited directly: whenever either
   * total changes it is recomputed from `incomeTotal - expenseTotal` (its
   * provenance stays the constant `computed`).
   */
  async updateAdminFinances(
    dto: UpdateAdminFinancesDto,
    actorId: string,
  ): Promise<AdminFinanceResponseDTO> {
    await this.dataSource.transaction(async (manager) => {
      const [report] = await manager.find(GovernanceFinanceReport, {
        order: { publishedAt: 'DESC' },
        take: 1,
      });
      if (!report) {
        throw new NotFoundException('No governance finance report to edit');
      }

      const auditRows: GovernanceFinanceChange[] = [];
      let changed = false;

      for (const field of SCALAR_FIELDS) {
        const submitted = dto[field.key];
        if (submitted === undefined) continue;
        const previous = report[field.key];
        // A still-seeded figure submitted unchanged is a person confirming
        // it (PRD-447): it flips to `manual` and is audited like any edit.
        // Only an already-entered figure resubmitted as-is is skipped.
        if (
          previous === submitted &&
          report[field.sourceKey] !== FinanceMetricSource.Seeded
        ) {
          continue;
        }
        auditRows.push(
          manager.create(GovernanceFinanceChange, {
            actorId,
            field: field.key,
            oldValue: previous === null ? null : String(previous),
            newValue: String(submitted),
            note: dto.note ?? null,
          }),
        );
        report[field.key] = submitted;
        report[field.sourceKey] = FinanceMetricSource.Manual;
        changed = true;
      }

      const auditEntries: FinanceAuditEntry[] = [];
      const take = <Value>(result: {
        value: Value;
        audit: FinanceAuditEntry[];
        isChanged: boolean;
      }): Value => {
        auditEntries.push(...result.audit);
        if (result.isChanged) changed = true;
        return result.value;
      };

      report.income = take(
        applyLedgerEdits('income', report.income ?? [], dto.income),
      );
      report.expense = take(
        applyLedgerEdits('expense', report.expense ?? [], dto.expense),
      );
      // PRD-447: the report's prose and disclosures, which used to need SQL.
      if (dto.stats !== undefined) {
        report.stats = take(replaceStats(report.stats ?? [], dto.stats));
      }
      if (dto.eventNotes !== undefined) {
        report.eventNotes = take(
          replaceEventNotes(report.eventNotes ?? [], dto.eventNotes),
        );
      }
      if (dto.partners !== undefined) {
        report.partners = take(replacePartners(report.partners, dto.partners));
      }
      if (dto.reserve !== undefined) {
        report.reserve = take(replaceReserve(report.reserve, dto.reserve));
      }

      // Surplus is derived, never edited: keep the stored value consistent
      // whenever a total moved.
      if (dto.incomeTotal !== undefined || dto.expenseTotal !== undefined) {
        report.surplus = (report.incomeTotal ?? 0) - (report.expenseTotal ?? 0);
      }

      if (!changed) return;

      report.metricsEditedBy = actorId;
      report.metricsEditedAt = new Date();
      await manager.save(report);
      if (auditRows.length > 0) await manager.save(auditRows);
      await this.saveAudit(manager, actorId, dto.note ?? null, auditEntries);
    });

    return this.getAdminFinances();
  }

  /** Writes one `governance_finance_changes` row per entry, inside the
   *  caller's transaction. */
  private async saveAudit(
    manager: EntityManager,
    actorId: string,
    note: string | null,
    entries: FinanceAuditEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await manager.save(
      entries.map((entry) =>
        manager.create(GovernanceFinanceChange, {
          actorId,
          field: entry.field,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
          note,
        }),
      ),
    );
  }

  /** The per-field audit trail, newest first, each row enriched with its
   *  actor's display ref. */
  async listChanges(
    limit: number,
    offset: number,
  ): Promise<AdminFinanceChangeDTO[]> {
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
      toAdminFinanceChange(
        row,
        row.actorId ? (actors.get(row.actorId) ?? null) : null,
      ),
    );
  }

  /** Resolve a single editor userId to a display ref, or null. */
  private async resolveMember(
    userId: string | null,
  ): Promise<MemberRef | null> {
    if (!userId) return null;
    const map = await new MemberLookup(this.profiles).byUserIds([userId]);
    return map.get(userId) ?? null;
  }
}
