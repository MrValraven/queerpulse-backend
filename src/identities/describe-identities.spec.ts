import { In } from 'typeorm';
import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';

/**
 * Fix round 1 (Task 11): `IdentitiesService.describeIdentities`, the batch
 * method that resolves an identity's OWN display name, handle and avatar
 * from whichever entity actually owns those fields for its kind, so
 * `MessageResponse.sender`/`ConversationResponse.otherParticipant` can show
 * a business as itself instead of falling back to the staff member's own
 * profile.
 */
function makeService() {
  const identities = { find: jest.fn().mockResolvedValue([]) };
  const listings = { find: jest.fn().mockResolvedValue([]) };
  const subprofiles = { find: jest.fn().mockResolvedValue([]) };
  const companies = { find: jest.fn().mockResolvedValue([]) };
  const profiles = { find: jest.fn().mockResolvedValue([]) };
  const service = new IdentitiesService(
    identities as never,
    listings as never,
    {} as never, // listingCoManagers, unused here
    subprofiles as never,
    {} as never, // subprofileMembers, unused here
    companies as never,
    {} as never, // companyTeamMembers, unused here
    profiles as never,
    {} as never, // participants, unused here (Task 15's mailbox list)
    {} as never, // preferences, unused here (Task 20's attribution switches)
    {} as never, // users, read only by the QueerPulse Team mailbox
  );
  return { service, identities, listings, subprofiles, companies, profiles };
}

