import type { DataSource } from 'typeorm';
import type { ModAuditService } from '../moderation/mod-audit.service';
import { BADGE_CATALOG } from '../recognition/recognition.catalog';
import type { QuizBadgeDefinitionInputDto } from './dto/quiz-win-badges.dto';
import {
  ARCHIVE_QUIZ_BADGE_DEFINITION_SQL,
  DELETE_DEFINITION_AWARDS_SQL,
  DELETE_DEFINITION_SLOTS_SQL,
  DELETE_QUIZ_BADGE_DEFINITION_SQL,
  ENGLISH_NAME_TAKEN_SQL,
  INSERT_QUIZ_BADGE_DEFINITION_SQL,
  LIST_QUIZ_BADGE_LIBRARY_SQL,
  PORTUGUESE_NAME_TAKEN_SQL,
  QUIZ_BADGE_DELETE_LOCK_SQL,
  QuizBadgeLibraryService,
  READ_DEFINITION_EVENT_IDS_SQL,
  READ_DEFINITION_IDENTITY_SQL,
  READ_DEFINITION_WIN_COUNTS_SQL,
  READ_QUIZ_BADGE_DEFINITION_SQL,
  RESTORE_QUIZ_BADGE_DEFINITION_SQL,
} from './quiz-badge-library.service';
import {
  QUIZ_BADGE_AUDIT_ACTIONS,
  QUIZ_EVENT_BADGES_LOCK_SQL,
} from './quiz-win-badges.constants';

const DEFINITION_ID = '2f1c9a4e-7b3d-4c8a-9e5f-1a2b3c4d5e6f';
const CREATED_AT = new Date('2026-11-20T10:00:00.000Z');
const ARCHIVED_AT = new Date('2026-11-22T10:00:00.000Z');

type Answer =
  object | string | number | null | ((parameters: unknown[]) => unknown);
type Routes = [prefix: string, answer: Answer][];

/** Answers a query with the first route whose SQL prefix matches; an
 *  unmatched statement answers no rows. */
function answerBySql(routes: Routes) {
  return async (sql: string, parameters: unknown[] = []): Promise<unknown> => {
    const route = routes.find(([prefix]) => sql.startsWith(prefix));
    if (!route) return [];
    const answer = route[1];
    return typeof answer === 'function'
      ? (answer as (parameters: unknown[]) => unknown)(parameters)
      : answer;
  };
}

function definitionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEFINITION_ID,
    badge_key: `quiz:${DEFINITION_ID}`,
    name_en: 'Champion',
    name_pt: null,
    description_en: 'Won a game',
    description_pt: null,
    icon_key: 'star',
    tint: 'plum',
    rarity: 'rare',
    archived_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    holder_count: 0,
    win_count: 0,
    event_count: 0,
    ...overrides,
  };
}

function validBody(
  overrides: Record<string, unknown> = {},
): QuizBadgeDefinitionInputDto {
  return {
    name: { en: 'Champion' },
    description: { en: 'Won a game' },
    iconKey: 'star',
    tint: 'plum',
    rarity: 'rare',
    ...overrides,
  };
}

function buildHarness(
  dataSourceRoutes: Routes = [],
  managerRoutes: Routes = [],
) {
  const manager = {
    query: jest.fn(answerBySql(managerRoutes)),
  };
  const dataSource = {
    query: jest.fn(answerBySql(dataSourceRoutes)),
    transaction: jest.fn(async (work: (entityManager: unknown) => unknown) =>
      work(manager),
    ),
  };
  const modAudit = {
    writeAuditLog: jest.fn().mockResolvedValue('audit-1'),
  };
  const service = new QuizBadgeLibraryService(
    dataSource as unknown as DataSource,
    modAudit as unknown as ModAuditService,
  );
  return { service, dataSource, manager, modAudit };
}

