import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VerificationEvent } from '../../verification/entities/verification-event.entity';
import {
  applyPlatformLogWindow,
  compactParams,
  exactTimeSql,
  selectPlatformLogColumns,
} from '../platform-log-query';
import type {
  PlatformLogCategory,
  PlatformLogRawEntry,
  PlatformLogSource,
  SourceWindow,
} from '../platform-log.types';

/** Steps the member takes themselves; admin-only in the log. */
const VERIFICATION_MEMBER_ACTIONS: readonly string[] = [
  'submitted',
  'appealed',
  'withdrawn',
];

interface VerificationRow {
  row_id: string;
  occurred_at_exact: string;
  action: string;
  actor_user_id: string | null;
  user_id: string;
  from_level: string | null;
  to_level: string | null;
  reason: string | null;
}

@Injectable()
export class VerificationEventSource implements PlatformLogSource {
  readonly key = 'ver';
  readonly categories: readonly PlatformLogCategory[] = ['reviews'];
  readonly audience = 'staff' as const;

  constructor(
    @InjectRepository(VerificationEvent)
    private readonly events: Repository<VerificationEvent>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('reviews')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.events.createQueryBuilder('e'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        action: '"e"."action"',
        actor_user_id: '"e"."actor_user_id"',
        user_id: '"e"."user_id"',
        from_level: '"e"."from_level"',
        to_level: '"e"."to_level"',
        reason: '"e"."reason"',
      },
    );
    if (window.staffRowsOnly) {
      queryBuilder.andWhere(
        '"e"."action" NOT IN (:...verificationMemberActions)',
        {
          verificationMemberActions: [...VERIFICATION_MEMBER_ACTIONS],
        },
      );
    }
    if (window.memberId) {
      queryBuilder.andWhere(
        '("e"."actor_user_id" = :memberId OR "e"."user_id" = :memberId)',
        { memberId: window.memberId },
      );
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<VerificationRow>();
    return rows.map((row) => this.toEntry(row));
  }

  private toEntry(row: VerificationRow): PlatformLogRawEntry {
    const isMemberRow = VERIFICATION_MEMBER_ACTIONS.includes(row.action);
    return {
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'reviews',
      kind: `verification.${row.action}`,
      actorUserId: isMemberRow
        ? (row.actor_user_id ?? row.user_id)
        : row.actor_user_id,
      actorFallbackName: null,
      // A staff-side row with no actor means the reviewer's account was
      // erased (the actor FK is ON DELETE SET NULL).
      actorKind: isMemberRow ? 'member' : 'staff',
      targetUserId: isMemberRow ? null : row.user_id,
      targetFallbackName: null,
      subject: { label: '', route: '/admin/verifications' },
      params: compactParams({
        fromLevel: row.from_level,
        toLevel: row.to_level,
      }),
      note: row.reason,
    };
  }
}