describe('IdentitiesService.describeIdentities', () => {
  it('resolves each kind from its own natural display fields', async () => {
    const { service, identities, listings, subprofiles, companies, profiles } =
      makeService();
    identities.find.mockResolvedValue([
      {
        id: 'identity-profile',
        kind: IdentityKind.Profile,
        userId: 'user-1',
        listingId: null,
        subprofileId: null,
        companyId: null,
      },
      {
        id: 'identity-listing',
        kind: IdentityKind.Listing,
        userId: null,
        listingId: 'listing-1',
        subprofileId: null,
        companyId: null,
      },
      {
        id: 'identity-subprofile',
        kind: IdentityKind.Subprofile,
        userId: null,
        listingId: null,
        subprofileId: 'subprofile-1',
        companyId: null,
      },
      {
        id: 'identity-company',
        kind: IdentityKind.Company,
        userId: null,
        listingId: null,
        subprofileId: null,
        companyId: 'company-1',
      },
    ]);
    profiles.find.mockResolvedValue([
      {
        userId: 'user-1',
        firstName: 'Ana',
        lastName: 'Silva',
        slug: 'ana-silva',
        avatarUrl: 'https://example.test/profile-key.jpg',
        photoVisible: true,
      },
    ]);
    listings.find.mockResolvedValue([
      {
        id: 'listing-1',
        name: 'Cafe Lisboa',
        slug: 'cafe-lisboa',
        photoGallery: [
          {
            image: 'https://example.test/cafe-cover.jpg',
            alt: 'Storefront',
            caption: '',
          },
        ],
      },
    ]);
    subprofiles.find.mockResolvedValue([
      {
        id: 'subprofile-1',
        kind: 'writer',
        displayName: 'Night Owl',
        handle: 'night-owl',
        avatarUrl: 'https://example.test/owl-key.jpg',
      },
    ]);
    companies.find.mockResolvedValue([
      { id: 'company-1', nameText: 'Acme Co', slug: 'acme-co' },
    ]);

    const result = await service.describeIdentities([
      'identity-profile',
      'identity-listing',
      'identity-subprofile',
      'identity-company',
    ]);

    expect(result.get('identity-profile')).toEqual({
      displayName: 'Ana Silva',
      handle: 'ana-silva',
      avatarUrl: 'https://example.test/profile-key.jpg',
    });
    expect(result.get('identity-listing')).toEqual({
      displayName: 'Cafe Lisboa',
      handle: 'cafe-lisboa',
      avatarUrl: 'https://example.test/cafe-cover.jpg',
    });
    expect(result.get('identity-subprofile')).toEqual({
      displayName: 'Night Owl',
      handle: 'night-owl',
      avatarUrl: 'https://example.test/owl-key.jpg',
      personaKind: 'writer',
    });
    // Company: permanently no avatar column, so this is exactly null, never
    // a placeholder.
    expect(result.get('identity-company')).toEqual({
      displayName: 'Acme Co',
      handle: 'acme-co',
      avatarUrl: null,
    });
  });

  it('honours a hidden profile photo the same way the existing author-summary path does', async () => {
    const { service, identities, profiles } = makeService();
    identities.find.mockResolvedValue([
      {
        id: 'identity-profile',
        kind: IdentityKind.Profile,
        userId: 'user-1',
        listingId: null,
        subprofileId: null,
        companyId: null,
      },
    ]);
    profiles.find.mockResolvedValue([
      {
        userId: 'user-1',
        firstName: 'Ana',
        lastName: 'Silva',
        slug: 'ana-silva',
        avatarUrl: 'https://example.test/profile-key.jpg',
        photoVisible: false,
      },
    ]);

    const result = await service.describeIdentities(['identity-profile']);

    expect(result.get('identity-profile')?.avatarUrl).toBeNull();
  });

  it('issues one identity-kind lookup plus one query per kind present, never one per identity', async () => {
    const { service, identities, listings, subprofiles, companies, profiles } =
      makeService();
    // Two identities of the SAME kind (Listing), so a correct implementation
    // still issues exactly one `listings.find` for both together.
    identities.find.mockResolvedValue([
      {
        id: 'identity-profile',
        kind: IdentityKind.Profile,
        userId: 'user-1',
        listingId: null,
        subprofileId: null,
        companyId: null,
      },
      {
        id: 'identity-listing-a',
        kind: IdentityKind.Listing,
        userId: null,
        listingId: 'listing-a',
        subprofileId: null,
        companyId: null,
      },
      {
        id: 'identity-listing-b',
        kind: IdentityKind.Listing,
        userId: null,
        listingId: 'listing-b',
        subprofileId: null,
        companyId: null,
      },
      {
        id: 'identity-subprofile',
        kind: IdentityKind.Subprofile,
        userId: null,
        listingId: null,
        subprofileId: 'subprofile-1',
        companyId: null,
      },
      {
        id: 'identity-company',
        kind: IdentityKind.Company,
        userId: null,
        listingId: null,
        subprofileId: null,
        companyId: 'company-1',
      },
    ]);

    await service.describeIdentities([
      'identity-profile',
      'identity-listing-a',
      'identity-listing-b',
      'identity-subprofile',
      'identity-company',
    ]);

    // One query to learn every identity's kind and owner row, then at most
    // one further query per kind actually present (all four kinds are
    // present here): 1 + 4 = 5 total, never one per identity (which would
    // be 1 + 5 = 6 for this five-identity, four-kind mixed set).
    expect(identities.find).toHaveBeenCalledTimes(1);
    expect(profiles.find).toHaveBeenCalledTimes(1);
    expect(listings.find).toHaveBeenCalledTimes(1);
    expect(subprofiles.find).toHaveBeenCalledTimes(1);
    expect(companies.find).toHaveBeenCalledTimes(1);
  });

  it("names a linked persona's owner and keeps an unlinked persona's owner unread", async () => {
    const { service, identities, subprofiles, profiles } = makeService();
    identities.find.mockResolvedValue([
      {
        id: 'identity-linked',
        kind: IdentityKind.Subprofile,
        userId: null,
        listingId: null,
        subprofileId: 'subprofile-linked',
        companyId: null,
      },
      {
        id: 'identity-unlinked',
        kind: IdentityKind.Subprofile,
        userId: null,
        listingId: null,
        subprofileId: 'subprofile-unlinked',
        companyId: null,
      },
      {
        id: 'identity-linked-blank-owner',
        kind: IdentityKind.Subprofile,
        userId: null,
        listingId: null,
        subprofileId: 'subprofile-linked-blank-owner',
        companyId: null,
      },
    ]);
    subprofiles.find.mockResolvedValue([
      {
        id: 'subprofile-linked',
        userId: 'owner-linked',
        kind: 'visual_artist',
        linkVisibility: SubprofileLinkVisibility.Linked,
        displayName: 'Art historian',
        handle: 'art-historian',
        avatarUrl: null,
      },
      {
        id: 'subprofile-unlinked',
        userId: 'owner-unlinked',
        kind: 'dancer',
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        displayName: 'Dancer',
        handle: 'dancer',
        avatarUrl: null,
      },
      {
        id: 'subprofile-linked-blank-owner',
        userId: 'owner-blank',
        kind: 'writer',
        linkVisibility: SubprofileLinkVisibility.Linked,
        displayName: 'Writer',
        handle: 'writer',
        avatarUrl: null,
      },
    ]);
    // The unlinked owner's row is returned too, so the test proves the
    // linked-only rule holds even when the read hands that owner back.
    profiles.find.mockResolvedValue([
      { userId: 'owner-linked', firstName: 'Alina', lastName: 'C.' },
      { userId: 'owner-unlinked', firstName: 'Secret', lastName: 'Person' },
      { userId: 'owner-blank', firstName: ' ', lastName: '' },
    ]);

    const result = await service.describeIdentities([
      'identity-linked',
      'identity-unlinked',
      'identity-linked-blank-owner',
    ]);

    expect(result.get('identity-linked')).toEqual({
      displayName: 'Art historian',
      handle: 'art-historian',
      avatarUrl: null,
      personaKind: 'visual_artist',
      personaOwnerName: 'Alina C.',
    });
    const unlinkedDescription = result.get('identity-unlinked');
    expect(unlinkedDescription?.personaKind).toBe('dancer');
    expect(unlinkedDescription).not.toHaveProperty('personaOwnerName');
    // A linked owner whose name composes to blank carries no key at all.
    expect(result.get('identity-linked-blank-owner')).not.toHaveProperty(
      'personaOwnerName',
    );
    // ONE batched owner read, over the linked personas' owners only.
    expect(profiles.find).toHaveBeenCalledTimes(1);
    expect(profiles.find).toHaveBeenCalledWith({
      where: { userId: In(['owner-linked', 'owner-blank']) },
    });
  });

  it('skips the owner read entirely when no persona is linked', async () => {
    const { service, identities, subprofiles, profiles } = makeService();
    identities.find.mockResolvedValue([
      {
        id: 'identity-unlinked',
        kind: IdentityKind.Subprofile,
        userId: null,
        listingId: null,
        subprofileId: 'subprofile-unlinked',
        companyId: null,
      },
    ]);
    subprofiles.find.mockResolvedValue([
      {
        id: 'subprofile-unlinked',
        userId: 'owner-unlinked',
        kind: 'dancer',
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        displayName: 'Dancer',
        handle: 'dancer',
        avatarUrl: null,
      },
    ]);

    const result = await service.describeIdentities(['identity-unlinked']);

    expect(result.get('identity-unlinked')).toEqual({
      displayName: 'Dancer',
      handle: 'dancer',
      avatarUrl: null,
      personaKind: 'dancer',
    });
    expect(profiles.find).not.toHaveBeenCalled();
  });

  it('omits an identity whose own row has vanished, and never throws', async () => {
    const { service, identities, listings } = makeService();
    identities.find.mockResolvedValue([
      {
        id: 'identity-listing',
        kind: IdentityKind.Listing,
        userId: null,
        listingId: 'listing-gone',
        subprofileId: null,
        companyId: null,
      },
    ]);
    // The listing itself was hard-deleted; the identity row survived (or an
    // unrelated cascade has not caught up), so its FK target is gone.
    listings.find.mockResolvedValue([]);

    const result = await service.describeIdentities(['identity-listing']);

    expect(result.has('identity-listing')).toBe(false);
    expect(result.size).toBe(0);
  });

  it('omits an identity id that never matched an `identities` row at all', async () => {
    const { service, identities } = makeService();
    identities.find.mockResolvedValue([]);

    const result = await service.describeIdentities(['identity-nowhere']);

    expect(result.has('identity-nowhere')).toBe(false);
  });
});
