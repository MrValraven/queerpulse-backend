import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from '../../users/entities/profile.entity';
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

interface ProfileJoinRow {
  row_id: string;
  occurred_at_exact: string;
  first_name: string | null;
  last_name: string | null;
}

/** New accounts. An erased account has no profile, so it drops out on its own. */
@Injectable()
export class ProfileJoinSource implements PlatformLogSource {
  readonly key = 'join';
  readonly categories: readonly PlatformLogCategory[] = ['members'];
  readonly audience = 'admin' as const;

  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('members')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.profiles.createQueryBuilder('e'),
      {
        row_id: '"e"."user_id"',
        occurred_at_exact: exactTimeSql('"e"."joined_at"'),
        first_name: '"e"."first_name"',
        last_name: '"e"."last_name"',
      },
    );
    if (window.memberId) {
      queryBuilder.andWhere('"e"."user_id" = :memberId', {
        memberId: window.memberId,
      });
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."joined_at"', idSql: '"e"."user_id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<ProfileJoinRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'members' as const,
      kind: 'member.joined',
      actorUserId: row.row_id,
      actorFallbackName:
        `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || null,
      actorKind: 'member' as const,
      targetUserId: null,
      targetFallbackName: null,
      subject: null,
      params: {},
      note: null,
    }));
  }
}
