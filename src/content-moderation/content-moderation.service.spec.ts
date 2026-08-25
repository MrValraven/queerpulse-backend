import { EntityManager, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { ContentModerationService } from './content-moderation.service';
import { ContentModeration } from './entities/content-moderation.entity';

// Chainable insert-builder stub that records the `values` and `orUpdate`
// arguments so the idempotent-upsert shape can be asserted.
function insertQbStub() {
  const calls: {
    values?: Record<string, unknown>;
    orUpdateColumns?: string[];
    orUpdateConflict?: string[];
  } = {};
  const qb: Record<string, jest.Mock> = {};
  qb.insert = jest.fn().mockReturnValue(qb);
  qb.into = jest.fn().mockReturnValue(qb);
  qb.values = jest.fn((value: Record<string, unknown>) => {
    calls.values = value;
    return qb;
  });
  qb.orUpdate = jest.fn((columns: string[], conflict: string[]) => {
    calls.orUpdateColumns = columns;
    calls.orUpdateConflict = conflict;
    return qb;
  });
  qb.execute = jest.fn().mockResolvedValue(undefined);
  return { qb, calls };
}

function build() {
  const states = { findOne: jest.fn(), find: jest.fn() };
  const service = new ContentModerationService(states as never);
  return { service, states };
}

function moderationRow(
  overrides: Partial<ContentModeration>,
): ContentModeration {
  return {
    subjectType: 'post',
    subjectId: 'p1',
    hiddenAt: null,
    removedAt: null,
    ...overrides,
  } as ContentModeration;
}

describe('ContentModerationService', () => {
  describe('applyAction', () => {
    it('hide_content stamps hidden only and never lists removed_at in the upsert', async () => {
      const { service } = build();
      const { qb, calls } = insertQbStub();
      const manager = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as EntityManager;

      await service.applyAction(manager, {
        subjectType: 'post',
        subjectId: 'p1',
        action: 'hide_content',
        actorId: 'mod-1',
      });

      expect(calls.values?.hiddenAt).toBeInstanceOf(Date);
      expect(calls.values?.removedAt).toBeNull();
      expect(calls.orUpdateColumns).not.toContain('removed_at');
      expect(calls.orUpdateConflict).toEqual(['subject_type', 'subject_id']);
      expect(qb.execute).toHaveBeenCalledTimes(1);
    });

    it('remove_content escalates to removed and re-asserts hidden too', async () => {
      const { service } = build();
      const { qb, calls } = insertQbStub();
      const manager = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as EntityManager;

      await service.applyAction(manager, {
        subjectType: 'post',
        subjectId: 'p1',
        action: 'remove_content',
        actorId: 'mod-1',
      });

      expect(calls.values?.removedAt).toBeInstanceOf(Date);
      expect(calls.values?.hiddenAt).toBeInstanceOf(Date);
      expect(calls.orUpdateColumns).toContain('removed_at');
      expect(calls.orUpdateColumns).toContain('hidden_at');
    });
  });

  describe('stateFor', () => {
    it('returns the fully-visible default when no row exists', async () => {
      const { service, states } = build();
      states.findOne.mockResolvedValue(null);

      await expect(service.stateFor('post', 'p1')).resolves.toEqual({
        hidden: false,
        removed: false,
      });
    });

    it('reads hidden/removed from the row timestamps', async () => {
      const { service, states } = build();
      states.findOne.mockResolvedValue(
        moderationRow({ hiddenAt: new Date(), removedAt: new Date() }),
      );

      await expect(service.stateFor('post', 'p1')).resolves.toEqual({
        hidden: true,
        removed: true,
      });
    });
  });

  describe('statesForAnyType', () => {
    it('short-circuits with an empty map for empty inputs (no query)', async () => {
      const { service, states } = build();

      await expect(service.statesForAnyType(['post'], [])).resolves.toEqual(
        new Map(),
      );
      await expect(service.statesForAnyType([], ['p1'])).resolves.toEqual(
        new Map(),
      );
      expect(states.find).not.toHaveBeenCalled();
    });

    it('takes the strongest state per subject id (removed beats hidden)', async () => {
      const { service, states } = build();
      states.find.mockResolvedValue([
        moderationRow({
          subjectId: 'p1',
          hiddenAt: new Date(),
          removedAt: null,
        }),
        moderationRow({
          subjectId: 'p1',
          hiddenAt: new Date(),
          removedAt: new Date(),
        }),
      ]);

      const result = await service.statesForAnyType(
        ['post', 'reply'],
        ['p1', 'p1'],
      );

      expect(result.get('p1')).toEqual({ hidden: true, removed: true });
    });
  });

  describe('revert', () => {
    it('deletes the state row via the caller manager', async () => {
      const { service } = build();
      // Held as its own binding rather than asserted through `manager.delete`:
      // reading a method off the cast object detaches it from its receiver,
      // which is exactly what `@typescript-eslint/unbound-method` guards.
      const deleteMock = jest.fn().mockResolvedValue(undefined);
      const manager = { delete: deleteMock } as unknown as EntityManager;

      await service.revert(manager, 'post', 'p1');

      expect(deleteMock).toHaveBeenCalledWith(ContentModeration, {
        subjectType: 'post',
        subjectId: 'p1',
      });
    });
  });

  describe('excludeHidden', () => {
    it('appends a NOT EXISTS predicate bound to the subject types and returns the builder', () => {
      const { service } = build();
      // A typed `andWhere` stub so `.mock.calls[0]` destructures into its real
      // `(sql: string, params: Record<string, unknown>)` shape instead of
      // `any` — the query builder itself is otherwise unused, hence `as
      // unknown as SelectQueryBuilder<ObjectLiteral>` rather than a full mock.
      const andWhere = jest.fn<
        SelectQueryBuilder<ObjectLiteral>,
        [string, Record<string, unknown>]
      >();
      const qb = { andWhere } as unknown as SelectQueryBuilder<ObjectLiteral>;
      andWhere.mockReturnValue(qb);

      const returned = service.excludeHidden(qb, ['post', 'reply'], '"p"."id"');

      expect(returned).toBe(qb);
      const [sql, params] = andWhere.mock.calls[0]!;
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('"p"."id"::text');
      expect(params).toEqual({
        moderationFilterSubjectTypes: ['post', 'reply'],
      });
    });
  });
});
