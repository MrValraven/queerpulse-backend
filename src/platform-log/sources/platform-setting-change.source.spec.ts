import type { Repository } from 'typeorm';
import type { PlatformSettingChange } from '../../platform-settings/entities/platform-setting-change.entity';
import type { SourceWindow } from '../platform-log.types';
import { PlatformSettingChangeSource } from './platform-setting-change.source';

type QueryBuilderMethod =
  | 'select'
  | 'addSelect'
  | 'where'
  | 'andWhere'
  | 'orderBy'
  | 'addOrderBy'
  | 'limit'
  | 'leftJoin'
  | 'innerJoin';
type QueryBuilderStub = Record<QueryBuilderMethod, jest.Mock> & {
  getRawMany: jest.Mock;
};

function queryBuilderStub(
  rows: Record<string, unknown>[] = [],
): QueryBuilderStub {
  const methods: QueryBuilderMethod[] = [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
    'leftJoin',
    'innerJoin',
  ];
  const queryBuilder = {} as QueryBuilderStub;
  for (const method of methods) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
}

function windowWith(overrides: Partial<SourceWindow> = {}): SourceWindow {
  return {
    cursor: null,
    since: null,
    limit: 30,
    memberId: null,
    staffRowsOnly: false,
    categories: ['moderation', 'staff', 'governance', 'reviews', 'members'],
    ...overrides,
  };
}

function conditionsOf(queryBuilder: QueryBuilderStub): string[] {
  return queryBuilder.andWhere.mock.calls.map(([sql]) => String(sql));
}

function sourceWith(rows: Record<string, unknown>[] = []) {
  const queryBuilder = queryBuilderStub(rows);
  const repository = { createQueryBuilder: jest.fn(() => queryBuilder) };
  const source = new PlatformSettingChangeSource(
    repository as unknown as Repository<PlatformSettingChange>,
  );
  return { source, queryBuilder, repository };
}

describe('PlatformSettingChangeSource', () => {
  it('maps a setting change with the key as the subject', async () => {
    const { source } = sourceWith([
      {
        row_id: 's1',
        occurred_at_exact: '2026-10-05T12:00:00.000001Z',
        setting_key: 'forum_posting_paused',
        old_value: 'false',
        new_value: 'true',
        actor_id: 'staff-1',
        note: 'Spam wave.',
      },
    ]);
    const [entry] = await source.fetch(windowWith());
    expect(entry).toMatchObject({
      sourceKey: 'set',
      category: 'governance',
      kind: 'settings.changed',
      subject: { label: 'forum_posting_paused', route: '/admin/settings' },
      params: {
        settingKey: 'forum_posting_paused',
        oldValue: 'false',
        newValue: 'true',
      },
      note: 'Spam wave.',
    });
  });

  it('filters by member as actor', async () => {
    const { source, queryBuilder } = sourceWith();
    await source.fetch(windowWith({ memberId: 'staff-1' }));
    expect(conditionsOf(queryBuilder)).toContain('"e"."actor_id" = :memberId');
  });
});
