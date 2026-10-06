import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformSettingChange } from '../../platform-settings/entities/platform-setting-change.entity';
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

interface PlatformSettingRow {
  row_id: string;
  occurred_at_exact: string;
  setting_key: string;
  old_value: string | null;
  new_value: string | null;
  actor_id: string | null;
  note: string | null;
}

/** Toggles of platform-wide settings. */
@Injectable()
export class PlatformSettingChangeSource implements PlatformLogSource {
  readonly key = 'set';
  readonly categories: readonly PlatformLogCategory[] = ['governance'];
  readonly audience = 'staff' as const;

  constructor(
    @InjectRepository(PlatformSettingChange)
    private readonly changes: Repository<PlatformSettingChange>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('governance')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.changes.createQueryBuilder('e'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        setting_key: '"e"."setting_key"',
        old_value: '"e"."old_value"',
        new_value: '"e"."new_value"',
        actor_id: '"e"."actor_id"',
        note: '"e"."note"',
      },
    );
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
    const rows = await queryBuilder.getRawMany<PlatformSettingRow>();
    return rows.map((row) => ({
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'governance' as const,
      kind: 'settings.changed',
      actorUserId: row.actor_id,
      actorFallbackName: null,
      actorKind: 'staff' as const,
      targetUserId: null,
      targetFallbackName: null,
      subject: { label: row.setting_key, route: '/admin/settings' },
      params: compactParams({
        settingKey: row.setting_key,
        oldValue: row.old_value,
        newValue: row.new_value,
      }),
      note: row.note,
    }));
  }
}
