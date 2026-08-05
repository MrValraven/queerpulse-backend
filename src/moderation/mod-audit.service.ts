import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { AuditFeedQuery } from './dto/audit-feed.query';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import {
  AuditEntryDTO,
  AuditFeedModerator,
  AuditFeedResponseDTO,
  AuditFeedRowDTO,
  toAuditEntryDTO,
  toAuditFeedRow,
} from './moderation-response';

const DEFAULT_LIMIT = 20;

// Hard cap on a single CSV export (P3-8). The audit table is append-only and
// unbounded over time; an export must never buffer the whole table into memory.
// 5000 mirrors the roadmap admin audit CSV export's ceiling.
const CSV_EXPORT_LIMIT = 5000;

/**
 * The moderation audit cluster, extracted from `ModerationService` as a
 * behavior-preserving concern split: writing immutable audit-log rows (across
 * every moderator action), reading a single report's trail (`auditTrail`),
 * reading the global cross-report feed (`auditFeed`), and the actor-name
 * resolution those reads share. `ModerationService` injects this and delegates;
 * its public API is unchanged.
 */
@Injectable()
export class ModAuditService {
  constructor(
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  // GET /mod/reports/audit?reportId= — the immutable trail for one report,
  // oldest first. Renames `createdAt`→`at` and resolves `actorName` (I7).
  async auditTrail(reportId: string): Promise<AuditEntryDTO[]> {
    const rows = await this.auditLogs.find({
      where: { reportId },
      order: { createdAt: 'ASC' },
      // Bounded like `auditFeed`/`listAppeals`: a single report's immutable
      // trail is short in practice, but leaving it unbounded fans a per-row
      // name lookup out across an arbitrarily long list. The drawer renders the
      // trail in full and does not rely on receiving an unbounded set.
      take: DEFAULT_LIMIT,
    });
    // One name lookup for the whole trail instead of one per log row: collect
    // the distinct (non-erased) actor ids and resolve them together.
    const actorIds = rows
      .map((log) => log.actorId)
      .filter((actorId): actorId is string => actorId !== null);
    const actorNames = await this.namesForUserIds(actorIds);
    return rows.map((log) =>
      toAuditEntryDTO(log, this.resolveActorName(log.actorId, actorNames)),
    );
  }

  // GET /mod/audit — the global, cross-report moderation audit feed for the
  // admin governance "Audit" tab. Unlike `auditTrail`, not scoped to one
  // report: paginated, newest first, filterable by moderator/action/range/
  // free-text note search, and includes report-less rows (e.g.
  // `suspension_lifted`) that `auditTrail` never surfaces.
  async auditFeed(query: AuditFeedQuery): Promise<AuditFeedResponseDTO> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 8;

    const builder = this.auditFeedQueryBuilder(query);

    const total = await builder.getCount();
    const rows = await builder
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    const { resolveName, subjectFor } = await this.enrichAuditRows(rows);
    const items: AuditFeedRowDTO[] = rows.map((log) =>
      toAuditFeedRow(log, resolveName(log), subjectFor(log)),
    );

    // Distinct actors across the *whole* table (not just this page), for the
    // moderator filter's dropdown options.
    const distinctActorRows = await this.auditLogs
      .createQueryBuilder('log')
      .select('log.actorId', 'actorId')
      .distinct(true)
      .where('log.actorId IS NOT NULL')
      .getRawMany<{ actorId: string }>();
    const distinctActorIds = distinctActorRows
      .map((actorRow) => actorRow.actorId)
      .filter((actorId): actorId is string => actorId !== null);
    const moderatorNames = await this.namesForUserIds(distinctActorIds);
    const moderators: AuditFeedModerator[] = distinctActorIds.map(
      (actorId) => ({
        id: actorId,
        name: moderatorNames.get(actorId) ?? 'Member',
      }),
    );

    return { items, total, page, pageSize, moderators };
  }

