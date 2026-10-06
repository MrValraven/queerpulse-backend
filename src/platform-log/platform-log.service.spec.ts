import type { Repository } from 'typeorm';
import type { Profile } from '../users/entities/profile.entity';
import { decodePlatformLogCursor } from './platform-log-cursor';
import { PlatformLogService } from './platform-log.service';
import type {
  PlatformLogCategory,
  PlatformLogRawEntry,
  PlatformLogSource,
  SourceWindow,
} from './platform-log.types';

function rawEntry(
  sourceKey: string,
  rowId: string,
  occurredAtExact: string,
): PlatformLogRawEntry {
  return {
    sourceKey,
    rowId,
    occurredAtExact,
    category: 'moderation',
    kind: 'mod.warn',
    actorUserId: null,
    actorFallbackName: null,
    actorKind: 'staff',
    targetUserId: null,
    targetFallbackName: null,
    subject: null,
    params: {},
    note: null,
  };
}

/**
 * A fake source over a fixed row list that honours the keyset window exactly
 * like the real SQL predicate does.
 */
function fakeSource(
  key: string,
  rows: PlatformLogRawEntry[],
  options: {
    audience?: 'staff' | 'admin';
    categories?: PlatformLogCategory[];
  } = {},
): PlatformLogSource & { fetch: jest.Mock } {
  const fetch = jest.fn(async (window: SourceWindow) => {
    const { cursor } = window;
    const sorted = [...rows].sort((first, second) =>
      first.occurredAtExact === second.occurredAtExact
        ? second.rowId.localeCompare(first.rowId)
        : second.occurredAtExact.localeCompare(first.occurredAtExact),
    );
    return sorted
      .filter((row) => {
        if (!cursor) return true;
        if (key < cursor.sourceKey)
          return row.occurredAtExact <= cursor.occurredAtExact;
        if (key > cursor.sourceKey)
          return row.occurredAtExact < cursor.occurredAtExact;
        return (
          row.occurredAtExact < cursor.occurredAtExact ||
          (row.occurredAtExact === cursor.occurredAtExact &&
            row.rowId < cursor.rowId)
        );
      })
      .slice(0, window.limit + 1);
  });
  return {
    key,
    categories: options.categories ?? ['moderation'],
    audience: options.audience ?? 'staff',
    fetch,
  };
}

const profiles = {
  find: jest.fn().mockResolvedValue([]),
} as unknown as Repository<Profile>;
const NOW = new Date('2026-10-05T15:00:00Z');
const TIED = '2026-10-05T12:00:00.000001Z';

describe('PlatformLogService', () => {
  it('pages through interleaved sources with tied timestamps exactly once each', async () => {
    const sources = [
      fakeSource('mod', [
        rawEntry('mod', 'm1', TIED),
        rawEntry('mod', 'm2', '2026-10-05T11:00:00.000000Z'),
      ]),
      fakeSource('gov', [
        rawEntry('gov', 'g1', TIED),
        rawEntry('gov', 'g2', '2026-10-05T13:00:00.000000Z'),
      ]),
      fakeSource('set', [
        rawEntry('set', 's1', TIED),
        rawEntry('set', 's2', '2026-10-05T10:00:00.000000Z'),
      ]),
    ];
    const service = new PlatformLogService(sources, profiles);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await service.list(
        { limit: 2, cursor },
        { role: 'admin' },
        NOW,
      );
      seen.push(...result.data.map((entry) => entry.id));
      if (!result.pageInfo.hasMore) break;
      cursor = result.pageInfo.nextCursor ?? undefined;
    }
    expect(seen).toEqual([
      'gov:g2',
      'set:s1',
      'mod:m1',
      'gov:g1',
      'mod:m2',
      'set:s2',
    ]);
  });

  it('reports no next page on the last page', async () => {
    const service = new PlatformLogService(
      [fakeSource('mod', [rawEntry('mod', 'm1', TIED)])],
      profiles,
    );
    const result = await service.list({}, { role: 'admin' }, NOW);
    expect(result.pageInfo).toEqual({ nextCursor: null, hasMore: false });
  });

  it('encodes the last kept entry as the next cursor', async () => {
    const service = new PlatformLogService(
      [
        fakeSource('mod', [
          rawEntry('mod', 'm1', TIED),
          rawEntry('mod', 'm2', '2026-10-05T11:00:00.000000Z'),
        ]),
      ],
      profiles,
    );
    const result = await service.list({ limit: 1 }, { role: 'admin' }, NOW);
    expect(
      decodePlatformLogCursor(result.pageInfo.nextCursor ?? undefined),
    ).toEqual({
      occurredAtExact: TIED,
      sourceKey: 'mod',
      rowId: 'm1',
    });
  });

  it('never queries admin sources for a moderator, even when members is requested', async () => {
    const memberSource = fakeSource('vouch', [], {
      audience: 'admin',
      categories: ['members'],
    });
    const reviewSource = fakeSource('ver', [], { categories: ['reviews'] });
    const service = new PlatformLogService(
      [memberSource, reviewSource],
      profiles,
    );

    const membersOnly = await service.list(
      { categories: ['members'] },
      { role: 'moderator' },
      NOW,
    );
    expect(membersOnly.data).toEqual([]);
    expect(memberSource.fetch).not.toHaveBeenCalled();

    await service.list({}, { role: 'moderator' }, NOW);
    expect(memberSource.fetch).not.toHaveBeenCalled();
    expect(reviewSource.fetch.mock.calls[0]?.[0]).toMatchObject({
      staffRowsOnly: true,
    });
  });

  it('passes the member filter, range and category list to every source', async () => {
    const source = fakeSource('mod', [], {
      categories: ['moderation', 'staff'],
    });
    const service = new PlatformLogService([source], profiles);
    await service.list(
      {
        categories: ['staff'],
        range: 'week',
        memberId: '5b0c3a52-1d7e-4f43-9a35-2f6d0b7e1a01',
      },
      { role: 'admin' },
      NOW,
    );
    expect(source.fetch.mock.calls[0]?.[0]).toMatchObject({
      categories: ['staff'],
      memberId: '5b0c3a52-1d7e-4f43-9a35-2f6d0b7e1a01',
      since: new Date('2026-09-28T15:00:00Z'),
      staffRowsOnly: false,
      limit: 30,
    });
  });

  it('caps the page size at 50', async () => {
    const source = fakeSource('mod', []);
    const service = new PlatformLogService([source], profiles);
    await service.list({ limit: 500 }, { role: 'admin' }, NOW);
    expect(source.fetch.mock.calls[0]?.[0]).toMatchObject({ limit: 50 });
  });
});
