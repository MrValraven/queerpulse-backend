import {
  IdentityKind,
  isOwnedIdentityKind,
  ownerColumnForKind,
} from './identity.entity';

describe('ownerColumnForKind', () => {
  it('maps every kind to its own owner column', () => {
    expect(ownerColumnForKind(IdentityKind.Profile)).toBe('userId');
    expect(ownerColumnForKind(IdentityKind.Subprofile)).toBe('subprofileId');
    expect(ownerColumnForKind(IdentityKind.Listing)).toBe('listingId');
    expect(ownerColumnForKind(IdentityKind.Company)).toBe('companyId');
  });

  it('covers every owned kind, so a new kind fails here first', () => {
    const ownedKinds = Object.values(IdentityKind).filter(isOwnedIdentityKind);
    const covered = ownedKinds.map(ownerColumnForKind);
    expect(new Set(covered).size).toBe(ownedKinds.length);
  });

  it('leaves only the QueerPulse Team without an owner', () => {
    expect(
      Object.values(IdentityKind).filter((kind) => !isOwnedIdentityKind(kind)),
    ).toEqual([IdentityKind.Official]);
  });
});
