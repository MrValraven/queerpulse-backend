import { IdentityKind, ownerColumnForKind } from './identity.entity';

describe('ownerColumnForKind', () => {
  it('maps every kind to its own owner column', () => {
    expect(ownerColumnForKind(IdentityKind.Profile)).toBe('userId');
    expect(ownerColumnForKind(IdentityKind.Subprofile)).toBe('subprofileId');
    expect(ownerColumnForKind(IdentityKind.Listing)).toBe('listingId');
    expect(ownerColumnForKind(IdentityKind.Company)).toBe('companyId');
  });

  it('covers every enum member, so a new kind fails here first', () => {
    const covered = Object.values(IdentityKind).map(ownerColumnForKind);
    expect(new Set(covered).size).toBe(Object.values(IdentityKind).length);
  });
});
