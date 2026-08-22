import { effectiveCardStatus } from './card-status';
import { MembershipCardStatus } from './entities/membership-card.entity';

const base = {
  status: MembershipCardStatus.Active,
  expiresAt: null,
  programEnabled: true,
  communityFrozenAt: null,
  communityArchivedAt: null,
  now: new Date('2026-08-22T12:00:00Z'),
};

describe('effectiveCardStatus', () => {
  it('is active for a healthy card with no expiry', () => {
    expect(effectiveCardStatus(base)).toBe('active');
  });

  it('is active before its expiry date', () => {
    expect(
      effectiveCardStatus({
        ...base,
        expiresAt: new Date('2026-09-01T00:00:00Z'),
      }),
    ).toBe('active');
  });

  it('is expired once the expiry has passed', () => {
    expect(
      effectiveCardStatus({
        ...base,
        expiresAt: new Date('2026-08-01T00:00:00Z'),
      }),
    ).toBe('expired');
  });

  it('is revoked when the card itself is revoked', () => {
    expect(
      effectiveCardStatus({ ...base, status: MembershipCardStatus.Revoked }),
    ).toBe('revoked');
  });

  it('is suspended when the card itself is suspended', () => {
    expect(
      effectiveCardStatus({ ...base, status: MembershipCardStatus.Suspended }),
    ).toBe('suspended');
  });

  // Spec §L.2
  it('is suspended while the issuing community is frozen', () => {
    expect(
      effectiveCardStatus({
        ...base,
        communityFrozenAt: new Date('2026-08-20T00:00:00Z'),
      }),
    ).toBe('suspended');
  });

  it('is revoked when the issuing community is archived', () => {
    expect(
      effectiveCardStatus({
        ...base,
        communityArchivedAt: new Date('2026-08-20T00:00:00Z'),
      }),
    ).toBe('revoked');
  });

  it('is suspended when the programme has been turned off', () => {
    expect(effectiveCardStatus({ ...base, programEnabled: false })).toBe(
      'suspended',
    );
  });

  it('prefers revoked over every softer state', () => {
    expect(
      effectiveCardStatus({
        ...base,
        status: MembershipCardStatus.Revoked,
        expiresAt: new Date('2026-08-01T00:00:00Z'),
        programEnabled: false,
        communityFrozenAt: new Date('2026-08-20T00:00:00Z'),
      }),
    ).toBe('revoked');
  });

  it('prefers archived-revoked over a frozen suspension', () => {
    expect(
      effectiveCardStatus({
        ...base,
        communityFrozenAt: new Date('2026-08-20T00:00:00Z'),
        communityArchivedAt: new Date('2026-08-21T00:00:00Z'),
      }),
    ).toBe('revoked');
  });
});
