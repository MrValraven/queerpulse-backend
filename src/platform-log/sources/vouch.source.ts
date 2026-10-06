import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vouch } from '../../vouch/entities/vouch.entity';
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

interface VouchRow {
  row_id: string;
  occurred_at_exact: string;
  voucher_id: string | null;
  is_anonymous: boolean;
  vouchee_id: string;
}

/**
 * Standing vouches. An anonymous voucher's id is nulled in SQL and never
 * matched by the member filter, so it cannot leave the database.
 */
@Injectable()
export class VouchSource implements PlatformLogSource {
  readonly key = 'vouch';
  readonly categories: readonly PlatformLogCategory[] = ['members'];
  readonly audience = 'admin' as const;

  constructor(
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('members')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.vouches.createQueryBuilder('e'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        voucher_id:
          'CASE WHEN "e"."anonymous" THEN NULL ELSE "e"."voucher_id" END',
        is_anonymous: '"e"."anonymous"',
        vouchee_id: '"e"."vouchee_id"',
      },
    );
    queryBuilder.andWhere('"e"."withdrawn_at" IS NULL');
    if (window.memberId) {
      queryBuilder.andWhere(
        '(("e"."voucher_id" = :memberId AND "e"."anonymous" = false) OR "e"."vouchee_id" = :memberId)',
        { memberId: window.memberId },
      );
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<VouchRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'members' as const,
      kind: 'member.vouch_given',
      actorUserId: row.is_anonymous ? null : row.voucher_id,
      actorFallbackName: null,
      actorKind: row.is_anonymous
        ? ('anonymous' as const)
        : ('member' as const),
      targetUserId: row.vouchee_id,
      targetFallbackName: null,
      subject: null,
      params: {},
      note: null,
    }));
  }
}
