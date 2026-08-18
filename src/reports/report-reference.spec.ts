import { formatReportReference } from './report-reference';

describe('formatReportReference', () => {
  it('is deterministic: the same report yields the same reference every call', () => {
    const report = {
      id: 'a1b2c3d4-0000-0000-0000-000000000000',
      createdAt: new Date('2026-01-14T12:00:00.000Z'),
    };

    const first = formatReportReference(report);
    const second = formatReportReference(report);

    expect(first).toBe(second);
    expect(first).toBe('QPR-2026-A1B2');
  });

  it('uses the UTC year of createdAt as the prefix, so different years produce different prefixes', () => {
    const sharedId = 'ffeeddcc-0000-0000-0000-000000000000';

    const reference2025 = formatReportReference({
      id: sharedId,
      createdAt: new Date('2025-06-01T00:00:00.000Z'),
    });
    const reference2026 = formatReportReference({
      id: sharedId,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(reference2025).toBe('QPR-2025-FFEE');
    expect(reference2026).toBe('QPR-2026-FFEE');
    expect(reference2025).not.toBe(reference2026);
  });

  it('uppercases the short hex segment taken from the id', () => {
    const reference = formatReportReference({
      id: 'deadbeef-0000-0000-0000-000000000000',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    expect(reference).toBe('QPR-2026-DEAD');
  });

  it('produces distinct references for distinct ids in the same year', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');

    const referenceOne = formatReportReference({
      id: 'aaaa1111-0000-0000-0000-000000000000',
      createdAt,
    });
    const referenceTwo = formatReportReference({
      id: 'bbbb2222-0000-0000-0000-000000000000',
      createdAt,
    });

    expect(referenceOne).not.toBe(referenceTwo);
  });
});
