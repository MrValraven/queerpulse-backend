import {
  SMALL_COUNT_FLOOR,
  categoryForReasonCode,
  suppressBreakdown,
  suppressCount,
} from './transparency-response';

describe('transparency disclosure control', () => {
  describe('suppressCount', () => {
    it('publishes zero as zero', () => {
      expect(suppressCount(0)).toEqual({ value: 0, isSuppressed: false });
    });

    it('withholds anything under the floor', () => {
      for (let count = 1; count < SMALL_COUNT_FLOOR; count += 1) {
        expect(suppressCount(count)).toEqual({
          value: null,
          isSuppressed: true,
        });
      }
    });

    it('publishes the floor itself and anything above it', () => {
      expect(suppressCount(SMALL_COUNT_FLOOR)).toEqual({
        value: SMALL_COUNT_FLOOR,
        isSuppressed: false,
      });
      expect(suppressCount(41)).toEqual({ value: 41, isSuppressed: false });
    });
  });

  describe('suppressBreakdown', () => {
    it('leaves a breakdown with no small buckets untouched', () => {
      const rows = suppressBreakdown([
        { key: 'a', count: 12 },
        { key: 'b', count: 7 },
        { key: 'c', count: 0 },
      ]);
      expect(rows.map((row) => row.count.value)).toEqual([12, 7, 0]);
    });

    it('withholds a second bucket so one hidden count cannot be subtracted out', () => {
      // Total 20. Without the second withholding a reader computes 20 - 12 - 6
      // = 2 and recovers the hidden bucket exactly.
      const rows = suppressBreakdown([
        { key: 'a', count: 12 },
        { key: 'b', count: 6 },
        { key: 'c', count: 2 },
      ]);
      expect(rows.map((row) => row.count.isSuppressed)).toEqual([
        false,
        true,
        true,
      ]);
    });

    it('picks the smallest remaining positive bucket as the second withholding', () => {
      const rows = suppressBreakdown([
        { key: 'a', count: 30 },
        { key: 'b', count: 9 },
        { key: 'c', count: 3 },
        { key: 'd', count: 0 },
      ]);
      expect(rows.map((row) => row.count.value)).toEqual([30, null, null, 0]);
    });

    it('does not sacrifice a second bucket when two are already withheld', () => {
      const rows = suppressBreakdown([
        { key: 'a', count: 30 },
        { key: 'b', count: 9 },
        { key: 'c', count: 3 },
        { key: 'd', count: 1 },
      ]);
      expect(rows.map((row) => row.count.value)).toEqual([30, 9, null, null]);
    });

    it('withholds the lone small bucket when every other bucket is zero', () => {
      const rows = suppressBreakdown([
        { key: 'a', count: 3 },
        { key: 'b', count: 0 },
      ]);
      expect(rows.map((row) => row.count.value)).toEqual([null, 0]);
    });
  });

  describe('categoryForReasonCode', () => {
    it('maps the identity-harm codes to the privacy category', () => {
      expect(categoryForReasonCode('outing')).toBe('privacy');
      expect(categoryForReasonCode('doxxing')).toBe('privacy');
    });

    it('folds an unmapped or system-filed code into other rather than throwing', () => {
      expect(categoryForReasonCode('listing_dispute')).toBe('other');
      expect(categoryForReasonCode('a_code_added_next_year')).toBe('other');
    });
  });
});