/** The statements a mock received, in call order. */
function statementsOf(mock: jest.Mock): string[] {
  return mock.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe('QuizBadgeLibraryService', () => {
  describe('listLibrary', () => {
    it('reads one ordered statement and maps counts to the badge', async () => {
      const { service, dataSource } = buildHarness([
        [
          LIST_QUIZ_BADGE_LIBRARY_SQL,
          [
            definitionRow({
              holder_count: '4',
              win_count: '6',
              event_count: '2',
            }),
            definitionRow({
              id: 'other',
              archived_at: ARCHIVED_AT,
              name_pt: 'Campeã',
            }),
          ],
        ],
      ]);
      const response = await service.listLibrary();
      expect(dataSource.query).toHaveBeenCalledTimes(1);
      expect(LIST_QUIZ_BADGE_LIBRARY_SQL).toContain(
        'ORDER BY ("definition"."archived_at" IS NOT NULL) ASC, "definition"."name_en" ASC, "definition"."id" ASC LIMIT 200',
      );
      expect(LIST_QUIZ_BADGE_LIBRARY_SQL).toContain(
        'COUNT(DISTINCT "win"."user_id")',
      );
      expect(LIST_QUIZ_BADGE_LIBRARY_SQL).toContain(
        'COUNT(DISTINCT "slot"."event_id")',
      );
      expect(response.items).toHaveLength(2);
      expect(response.items[0]).toMatchObject({
        id: DEFINITION_ID,
        badgeKey: `quiz:${DEFINITION_ID}`,
        name: { en: 'Champion', pt: null },
        holderCount: 4,
        winCount: 6,
        eventCount: 2,
        canDelete: false,
        isArchived: false,
        archivedAt: null,
        createdAt: CREATED_AT.toISOString(),
      });
      expect(response.items[1]).toMatchObject({
        isArchived: true,
        archivedAt: ARCHIVED_AT.toISOString(),
        canDelete: true,
        name: { en: 'Champion', pt: 'Campeã' },
      });
    });
  });

  describe('create validation', () => {
    it.each<[Record<string, unknown>, string, Record<string, unknown>]>([
      [{ name: 'Champion' }, 'quiz_badge_text_invalid', { field: 'name.en' }],
      [{ name: { en: 7 } }, 'quiz_badge_text_invalid', { field: 'name.en' }],
      [
        { name: { en: '  <b></b> ' } },
        'quiz_badge_name_required',
        { language: 'en' },
      ],
      [
        { name: { en: 'x'.repeat(41) } },
        'quiz_badge_name_too_long',
        { language: 'en', maxLength: 40 },
      ],
      [
        { name: { en: 'Champion', pt: 3 } },
        'quiz_badge_text_invalid',
        { field: 'name.pt' },
      ],
      [
        {
          name: { en: 'Champion' },
          description: { en: 'Won a game' },
          iconKey: 'trophy_cup',
        },
        'quiz_badge_icon_unknown',
        {},
      ],
      [
        {
          name: { en: 'Champion' },
          description: { en: 'Won a game' },
          iconKey: 'star',
          tint: 'rose',
        },
        'quiz_badge_tint_unknown',
        {},
      ],
      [
        {
          name: { en: 'Champion' },
          description: { en: 'Won a game' },
          iconKey: 'star',
          tint: 'plum',
          rarity: 'epic',
        },
        'quiz_badge_rarity_unknown',
        {},
      ],
    ])('refuses %p with %s', async (body, code, extras) => {
      const { service } = buildHarness();
      await expect(
        service.create('admin-1', body as QuizBadgeDefinitionInputDto),
      ).rejects.toMatchObject({ response: { code, ...extras } });
    });

    it('refuses a missing description with the required code', async () => {
      const { service } = buildHarness();
      await expect(
        service.create('admin-1', validBody({ description: undefined })),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_description_required', language: 'en' },
      });
    });

    it('refuses a Portuguese description past 140 code points', async () => {
      const { service } = buildHarness();
      await expect(
        service.create(
          'admin-1',
          validBody({ description: { en: 'Won', pt: 'y'.repeat(141) } }),
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'quiz_badge_description_too_long',
          language: 'pt',
          maxLength: 140,
        },
      });
    });

    it('writes nothing when a field fails', async () => {
      const { service, dataSource } = buildHarness();
      await expect(
        service.create('admin-1', validBody({ rarity: 'epic' })),
      ).rejects.toBeDefined();
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('counts an emoji name by code points', async () => {
      const emojiName = '😀'.repeat(40);
      const { service, dataSource } = buildHarness([
        [INSERT_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]],
      ]);
      await expect(
        service.create('admin-1', validBody({ name: { en: emojiName } })),
      ).resolves.toMatchObject({ id: DEFINITION_ID });
      const insertCall = dataSource.query.mock.calls.find(
        (call: unknown[]) => call[0] === INSERT_QUIZ_BADGE_DEFINITION_SQL,
      ) as [string, unknown[]];
      expect(insertCall[1][2]).toBe(emojiName);
    });

    it('stores a name with markup as plain text', async () => {
      const { service, dataSource } = buildHarness([
        [INSERT_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]],
      ]);
      await service.create(
        'admin-1',
        validBody({ name: { en: '<b>Champion</b>' } }),
      );
      const insertCall = dataSource.query.mock.calls.find(
        (call: unknown[]) => call[0] === INSERT_QUIZ_BADGE_DEFINITION_SQL,
      ) as [string, unknown[]];
      expect(insertCall[1][2]).toBe('Champion');
    });

    it('refuses an English name a code badge already uses', async () => {
      const { service, dataSource } = buildHarness();
      await expect(
        service.create(
          'admin-1',
          validBody({ name: { en: BADGE_CATALOG[0]!.name.toUpperCase() } }),
        ),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_name_taken', language: 'en' },
      });
      expect(statementsOf(dataSource.query)).not.toContain(
        INSERT_QUIZ_BADGE_DEFINITION_SQL,
      );
    });

    it('refuses an English name another definition uses', async () => {
      const { service } = buildHarness([
        [ENGLISH_NAME_TAKEN_SQL, [{ found: 1 }]],
      ]);
      await expect(
        service.create('admin-1', validBody()),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_name_taken', language: 'en' },
      });
    });

    it('refuses a Portuguese name another definition uses', async () => {
      const { service } = buildHarness([
        [PORTUGUESE_NAME_TAKEN_SQL, [{ found: 1 }]],
      ]);
      await expect(
        service.create(
          'admin-1',
          validBody({ name: { en: 'Champion', pt: 'Campeã' } }),
        ),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_name_taken', language: 'pt' },
      });
    });

    it('maps a unique violation on the Portuguese name to the language', async () => {
      const { service, dataSource } = buildHarness();
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql === INSERT_QUIZ_BADGE_DEFINITION_SQL) {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'UQ_quiz_badge_definitions_name_pt',
          });
        }
        return [];
      });
      await expect(
        service.create(
          'admin-1',
          validBody({ name: { en: 'Champion', pt: 'Campeã' } }),
        ),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_name_taken', language: 'pt' },
      });
    });

    it('maps a unique violation on the English name read from the driver error', async () => {
      const { service, dataSource } = buildHarness();
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql === INSERT_QUIZ_BADGE_DEFINITION_SQL) {
          throw Object.assign(new Error('duplicate key'), {
            driverError: {
              code: '23505',
              constraint: 'UQ_quiz_badge_definitions_name_en',
            },
          });
        }
        return [];
      });
      await expect(
        service.create('admin-1', validBody()),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_name_taken', language: 'en' },
      });
    });

    it('rethrows a write error that is not a name violation', async () => {
      const { service, dataSource } = buildHarness();
      const failure = new Error('connection lost');
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql === INSERT_QUIZ_BADGE_DEFINITION_SQL) throw failure;
        return [];
      });
      await expect(service.create('admin-1', validBody())).rejects.toBe(
        failure,
      );
    });

    it('writes the badge key from the generated id in the same insert', async () => {
      const { service, dataSource } = buildHarness([
        [INSERT_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]],
      ]);
      await service.create('admin-1', validBody());
      const insertCalls = dataSource.query.mock.calls.filter(
        (call: unknown[]) => call[0] === INSERT_QUIZ_BADGE_DEFINITION_SQL,
      ) as [string, unknown[]][];
      expect(insertCalls).toHaveLength(1);
      const parameters = insertCalls[0]![1];
      expect(parameters[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(parameters[1]).toBe(`quiz:${String(parameters[0])}`);
      expect(parameters[9]).toBe('admin-1');
      expect(INSERT_QUIZ_BADGE_DEFINITION_SQL).toContain('"badge_key"');
    });

    it('stores an empty Portuguese name as null', async () => {
      const { service, dataSource } = buildHarness([
        [INSERT_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]],
      ]);
      await service.create(
        'admin-1',
        validBody({ name: { en: 'Champion', pt: '   ' } }),
      );
      const insertCall = dataSource.query.mock.calls.find(
        (call: unknown[]) => call[0] === INSERT_QUIZ_BADGE_DEFINITION_SQL,
      ) as [string, unknown[]];
      expect(insertCall[1][3]).toBeNull();
      expect(insertCall[1][5]).toBeNull();
    });

    it('answers the created badge with zero counts', async () => {
      const { service } = buildHarness([
        [INSERT_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]],
      ]);
      await expect(
        service.create('admin-1', validBody()),
      ).resolves.toMatchObject({
        holderCount: 0,
        winCount: 0,
        eventCount: 0,
        canDelete: true,
        isArchived: false,
      });
    });
  });

  describe('update', () => {
    it('answers quiz_badge_not_found for a malformed id', async () => {
      const { service } = buildHarness();
      await expect(service.update('not-a-uuid', {})).rejects.toMatchObject({
        response: { code: 'quiz_badge_not_found' },
      });
    });

    it('answers an empty PATCH with the current badge and no write', async () => {
      const { service, dataSource, modAudit } = buildHarness([
        [READ_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]],
      ]);
      await expect(service.update(DEFINITION_ID, {})).resolves.toMatchObject({
        id: DEFINITION_ID,
      });
      expect(
        statementsOf(dataSource.query).filter((sql) =>
          sql.startsWith('UPDATE'),
        ),
      ).toHaveLength(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('answers quiz_badge_not_found for an empty PATCH on a deleted badge', async () => {
      const { service } = buildHarness();
      await expect(service.update(DEFINITION_ID, {})).rejects.toMatchObject({
        response: { code: 'quiz_badge_not_found' },
      });
    });

    it('writes only the fields the body carries and no audit row', async () => {
      const { service, dataSource, modAudit } = buildHarness([
        [
          READ_DEFINITION_IDENTITY_SQL,
          [{ id: DEFINITION_ID, name_en: 'Champion' }],
        ],
        ['UPDATE "quiz_badge_definitions" SET', [{ id: DEFINITION_ID }]],
        [
          READ_QUIZ_BADGE_DEFINITION_SQL,
          [definitionRow({ rarity: 'legendary' })],
        ],
      ]);
      const badge = await service.update(DEFINITION_ID, {
        rarity: 'legendary',
      });
      const updateCall = dataSource.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).startsWith('UPDATE'),
      ) as [string, unknown[]];
      expect(updateCall[0]).toContain('"rarity" = $2');
      expect(updateCall[0]).toContain('"updated_at" = now()');
      expect(updateCall[0]).not.toContain('"name_en"');
      expect(updateCall[1]).toEqual([DEFINITION_ID, 'legendary']);
      expect(badge.rarity).toBe('legendary');
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('replaces both languages when a name object is given', async () => {
      const { service, dataSource } = buildHarness([
        [
          READ_DEFINITION_IDENTITY_SQL,
          [{ id: DEFINITION_ID, name_en: 'Champion' }],
        ],
        ['UPDATE "quiz_badge_definitions" SET', [{ id: DEFINITION_ID }]],
        [READ_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]],
      ]);
      await service.update(DEFINITION_ID, { name: { en: 'New name' } });
      const updateCall = dataSource.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).startsWith('UPDATE'),
      ) as [string, unknown[]];
      expect(updateCall[0]).toContain('"name_en" = $2');
      expect(updateCall[0]).toContain('"name_pt" = $3');
      expect(updateCall[0]).not.toContain('"description_en"');
      expect(updateCall[1]).toEqual([DEFINITION_ID, 'New name', null]);
    });

    it('refuses a name another definition uses and leaves the badge alone', async () => {
      const { service, dataSource } = buildHarness([
        [
          READ_DEFINITION_IDENTITY_SQL,
          [{ id: DEFINITION_ID, name_en: 'Champion' }],
        ],
        [ENGLISH_NAME_TAKEN_SQL, [{ found: 1 }]],
      ]);
      await expect(
        service.update(DEFINITION_ID, { name: { en: 'Taken' } }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_name_taken', language: 'en' },
      });
      expect(
        statementsOf(dataSource.query).filter((sql) =>
          sql.startsWith('UPDATE'),
        ),
      ).toHaveLength(0);
      const lookup = dataSource.query.mock.calls.find(
        (call: unknown[]) => call[0] === ENGLISH_NAME_TAKEN_SQL,
      ) as [string, unknown[]];
      expect(lookup[1]).toEqual(['Taken', DEFINITION_ID]);
    });

    it('answers quiz_badge_not_found for a deleted badge before the name checks', async () => {
      const { service, dataSource } = buildHarness([
        [ENGLISH_NAME_TAKEN_SQL, [{ found: 1 }]],
      ]);
      await expect(
        service.update(DEFINITION_ID, { name: { en: 'Taken' } }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_not_found', definitionId: DEFINITION_ID },
      });
      expect(statementsOf(dataSource.query)).toEqual([
        READ_DEFINITION_IDENTITY_SQL,
      ]);
      expect(dataSource.query).toHaveBeenCalledWith(
        READ_DEFINITION_IDENTITY_SQL,
        [DEFINITION_ID],
      );
    });

    it('answers quiz_badge_not_found when the update matches no row', async () => {
      const { service, dataSource } = buildHarness([
        [
          READ_DEFINITION_IDENTITY_SQL,
          [{ id: DEFINITION_ID, name_en: 'Champion' }],
        ],
      ]);
      await expect(
        service.update(DEFINITION_ID, { tint: 'jade' }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_not_found' },
      });
      expect(
        statementsOf(dataSource.query).filter((sql) =>
          sql.startsWith('UPDATE'),
        ),
      ).toHaveLength(1);
    });

    it('refuses a bad tint on a PATCH before any statement runs', async () => {
      const { service, dataSource } = buildHarness();
      await expect(
        service.update(DEFINITION_ID, { tint: 'rose' }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_tint_unknown' },
      });
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('archive and restore', () => {
    it('archives once and writes one audit row', async () => {
      const archivedRow = definitionRow({ archived_at: ARCHIVED_AT });
      const { service, manager, modAudit } = buildHarness(
        [[READ_QUIZ_BADGE_DEFINITION_SQL, [archivedRow]]],
        [
          [
            ARCHIVE_QUIZ_BADGE_DEFINITION_SQL,
            (() => {
              let isFirstCall = true;
              return () => {
                const answer = isFirstCall
                  ? [[{ name_en: 'Champion' }], 1]
                  : [[], 0];
                isFirstCall = false;
                return answer;
              };
            })(),
          ],
        ],
      );
      const first = await service.archive('admin-1', DEFINITION_ID);
      expect(first.isArchived).toBe(true);
      expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'admin-1',
        QUIZ_BADGE_AUDIT_ACTIONS.definitionArchived,
        undefined,
        `Champion (${DEFINITION_ID})`,
        undefined,
        manager,
      );
      await service.archive('admin-1', DEFINITION_ID);
      expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
    });

    it('restores once and writes the restored audit row', async () => {
      const { service, manager, modAudit } = buildHarness(
        [[READ_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]]],
        [[RESTORE_QUIZ_BADGE_DEFINITION_SQL, [[{ name_en: 'Champion' }], 1]]],
      );
      const badge = await service.restore('admin-1', DEFINITION_ID);
      expect(badge.isArchived).toBe(false);
      expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'admin-1',
        QUIZ_BADGE_AUDIT_ACTIONS.definitionRestored,
        undefined,
        `Champion (${DEFINITION_ID})`,
        undefined,
        manager,
      );
    });

    it('answers a live badge restore with no audit row', async () => {
      const { service, modAudit } = buildHarness(
        [[READ_QUIZ_BADGE_DEFINITION_SQL, [definitionRow()]]],
        [[RESTORE_QUIZ_BADGE_DEFINITION_SQL, [[], 0]]],
      );
      await expect(
        service.restore('admin-1', DEFINITION_ID),
      ).resolves.toMatchObject({ id: DEFINITION_ID });
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('answers quiz_badge_not_found for a missing or malformed badge', async () => {
      const { service } = buildHarness();
      await expect(
        service.archive('admin-1', DEFINITION_ID),
      ).rejects.toMatchObject({ response: { code: 'quiz_badge_not_found' } });
      await expect(
        service.restore('admin-1', 'not-a-uuid'),
      ).rejects.toMatchObject({ response: { code: 'quiz_badge_not_found' } });
    });
  });

  describe('remove', () => {
    it('answers quiz_badge_not_found for a malformed id', async () => {
      const { service, dataSource } = buildHarness();
      await expect(
        service.remove('admin-1', 'not-a-uuid'),
      ).rejects.toMatchObject({ response: { code: 'quiz_badge_not_found' } });
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('answers quiz_badge_not_found for a badge that is gone', async () => {
      const { service } = buildHarness();
      await expect(
        service.remove('admin-1', DEFINITION_ID),
      ).rejects.toMatchObject({ response: { code: 'quiz_badge_not_found' } });
    });

    it('refuses to delete a badge someone holds and names the count', async () => {
      const { service, dataSource } = buildHarness([
        [
          READ_DEFINITION_IDENTITY_SQL,
          [{ id: DEFINITION_ID, name_en: 'Champion' }],
        ],
        [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 4, win_count: 6 }]],
      ]);
      await expect(
        service.remove('admin-1', DEFINITION_ID),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_in_use', holderCount: 4 },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('deletes an unused badge under every attached event lock with one detach row per slot', async () => {
      const { service, manager, modAudit } = buildHarness(
        [
          [
            READ_DEFINITION_IDENTITY_SQL,
            [{ id: DEFINITION_ID, name_en: 'Champion' }],
          ],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
        ],
        [
          [
            READ_DEFINITION_EVENT_IDS_SQL,
            [{ event_id: 'event-b' }, { event_id: 'event-a' }],
          ],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
          [
            DELETE_DEFINITION_SLOTS_SQL,
            [
              [
                { event_id: 'event-b', game_number: 1 },
                { event_id: 'event-a', game_number: 2 },
              ],
              2,
            ],
          ],
          [DELETE_QUIZ_BADGE_DEFINITION_SQL, [[{ id: DEFINITION_ID }], 1]],
        ],
      );
      await expect(
        service.remove('admin-1', DEFINITION_ID),
      ).resolves.toBeUndefined();

      const managerCalls = manager.query.mock.calls as [string, unknown[]][];
      const lockCalls = managerCalls.filter(
        (call) => call[0] === QUIZ_EVENT_BADGES_LOCK_SQL,
      );
      expect(lockCalls.map((call) => call[1])).toEqual([
        ['event-a'],
        ['event-b'],
      ]);
      const statements = managerCalls.map((call) => call[0]);
      expect(statements[0]).toBe(QUIZ_BADGE_DELETE_LOCK_SQL);
      expect(statements.indexOf(QUIZ_BADGE_DELETE_LOCK_SQL)).toBeLessThan(
        statements.indexOf(READ_DEFINITION_EVENT_IDS_SQL),
      );
      const lastLockIndex = statements.lastIndexOf(QUIZ_EVENT_BADGES_LOCK_SQL);
      expect(lastLockIndex).toBeLessThan(
        statements.indexOf(DELETE_DEFINITION_SLOTS_SQL),
      );
      expect(statements.indexOf(DELETE_DEFINITION_SLOTS_SQL)).toBeLessThan(
        statements.indexOf(DELETE_DEFINITION_AWARDS_SQL),
      );
      expect(statements.indexOf(DELETE_DEFINITION_AWARDS_SQL)).toBeLessThan(
        statements.indexOf(DELETE_QUIZ_BADGE_DEFINITION_SQL),
      );
      const awardsCall = managerCalls.find(
        (call) => call[0] === DELETE_DEFINITION_AWARDS_SQL,
      );
      expect(awardsCall?.[1]).toEqual([`quiz:${DEFINITION_ID}`]);

      expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(3);
      const auditCalls = modAudit.writeAuditLog.mock.calls as unknown[][];
      expect(auditCalls.map((call) => call[2])).toEqual([
        QUIZ_BADGE_AUDIT_ACTIONS.detached,
        QUIZ_BADGE_AUDIT_ACTIONS.detached,
        QUIZ_BADGE_AUDIT_ACTIONS.definitionDeleted,
      ]);
      expect(auditCalls.map((call) => call[4])).toEqual([
        `Champion (${DEFINITION_ID}), game 2, event event-a`,
        `Champion (${DEFINITION_ID}), game 1, event event-b`,
        `Champion (${DEFINITION_ID})`,
      ]);
      for (const call of auditCalls) {
        expect(call[0]).toBeNull();
        expect(call[1]).toBe('admin-1');
        expect(call[6]).toBe(manager);
      }
    });

    it('locks an event attached while the first locks were being taken before the slot delete', async () => {
      let eventReadCount = 0;
      const { service, manager } = buildHarness(
        [
          [
            READ_DEFINITION_IDENTITY_SQL,
            [{ id: DEFINITION_ID, name_en: 'Champion' }],
          ],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
        ],
        [
          [
            READ_DEFINITION_EVENT_IDS_SQL,
            () => {
              eventReadCount += 1;
              return eventReadCount === 1
                ? [{ event_id: 'event-b' }]
                : [{ event_id: 'event-b' }, { event_id: 'event-a' }];
            },
          ],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
          [DELETE_DEFINITION_SLOTS_SQL, [[], 0]],
          [DELETE_QUIZ_BADGE_DEFINITION_SQL, [[{ id: DEFINITION_ID }], 1]],
        ],
      );
      await service.remove('admin-1', DEFINITION_ID);
      const managerCalls = manager.query.mock.calls as [string, unknown[]][];
      const lockCalls = managerCalls.filter(
        (call) => call[0] === QUIZ_EVENT_BADGES_LOCK_SQL,
      );
      expect(lockCalls.map((call) => call[1])).toEqual([
        ['event-b'],
        ['event-a'],
      ]);
      expect(eventReadCount).toBe(3);
      const statements = managerCalls.map((call) => call[0]);
      expect(statements[0]).toBe(QUIZ_BADGE_DELETE_LOCK_SQL);
      expect(statements.lastIndexOf(QUIZ_EVENT_BADGES_LOCK_SQL)).toBeLessThan(
        statements.indexOf(DELETE_DEFINITION_SLOTS_SQL),
      );
    });

    it('deletes an unattached badge with no lock and only the deleted audit row', async () => {
      const { service, manager, modAudit } = buildHarness(
        [
          [
            READ_DEFINITION_IDENTITY_SQL,
            [{ id: DEFINITION_ID, name_en: 'Champion' }],
          ],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
        ],
        [
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
          [DELETE_DEFINITION_SLOTS_SQL, [[], 0]],
          [DELETE_QUIZ_BADGE_DEFINITION_SQL, [[{ id: DEFINITION_ID }], 1]],
        ],
      );
      await service.remove('admin-1', DEFINITION_ID);
      expect(statementsOf(manager.query)[0]).toBe(QUIZ_BADGE_DELETE_LOCK_SQL);
      expect(statementsOf(manager.query)).not.toContain(
        QUIZ_EVENT_BADGES_LOCK_SQL,
      );
      expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
      expect((modAudit.writeAuditLog.mock.calls as unknown[][])[0]![2]).toBe(
        QUIZ_BADGE_AUDIT_ACTIONS.definitionDeleted,
      );
    });

    it('refuses when a win lands before the locks are held and deletes nothing', async () => {
      const { service, manager, modAudit } = buildHarness(
        [
          [
            READ_DEFINITION_IDENTITY_SQL,
            [{ id: DEFINITION_ID, name_en: 'Champion' }],
          ],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
        ],
        [
          [READ_DEFINITION_EVENT_IDS_SQL, [{ event_id: 'event-a' }]],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 1, win_count: 1 }]],
        ],
      );
      await expect(
        service.remove('admin-1', DEFINITION_ID),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_in_use', holderCount: 1 },
      });
      const statements = statementsOf(manager.query);
      expect(statements).not.toContain(DELETE_DEFINITION_SLOTS_SQL);
      expect(statements).not.toContain(DELETE_QUIZ_BADGE_DEFINITION_SQL);
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('answers quiz_badge_in_use with the holder count read after the rollback when a win blocks the delete', async () => {
      let countReadCount = 0;
      const { service, dataSource, manager, modAudit } = buildHarness(
        [
          [
            READ_DEFINITION_IDENTITY_SQL,
            [{ id: DEFINITION_ID, name_en: 'Champion' }],
          ],
          [
            READ_DEFINITION_WIN_COUNTS_SQL,
            () => {
              countReadCount += 1;
              return countReadCount === 1
                ? [{ holder_count: 0, win_count: 0 }]
                : [{ holder_count: 2, win_count: 3 }];
            },
          ],
        ],
        [
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
          [DELETE_DEFINITION_SLOTS_SQL, [[], 0]],
          [
            DELETE_QUIZ_BADGE_DEFINITION_SQL,
            () => {
              throw Object.assign(new Error('foreign key violation'), {
                driverError: { code: '23503' },
              });
            },
          ],
        ],
      );
      await expect(
        service.remove('admin-1', DEFINITION_ID),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_in_use', holderCount: 2 },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(
        statementsOf(dataSource.query).filter(
          (sql) => sql === READ_DEFINITION_WIN_COUNTS_SQL,
        ),
      ).toHaveLength(2);
      expect(statementsOf(manager.query)).toContain(
        DELETE_QUIZ_BADGE_DEFINITION_SQL,
      );
      const auditCalls = modAudit.writeAuditLog.mock.calls as unknown[][];
      expect(auditCalls.map((call) => call[2])).not.toContain(
        QUIZ_BADGE_AUDIT_ACTIONS.definitionDeleted,
      );
    });

    it('rethrows a definition delete error that is not a foreign key violation', async () => {
      const writeError = Object.assign(new Error('connection lost'), {
        code: '08006',
      });
      const { service, dataSource } = buildHarness(
        [
          [
            READ_DEFINITION_IDENTITY_SQL,
            [{ id: DEFINITION_ID, name_en: 'Champion' }],
          ],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
        ],
        [
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
          [
            DELETE_QUIZ_BADGE_DEFINITION_SQL,
            () => {
              throw writeError;
            },
          ],
        ],
      );
      await expect(service.remove('admin-1', DEFINITION_ID)).rejects.toBe(
        writeError,
      );
      expect(
        statementsOf(dataSource.query).filter(
          (sql) => sql === READ_DEFINITION_WIN_COUNTS_SQL,
        ),
      ).toHaveLength(1);
    });

    it('answers quiz_badge_not_found when the delete matches no row', async () => {
      const { service, modAudit } = buildHarness(
        [
          [
            READ_DEFINITION_IDENTITY_SQL,
            [{ id: DEFINITION_ID, name_en: 'Champion' }],
          ],
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
        ],
        [
          [READ_DEFINITION_WIN_COUNTS_SQL, [{ holder_count: 0, win_count: 0 }]],
          [DELETE_QUIZ_BADGE_DEFINITION_SQL, [[], 0]],
        ],
      );
      await expect(
        service.remove('admin-1', DEFINITION_ID),
      ).rejects.toMatchObject({ response: { code: 'quiz_badge_not_found' } });
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });
  });
});
