import type { EntityManager } from 'typeorm';
import * as launchedFeatures from '../launchedFeatures';
import {
  EVENT_QUIZSHOW_SUMMARY_SQL,
  eventHasAdultsRounds,
  readEventQuizshowSummary,
} from './quizshow-event-reads';
import { QUIZSHOW_LIMITS } from './quizshow.contract';

type SummaryRow = {
  has_quiz: boolean;
  join_code: string | null;
  is_idle: boolean;
  is_barred: boolean;
  has_viewable_results: boolean;
};

function buildFakeManager(rows: unknown[]) {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
}

const baseInput = {
  eventId: 'event-1',
  hostUserId: 'host-1',
  viewerId: 'viewer-1',
  isOrganizer: false,
  hasGoingRsvp: false,
  now: new Date('2026-10-19T20:00:00.000Z'),
};

const liveRow: SummaryRow = {
  has_quiz: true,
  join_code: 'ABC234',
  is_idle: false,
  is_barred: false,
  has_viewable_results: false,
};

describe('quizshow event reads', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('readEventQuizshowSummary', () => {
    it('returns null and runs nothing while the feature is hidden', async () => {
      jest.spyOn(launchedFeatures, 'isFeatureLaunched').mockReturnValue(false);
      const { manager, query } = buildFakeManager([liveRow]);
      await expect(
        readEventQuizshowSummary(manager, baseInput),
      ).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    describe('while the feature is launched', () => {
      beforeEach(() => {
        jest.spyOn(launchedFeatures, 'isFeatureLaunched').mockReturnValue(true);
      });

      it('shows the live code of an active session', async () => {
        const { manager, query } = buildFakeManager([liveRow]);
        const detail = await readEventQuizshowSummary(manager, baseInput);
        expect(detail).toEqual({
          hasQuiz: true,
          liveSessionCode: 'ABC234',
          hasResults: false,
        });
        expect(query).toHaveBeenCalledTimes(1);
        const [sql, params] = query.mock.calls[0] as [string, unknown[]];
        expect(sql).toBe(EVENT_QUIZSHOW_SUMMARY_SQL);
        const expectedCutoff = new Date(
          baseInput.now.getTime() - QUIZSHOW_LIMITS.abandonAfterMs,
        );
        expect(params).toEqual([
          'event-1',
          'host-1',
          'viewer-1',
          false,
          false,
          expectedCutoff,
        ]);
      });

      it('hides the code of an idle lobby or an idle pause', async () => {
        const { manager } = buildFakeManager([{ ...liveRow, is_idle: true }]);
        const detail = await readEventQuizshowSummary(manager, baseInput);
        expect(detail?.liveSessionCode).toBeNull();
        expect(detail?.hasQuiz).toBe(true);
      });

      it('hides the code from a barred viewer', async () => {
        const { manager } = buildFakeManager([{ ...liveRow, is_barred: true }]);
        const detail = await readEventQuizshowSummary(manager, baseInput);
        expect(detail?.liveSessionCode).toBeNull();
      });

      it('a barred guest sees no results card', async () => {
        const { manager } = buildFakeManager([
          { ...liveRow, is_barred: true, has_viewable_results: true },
        ]);
        const detail = await readEventQuizshowSummary(manager, {
          ...baseInput,
          hasGoingRsvp: true,
        });
        expect(detail?.hasResults).toBe(false);
        expect(detail?.hasQuiz).toBe(true);
      });

      it('reports results only to viewers who may open them', async () => {
        const allowed = buildFakeManager([
          { ...liveRow, has_viewable_results: true },
        ]);
        const allowedDetail = await readEventQuizshowSummary(allowed.manager, {
          ...baseInput,
          isOrganizer: true,
          hasGoingRsvp: true,
        });
        expect(allowedDetail?.hasResults).toBe(true);
        expect(allowed.query.mock.calls[0][1]).toEqual(
          expect.arrayContaining([true, true]),
        );

        const refused = buildFakeManager([
          { ...liveRow, has_viewable_results: false },
        ]);
        const refusedDetail = await readEventQuizshowSummary(
          refused.manager,
          baseInput,
        );
        expect(refusedDetail?.hasResults).toBe(false);
      });

      it('keeps the live code for an organiser with a ban or block row', async () => {
        const { manager, query } = buildFakeManager([liveRow]);
        const detail = await readEventQuizshowSummary(manager, {
          ...baseInput,
          isOrganizer: true,
        });
        expect(detail?.liveSessionCode).toBe('ABC234');
        const [sql, params] = query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('NOT $4::boolean');
        expect(params[3]).toBe(true);
      });

      it('falls back to an empty summary when no row comes back', async () => {
        const { manager } = buildFakeManager([]);
        await expect(
          readEventQuizshowSummary(manager, baseInput),
        ).resolves.toEqual({
          hasQuiz: false,
          liveSessionCode: null,
          hasResults: false,
        });
      });

      it('passes a null host through so no block check can match', async () => {
        const { manager, query } = buildFakeManager([liveRow]);
        await readEventQuizshowSummary(manager, {
          ...baseInput,
          hostUserId: null,
        });
        expect((query.mock.calls[0] as [string, unknown[]])[1][1]).toBeNull();
      });
    });
  });

  describe('eventHasAdultsRounds', () => {
    it('finds an adults round', async () => {
      const { manager, query } = buildFakeManager([{ exists: true }]);
      await expect(eventHasAdultsRounds(manager, 'event-1')).resolves.toBe(
        true,
      );
      expect(query.mock.calls[0][1]).toEqual(['event-1']);
    });

    it('reports false when no round carries the adults label', async () => {
      const { manager } = buildFakeManager([{ exists: false }]);
      await expect(eventHasAdultsRounds(manager, 'event-1')).resolves.toBe(
        false,
      );
    });
  });
});
