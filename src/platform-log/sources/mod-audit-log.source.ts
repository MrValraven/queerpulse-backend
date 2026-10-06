import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ModAuditLog } from '../../moderation/entities/mod-audit-log.entity';
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

/** Every staff action in `mod_audit_logs`, split into Moderation and Staff & access. */
@Injectable()
export class ModAuditLogSource implements PlatformLogSource {
  readonly key = 'mod';
  readonly categories: readonly PlatformLogCategory[] = ['moderation', 'staff'];
  readonly audience = 'staff' as const;

  constructor(
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    const isModerationWanted = window.categories.includes('moderation');
    const isStaffWanted = window.categories.includes('staff');
    if (!isModerationWanted && !isStaffWanted) return [];

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
    if (!isStaffWanted) {
      queryBuilder.andWhere(
        '"e"."action" NOT IN (:...modStaffActions)',
        staffActions,
      );
    }
    if (!isModerationWanted) {
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
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<ModAuditRow>();
    return rows.map((row) => this.toEntry(row));
  }

  private toEntry(row: ModAuditRow): PlatformLogRawEntry {
    const isSystemAction =
      row.actor_id === null && MOD_SYSTEM_ACTIONS.includes(row.action);
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
