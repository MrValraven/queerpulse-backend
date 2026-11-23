import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { parseCreatorDraftViewedNote } from '../../creator-drafts/creator-draft-audit';
import { CREATOR_DRAFT_VIEWED_ACTION } from '../../creator-drafts/creator-drafts.constants';
import { ModAuditLog } from '../../moderation/entities/mod-audit-log.entity';
import type { AuditFeedViewer } from '../../moderation/mod-audit.service';
import { excludeAuditRowsAboutViewer } from '../../moderation/mod-audit-viewer-filter';
import { ModerationService } from '../../moderation/moderation.service';
import {
  applyPlatformLogWindow,
  compactParams,
  exactTimeSql,
  selectPlatformLogColumns,
} from '../platform-log-query';
import {
  MOD_STAFF_ACTIONS,
  MOD_SYSTEM_ACTIONS,
  type PlatformLogCategory,
  type PlatformLogRawEntry,
  type PlatformLogSource,
  type SourceWindow,
} from '../platform-log.types';

interface ModAuditRow {
  row_id: string;
  occurred_at_exact: string;
  action: string;
  actor_id: string | null;
  target_user_id: string | null;
  target_name: string | null;
  report_id: string | null;
  reason_code: string | null;
  duration: string | null;
  note: string | null;
}

/** The one `ModerationService` method this source reads. */
export type ModAuditViewerRule = Pick<ModerationService, 'auditFeedViewer'>;

/**
 * Every staff action in `mod_audit_logs`, split into Moderation and Staff &
 * access. SEC-31: the viewer never sees a row tied to a case about them, by
 * the same rule as the governance audit feed (`excludeAuditRowsAboutViewer`
 * in SQL, then `ModerationService.reportIdsAboutActor` for the rest).
 */
@Injectable()
export class ModAuditLogSource implements PlatformLogSource {
  readonly key = 'mod';
  readonly categories: readonly PlatformLogCategory[] = ['moderation', 'staff'];
  readonly audience = 'staff' as const;

  constructor(
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    @Inject(ModerationService)
    private readonly moderation: ModAuditViewerRule,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    const isModerationWanted = window.categories.includes('moderation');
    const isStaffWanted = window.categories.includes('staff');
    if (!isModerationWanted && !isStaffWanted) return [];

    const viewer = this.moderation.auditFeedViewer(window.viewerUserId);
    const wantedRowCount = window.limit + 1;
    const keptRows: ModAuditRow[] = [];
    let batchWindow = window;
    // Rows dropped after SQL leave a short batch, so read on past the last
    // raw row until the page is full or the table runs out. Stopping early
    // would let older rows from other sources jump over rows kept here.
    for (;;) {
      const rows = await this.queryBuilderFor(batchWindow, {
        isModerationWanted,
        isStaffWanted,
      }).getRawMany<ModAuditRow>();
      keptRows.push(...(await this.withoutRowsAboutViewer(rows, viewer)));
      const lastRow = rows[rows.length - 1];
      if (
        !lastRow ||
        rows.length < wantedRowCount ||
        keptRows.length >= wantedRowCount
      ) {
        break;
      }
      batchWindow = {
        ...window,
        cursor: {
          occurredAtExact: lastRow.occurred_at_exact,
          sourceKey: this.key,
          rowId: lastRow.row_id,
        },
      };
    }
    return keptRows.slice(0, wantedRowCount).map((row) => this.toEntry(row));
  }

  private queryBuilderFor(
    window: SourceWindow,
    wanted: { isModerationWanted: boolean; isStaffWanted: boolean },
  ): SelectQueryBuilder<ModAuditLog> {
    const queryBuilder = selectPlatformLogColumns(
      this.auditLogs.createQueryBuilder('e'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        action: '"e"."action"',
        actor_id: '"e"."actor_id"',
        target_user_id: '"e"."target_user_id"',
        target_name: '"e"."target_name"',
        report_id: '"e"."report_id"',
        reason_code: '"e"."reason_code"',
        duration: '"e"."duration"',
        note: '"e"."note"',
      },
    );
    const staffActions = { modStaffActions: [...MOD_STAFF_ACTIONS] };
    if (!wanted.isStaffWanted) {
      queryBuilder.andWhere(
        '"e"."action" NOT IN (:...modStaffActions)',
        staffActions,
      );
    }
    if (!wanted.isModerationWanted) {
      queryBuilder.andWhere(
        '"e"."action" IN (:...modStaffActions)',
        staffActions,
      );
    }
    if (window.memberId) {
      queryBuilder.andWhere(
        '("e"."actor_id" = :memberId OR "e"."target_user_id" = :memberId)',
        { memberId: window.memberId },
      );
    }
    if (window.viewerUserId) {
      excludeAuditRowsAboutViewer(queryBuilder, 'e', window.viewerUserId);
    }
    return applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
  }

  /** `rows` without those whose report is about the viewer. Order kept. */
  private async withoutRowsAboutViewer(
    rows: ModAuditRow[],
    viewer: AuditFeedViewer | undefined,
  ): Promise<ModAuditRow[]> {
    if (!viewer) return rows;
    const reportIds = [
      ...new Set(
        rows
          .map((row) => row.report_id)
          .filter((reportId): reportId is string => reportId !== null),
      ),
    ];
    if (!reportIds.length) return rows;
    const aboutViewer = await viewer.reportIdsAboutViewer(reportIds);
    if (!aboutViewer.size) return rows;
    return rows.filter(
      (row) => row.report_id === null || !aboutViewer.has(row.report_id),
    );
  }

  private toEntry(row: ModAuditRow): PlatformLogRawEntry {
    const isSystemAction =
      row.actor_id === null && MOD_SYSTEM_ACTIONS.includes(row.action);
    if (row.action === CREATOR_DRAFT_VIEWED_ACTION) {
      return {
        sourceKey: this.key,
        rowId: row.row_id,
        occurredAtExact: row.occurred_at_exact,
        category: 'staff',
        kind: `mod.${row.action}`,
        actorUserId: row.actor_id,
        actorFallbackName: null,
        actorKind: 'staff',
        targetUserId: row.target_user_id,
        targetFallbackName: row.target_name,
        subject: { label: '', route: '/admin/creator-drafts' },
        params: compactParams({
          draftKind: parseCreatorDraftViewedNote(row.note)?.kind,
        }),
        note: null,
      };
    }
    return {
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: MOD_STAFF_ACTIONS.includes(row.action) ? 'staff' : 'moderation',
      kind: `mod.${row.action}`,
      actorUserId: row.actor_id,
      actorFallbackName: null,
      actorKind: isSystemAction ? 'system' : 'staff',
      targetUserId: row.target_user_id,
      targetFallbackName: row.target_name,
      subject: row.report_id ? { label: '', route: '/admin/moderation' } : null,
      params: compactParams({
        reasonCode: row.reason_code,
        duration: row.duration,
      }),
      note: row.note,
    };
  }
}
