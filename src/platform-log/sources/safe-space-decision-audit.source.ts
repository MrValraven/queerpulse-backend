import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Listing } from '../../listings/entities/listing.entity';
import { SafeSpaceDecisionAudit } from '../../safe-space-nominations/entities/safe-space-decision-audit.entity';
import {
  applyPlatformLogWindow,
  exactTimeSql,
  selectPlatformLogColumns,
} from '../platform-log-query';
import type {
  PlatformLogCategory,
  PlatformLogRawEntry,
  PlatformLogSource,
  SourceWindow,
} from '../platform-log.types';

/** Raised and withdrawn by members through the public flag route. */
const SAFE_SPACE_MEMBER_ACTIONS: readonly string[] = [
  'flag_raised',
  'flag_withdrawn',
];

interface SafeSpaceRow {
  row_id: string;
  occurred_at_exact: string;
  action: string;
  actor_id: string | null;
  reason: string | null;
  listing_name: string | null;
}

/**
 * Safe-space nomination, flag and badge decisions. `metadata` is never
 * selected: it can carry a flagger's id.
 */
@Injectable()
export class SafeSpaceDecisionAuditSource implements PlatformLogSource {
  readonly key = 'safe';
  readonly categories: readonly PlatformLogCategory[] = ['reviews'];
  readonly audience = 'staff' as const;

  constructor(
    @InjectRepository(SafeSpaceDecisionAudit)
    private readonly audits: Repository<SafeSpaceDecisionAudit>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('reviews')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.audits
        .createQueryBuilder('e')
        .leftJoin(Listing, 'l', '"l"."id" = "e"."listing_id"'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        action: '"e"."action"',
        actor_id: '"e"."actor_id"',
        reason: '"e"."reason"',
        listing_name: '"l"."name"',
      },
    );
    if (window.staffRowsOnly) {
      queryBuilder.andWhere(
        '"e"."action" NOT IN (:...safeSpaceMemberActions)',
        {
          safeSpaceMemberActions: [...SAFE_SPACE_MEMBER_ACTIONS],
        },
      );
    }
    if (window.memberId) {
      queryBuilder.andWhere('"e"."actor_id" = :memberId', {
        memberId: window.memberId,
      });
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<SafeSpaceRow>();
    return rows.map((row) => this.toEntry(row));
  }

  private toEntry(row: SafeSpaceRow): PlatformLogRawEntry {
    const isMemberRow = SAFE_SPACE_MEMBER_ACTIONS.includes(row.action);
    const isSystemRow =
      !isMemberRow && row.actor_id === null && row.action === 'badge_suspended';
    return {
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'reviews',
      kind: `safe_space.${row.action}`,
      actorUserId: row.actor_id,
      actorFallbackName: null,
      actorKind: isMemberRow ? 'member' : isSystemRow ? 'system' : 'staff',
      targetUserId: null,
      targetFallbackName: null,
      subject: { label: row.listing_name ?? '', route: '/admin/safe-spaces' },
      params: {},
      note: row.reason,
    };
  }
}
