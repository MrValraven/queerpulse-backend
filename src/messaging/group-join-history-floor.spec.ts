import { EntityManager } from 'typeorm';
import {
  groupJoinHistoryFloorCoversPredicate,
  isCoveredByGroupJoinHistoryFloor,
  readGroupJoinHistoryFloor,
  withJoinFlooredReplyQuote,
} from './group-join-history-floor';
import { MessageResponse } from './message-response';

// PRD-400 (owner decision 2026-09-29): a new group seat reads history from
// its join onward.
describe('group join history floor (PRD-400)', () => {
  describe('readGroupJoinHistoryFloor', () => {
    it('reads the transaction clock, whole milliseconds, one millisecond early', async () => {
      const floorInstant = new Date('2026-03-01T10:00:00.122Z');
      const query = jest.fn().mockResolvedValue([{ floorInstant }]);

      const result = await readGroupJoinHistoryFloor({
        query,
      } as unknown as EntityManager);

      expect(result).toBe(floorInstant);
      const [sql] = query.mock.calls[0] as [string];
      // `now()` is the transaction start, the same instant the join pill's
      // `created_at` default takes, so the pill lands after the floor.
      expect(sql).toContain("date_trunc('milliseconds', now())");
      expect(sql).toContain("- interval '1 millisecond'");
      expect(sql).toContain('AS "floorInstant"');
    });

    it('throws when the database returns no row', async () => {
      const query = jest.fn().mockResolvedValue([]);

      await expect(
        readGroupJoinHistoryFloor({ query } as unknown as EntityManager),
      ).rejects.toThrow('The database returned no clock reading');
    });
  });

  describe('groupJoinHistoryFloorCoversPredicate', () => {
    it('covers rows at or before the seat floor, in group conversations alone', () => {
      const sql = groupJoinHistoryFloorCoversPredicate(
        'parent.created_at',
        'seat',
      );

      expect(sql).toContain('seat.history_floor_at IS NOT NULL');
      expect(sql).toContain('parent.created_at <= seat.history_floor_at');
      expect(sql).toContain('"join_floor_group"."id" = seat.conversation_id');
      expect(sql).toContain('"join_floor_group"."kind" = \'group\'');
    });

    it('never reads cleared_at, so a personal clear chat keeps its quotes', () => {
      expect(
        groupJoinHistoryFloorCoversPredicate('parent.created_at', 'seat'),
      ).not.toContain('cleared_at');
    });
  });

  describe('isCoveredByGroupJoinHistoryFloor', () => {
    const joinFloor = new Date('2026-03-01T10:00:00.122Z');

    it('covers a row at or before the floor of a group seat', () => {
      const groupSeat = {
        historyFloorAt: joinFloor,
        isGroupConversation: true,
      };

      expect(isCoveredByGroupJoinHistoryFloor(joinFloor, groupSeat)).toBe(true);
      expect(
        isCoveredByGroupJoinHistoryFloor(
          new Date('2026-03-01T09:00:00.000Z'),
          groupSeat,
        ),
      ).toBe(true);
      expect(
        isCoveredByGroupJoinHistoryFloor(
          new Date('2026-03-01T10:00:00.123Z'),
          groupSeat,
        ),
      ).toBe(false);
    });

    it('covers nothing for a seat with no floor or a direct thread seat', () => {
      const earlier = new Date('2026-03-01T09:00:00.000Z');

      expect(
        isCoveredByGroupJoinHistoryFloor(earlier, {
          historyFloorAt: null,
          isGroupConversation: true,
        }),
      ).toBe(false);
      expect(
        isCoveredByGroupJoinHistoryFloor(earlier, {
          historyFloorAt: joinFloor,
          isGroupConversation: false,
        }),
      ).toBe(false);
    });
  });

  describe('withJoinFlooredReplyQuote', () => {
    const baseResponse = {
      id: 'm2',
      body: 'Agreed!',
      replyTo: {
        id: 'm1',
        snippet: 'The pre-join message',
        senderName: 'Alex Doe',
        senderIsFormerMember: false,
        deleted: false,
        kind: 'image',
        thumbnailUrl: 'https://api.test/files/message-images/u/k.jpg',
        fileName: null,
      },
    } as unknown as MessageResponse;

    it('renders the quote as the unavailable, missing-parent quote', () => {
      const result = withJoinFlooredReplyQuote(baseResponse);

      expect(result.replyTo).toEqual({
        id: 'm1',
        snippet: '',
        senderName: 'Someone',
        senderIsFormerMember: false,
        deleted: true,
        kind: 'user',
        thumbnailUrl: null,
        fileName: null,
      });
      expect(result.body).toBe('Agreed!');
    });

    it('leaves the original response untouched', () => {
      withJoinFlooredReplyQuote(baseResponse);

      expect(baseResponse.replyTo?.thumbnailUrl).toBe(
        'https://api.test/files/message-images/u/k.jpg',
      );
    });

    it('returns a message that quotes nothing as it came', () => {
      const plain = { id: 'm3', replyTo: null } as unknown as MessageResponse;

      expect(withJoinFlooredReplyQuote(plain)).toBe(plain);
    });
  });
});