  // GET /mod/audit.csv (P3-8) — the same filtered, cross-report audit feed as
  // `auditFeed`, streamed as a CSV attachment for the admin governance "Audit"
  // tab's export. Honours the moderator/action/range/q filters (pagination is
  // irrelevant to an export — it dumps every matching row up to
  // `CSV_EXPORT_LIMIT`, newest first). Columns mirror the audit table the page
  // renders: when, moderator, action, subject, reason.
  async auditFeedCsv(query: AuditFeedQuery): Promise<string> {
    const rows = await this.auditFeedQueryBuilder(query)
      .take(CSV_EXPORT_LIMIT)
      .getMany();
    const { resolveName, subjectFor } = await this.enrichAuditRows(rows);

    const table: string[][] = [
      ['when', 'moderator', 'action', 'subject', 'reason'],
      ...rows.map((log) => [
        log.createdAt.toISOString(),
        resolveName(log),
        log.action,
        subjectFor(log),
        log.note ?? log.reasonCode ?? '',
      ]),
    ];
    return table
      .map((row) => row.map((field) => this.toCsvField(field)).join(','))
      .join('\n');
  }

  // The shared, filtered, newest-first query builder behind both `auditFeed`
  // (paginated) and `auditFeedCsv` (bounded dump). Applies the same
  // moderator/action/range/note-search filters so the export can never drift
  // from what the on-screen feed shows.
  private auditFeedQueryBuilder(
    query: AuditFeedQuery,
  ): SelectQueryBuilder<ModAuditLog> {
    const builder = this.auditLogs
      .createQueryBuilder('log')
      .orderBy('log.createdAt', 'DESC');

    if (query.moderator) {
      builder.andWhere('log.actorId = :moderatorId', {
        moderatorId: query.moderator,
      });
    }
    if (query.action) {
      builder.andWhere('log.action = :action', { action: query.action });
    }
    if (query.range) {
      const now = new Date();
      let floor: Date;
      if (query.range === 'today') {
        floor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (query.range === 'week') {
        floor = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else {
        floor = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      }
      builder.andWhere('log.createdAt >= :floor', { floor });
    }
    if (query.q && query.q.trim()) {
      builder.andWhere('log.note ILIKE :search', {
        search: `%${query.q.trim()}%`,
      });
    }
    return builder;
  }

  // Resolves the per-row derived fields (actor display name + human subject
  // line) both audit reads need, in a fixed number of batched queries: one
  // name lookup across all actors and one report lookup across all linked
  // reports, regardless of row count.
  private async enrichAuditRows(rows: ModAuditLog[]): Promise<{
    resolveName: (log: ModAuditLog) => string;
    subjectFor: (log: ModAuditLog) => string;
  }> {
    const actorIds = rows
      .map((row) => row.actorId)
      .filter((actorId): actorId is string => actorId !== null);
    const actorNames = await this.namesForUserIds(actorIds);

    const reportIds = rows
      .map((row) => row.reportId)
      .filter((reportId): reportId is string => reportId !== null);
    const reportsById = new Map<string, Report>();
    if (reportIds.length) {
      const linkedReports = await this.reports.find({
        where: { id: In(reportIds) },
      });
      for (const linkedReport of linkedReports) {
        reportsById.set(linkedReport.id, linkedReport);
      }
    }

    const subjectFor = (log: ModAuditLog): string => {
      if (log.reportId) {
        const linkedReport = reportsById.get(log.reportId);
        if (linkedReport) {
          return `Report · ${linkedReport.subjectType} ${linkedReport.subjectId.slice(0, 8)}`;
        }
        return `Report #${log.reportId.slice(0, 8)}`;
      }
      return 'Platform action';
    };
    const resolveName = (log: ModAuditLog): string =>
      this.resolveActorName(log.actorId, actorNames);

    return { resolveName, subjectFor };
  }

  // RFC-4180 quote/escape, with a spreadsheet formula-injection guard (mirrors
  // `roadmap-admin.service`'s CSV export). An audit row can carry
  // attacker-controlled text (a moderator's own display name, a free-text
  // `note`), so any field is treated as untrusted.
  private toCsvField(value: string): string {
    const guarded = this.neutralizeCsvFormula(value);
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  // Spreadsheet apps evaluate a cell whose content starts with `=`, `+`, `-`,
  // `@`, a tab, or a carriage return as a formula on open. Prefixing a `'`
  // forces plain-text rendering; applied before the quote/escape so the
  // apostrophe lands inside the quoted field.
  private neutralizeCsvFormula(value: string): string {
    return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  }

  async writeAuditLog(
    // Nullable since `AddModerationEnforcement1782800800000`: a suspension
    // lifted outside the context of a specific report has no report to hang
    // off, and a placeholder id would be a lie in an immutable trail. Such a
    // row does not appear in any `GET /mod/reports/audit` response, which
    // filters by `reportId` — there is no global audit feed yet.
    reportId: string | null,
    actorId: string,
    action: string,
    reasonCode?: string,
    note?: string,
    duration?: string,
    // When inside a transaction, pass the manager so the audit row commits
    // with the action it records instead of surviving a rollback.
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(ModAuditLog) : this.auditLogs;
    await repo.save(
      repo.create({
        reportId,
        actorId,
        action,
        reasonCode: reasonCode ?? null,
        note: note ?? null,
        duration: duration ?? null,
      }),
    );
  }

  // --- actor-name resolution (shared by the audit reads above and by
  // `ModerationService`'s reporter/appellant/original-action enrichment) ---

  // `null` is the erased-account case: `reports.reporter_id` and
  // `mod_audit_logs.actor_id` are NULLed rather than cascaded when a member
  // exercises their right to erasure, so the moderation record outlives them.
  // There is no one left to name — say so plainly rather than falling through
  // to a lookup that would return the generic 'Member'.
  async nameForUserId(userId: string | null): Promise<string> {
    if (!userId) return 'Deleted member';
    const profile = await this.profiles.findOne({ where: { userId } });
    if (profile) return `${profile.firstName} ${profile.lastName}`.trim();
    // `addSelect('user.email')` re-includes the `select: false` email column —
    // it is the last-resort display name for a member with no profile row.
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.email')
      .where('user.id = :userId', { userId })
      .getOne();
    return user?.email ?? 'Member';
  }

  /**
   * Batched sibling of `nameForUserId` — resolves many non-null user ids to
   * display names in two queries total (profiles, then a users fallback for the
   * ids with no profile), keeping the single-id contract of `nameForUserId`
   * untouched. Every requested id resolves by the exact same rules: a profile's
   * `firstName lastName`, else the user's email, else 'Member'.
   *
   * The `null` (erased) case is deliberately NOT handled here — callers pass
   * only non-null ids and map `null` to 'Deleted member' via `resolveActorName`,
   * mirroring `nameForUserId(null)`.
   */
  async namesForUserIds(userIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const uniqueUserIds = [...new Set(userIds)];
    if (!uniqueUserIds.length) return names;

    const profiles = await this.profiles.find({
      where: { userId: In(uniqueUserIds) },
    });
    for (const profile of profiles) {
      names.set(
        profile.userId,
        `${profile.firstName} ${profile.lastName}`.trim(),
      );
    }

    // Only ids without a profile need the email fallback (mirrors the single
    // resolver's profile-first, user-email-second order).
    const userIdsWithoutProfile = uniqueUserIds.filter(
      (userId) => !names.has(userId),
    );
    if (userIdsWithoutProfile.length) {
      const users = await this.users
        .createQueryBuilder('user')
        .addSelect('user.email')
        .where('user.id IN (:...userIdsWithoutProfile)', {
          userIdsWithoutProfile,
        })
        .getMany();
      for (const user of users) {
        names.set(user.id, user.email ?? 'Member');
      }
    }

    // Neither a profile nor a user row: `user?.email ?? 'Member'` → 'Member'.
    for (const userId of uniqueUserIds) {
      if (!names.has(userId)) names.set(userId, 'Member');
    }
    return names;
  }

  // Maps a (possibly-erased) actor id to a display name from a pre-resolved
  // `namesForUserIds` map, reproducing `nameForUserId`: `null` → 'Deleted
  // member', an unresolved id → 'Member'.
  resolveActorName(
    actorId: string | null,
    actorNames: Map<string, string>,
  ): string {
    if (!actorId) return 'Deleted member';
    return actorNames.get(actorId) ?? 'Member';
  }
}
