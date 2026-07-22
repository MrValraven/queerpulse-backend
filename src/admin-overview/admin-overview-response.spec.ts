import {
  reasonCodeToCategoryIndex,
  medianHours,
  bucketResponseTimes,
} from './admin-overview-response';

describe('reasonCodeToCategoryIndex', () => {
  it('maps known reason codes to their stacking index', () => {
    expect(reasonCodeToCategoryIndex('outing')).toBe(0);
    expect(reasonCodeToCategoryIndex('harassment')).toBe(1);
    expect(reasonCodeToCategoryIndex('spam')).toBe(2);
  });

  it('aggregates any other real reason code into the "Other" slot', () => {
    expect(reasonCodeToCategoryIndex('doxxing')).toBe(3);
  });

  it('aggregates the literal "other" code into the "Other" slot', () => {
    expect(reasonCodeToCategoryIndex('other')).toBe(3);
  });
});

describe('medianHours', () => {
  it('returns null for an empty set', () => {
    expect(medianHours([])).toBeNull();
  });

  it('returns the middle value', () => {
    expect(medianHours([1, 3, 5])).toBe(3);
  });

  it('averages the two middle values for an even-sized set', () => {
    expect(medianHours([1, 2, 3, 4])).toBe(2.5);
  });

  it('does not mutate the input array', () => {
    const hoursDeltas = [5, 1, 3];
    medianHours(hoursDeltas);
    expect(hoursDeltas).toEqual([5, 1, 3]);
  });
});

describe('bucketResponseTimes', () => {
  it('bins deltas into six fixed buckets and flags over-SLA', () => {
    const buckets = bucketResponseTimes([0.5, 1.5, 7]);
    expect(buckets).toHaveLength(6);
    expect(buckets[0]).toEqual({ label: '<1h', value: 1, overSla: false });
    expect(buckets[4]).toEqual({ label: '6–8h', value: 1, overSla: true });
  });

  it('produces empty buckets for an empty set', () => {
    const buckets = bucketResponseTimes([]);
    expect(buckets.every((bucket) => bucket.value === 0)).toBe(true);
  });

  it('places a value exactly at a boundary into the higher bucket', () => {
    const buckets = bucketResponseTimes([2]);
    expect(buckets[1]).toEqual({ label: '1–2h', value: 0, overSla: false });
    expect(buckets[2]).toEqual({ label: '2–4h', value: 1, overSla: false });
  });

  it('treats exactly 8 hours as over-SLA in the last bucket', () => {
    const buckets = bucketResponseTimes([8]);
    expect(buckets[5]).toEqual({ label: '8h+', value: 1, overSla: true });
  });
});
