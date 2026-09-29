import { UserStatus } from '../users/entities/user.entity';
import { effectiveCardStatus } from './card-status';
import { MembershipCardStatus } from './entities/membership-card.entity';

const base = {
  status: MembershipCardStatus.Active,
  expiresAt: null,
  programEnabled: true,
  communityFrozenAt: null,
  communityArchivedAt: null,
  // Most cases below are not about the holder account; `null` matches a
  // caller with a reason not to gate on it (see the dedicated cases further
  // down for a door reading a real status).
  holderStatus: null,
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

  it('stays active for a holder whose account is active', () => {
    expect(
      effectiveCardStatus({ ...base, holderStatus: UserStatus.Active }),
    ).toBe('active');
  });

  it('stays active when the caller did not read the holder account', () => {
    expect(effectiveCardStatus({ ...base, holderStatus: null })).toBe('active');
  });

  it.each([UserStatus.Suspended, UserStatus.Deactivated])(
    'is suspended while the holder account is %s',
    (holderStatus) => {
      expect(effectiveCardStatus({ ...base, holderStatus })).toBe('suspended');
    },
  );

  it('prefers suspended for a non-active holder over an expired term', () => {
    expect(
      effectiveCardStatus({
        ...base,
        holderStatus: UserStatus.Suspended,
        expiresAt: new Date('2026-08-01T00:00:00Z'),
      }),
    ).toBe('suspended');
  });

  it('keeps a revoked card revoked whatever the holder account says', () => {
    expect(
      effectiveCardStatus({
        ...base,
        status: MembershipCardStatus.Revoked,
        holderStatus: UserStatus.Suspended,
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
