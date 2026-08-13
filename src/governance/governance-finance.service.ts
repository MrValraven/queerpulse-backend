import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminFinanceChangeDTO,
  toAdminFinanceChange,
} from './admin-finance-changes';
import {
  AdminFinanceResponseDTO,
  toAdminFinanceHistory,
  toAdminFinanceLatest,
} from './admin-finance-response';
import { UpdateAdminFinancesDto } from './dto/update-admin-finances.dto';
import {
  GovernanceFinanceResponseDTO,
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

  // A specific `quarter` fetches that snapshot exactly; omitted fetches the
  // most recently published one (the "Q2 2026 · Financial transparency"
  // section always shows the latest quarter by default).
  async getFinances(quarter?: string): Promise<GovernanceFinanceResponseDTO> {
    // A specific `quarter` is a keyed lookup (`findOne` with a `where`). The
    // "latest" path has no selection conditions, so it must NOT use `findOne` —
    // TypeORM throws "You must provide selection conditions in order to find a
    // single row" when `findOne` is called without a `where`. Take the newest
    // row via `find` with `take: 1` instead.
    let report: GovernanceFinanceReport | null;
    if (quarter) {
      report = await this.reports.findOne({ where: { quarter } });
    } else {
      const [latest] = await this.reports.find({
        order: { publishedAt: 'DESC' },
        take: 1,
      });
      report = latest ?? null;
    }

    if (!report) {
      throw new NotFoundException('Governance finance report not found');
    }
    return toGovernanceFinanceResponse(report);
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
        if (previous === submitted) continue;
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

      const applyLedger = (kind: 'income' | 'expense'): void => {
        const edits = dto[kind];
        if (!edits || edits.length === 0) return;
        const lines = report[kind] ?? [];
        for (const edit of edits) {
          if (edit.index >= lines.length) {
            throw new BadRequestException(
              `No ${kind} ledger row at index ${edit.index}`,
            );
          }
        }
        // Rebuild the array with fresh line objects rather than mutating in
        // place — TypeORM's dirty-check compares the loaded jsonb by reference,
        // so an in-place mutation would not be persisted.
        report[kind] = lines.map((line, index) => {
          const edit = edits.find((candidate) => candidate.index === index);
          if (!edit) return line;
          const next = { ...line };
          if (edit.amount !== undefined && edit.amount !== line.amount) {
            auditRows.push(
              manager.create(GovernanceFinanceChange, {
                actorId,
                field: `${kind}[${index}]`,
                oldValue: line.amount,
                newValue: edit.amount,
                note: dto.note ?? null,
              }),
            );
            next.amount = edit.amount;
            next.source = FinanceMetricSource.Manual;
            changed = true;
          }
          if (edit.note !== undefined && edit.note !== line.note) {
            next.note = edit.note;
            changed = true;
          }
          return next;
        });
      };
      applyLedger('income');
      applyLedger('expense');

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
    });

    return this.getAdminFinances();
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
