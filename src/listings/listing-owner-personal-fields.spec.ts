import { ForbiddenException } from '@nestjs/common';
import {
  assertNoOwnerPersonalListingFields,
  ListingManagementRole,
  OWNER_PERSONAL_LISTING_FIELDS,
  redactOwnerPersonalFields,
  toManagedListingDTO,
} from './listing-owner-personal-fields';
import { ListingDTO } from './listing-response';

/**
 * The owner-personal-field boundary, tested on its own before it is tested
 * through the service.
 *
 * These helpers are the whole policy: one list of eight fields used in both
 * directions. Everything that reads or writes a listing on behalf of a
 * co-manager goes through one of the three functions here, so a regression in
 * any of them is a regression in every route at once.
 */

// Only the fields under test need real values. The DTO is large and none of the
// rest participates in the redaction, so the cast keeps the fixture honest
// about what this file is actually asserting.
const listingDTO = (): ListingDTO =>
  ({
    ref: 'QPL-2026-0001',
    slug: 'lux-cafe',
    name: 'Lux Café',
    // The eight owner-personal fields, each with a value a co-manager must
    // never receive.
    contactEmail: 'ana@example.com',
    ownerName: 'Ana Ribeiro',
    ownerBio: 'Runs the place since 2019.',
    consentOuting: true,
    consentGuide: true,
    visibility: 'public',
    linkToProfile: true,
    rel: 'owner',
    // Business fields that must survive untouched, including the one
    // owner-shaped field that is deliberately NOT in the set.
    ownerRole: 'Co-founder and baker',
    hoursNote: 'Closed on public holidays',
  }) as unknown as ListingDTO;

describe('OWNER_PERSONAL_LISTING_FIELDS', () => {
  it('is exactly the claim-transfer set plus the three consent/presentation fields', () => {
    // Pinned deliberately. `ListingClaimsService.review` clears the first five
    // when a listing changes hands, on the stated grounds that they are the
    // previous owner's rather than the business's; this set is that decision
    // reused. If somebody widens or narrows it, they should have to come here
    // and say so.
    expect([...OWNER_PERSONAL_LISTING_FIELDS].sort()).toEqual(
      [
        'consentGuide',
        'consentOuting',
        'contactEmail',
        'linkToProfile',
        'ownerBio',
        'ownerName',
        'rel',
        'visibility',
      ].sort(),
    );
  });

  it('does not include ownerRole, which is a job title at the business', () => {
    expect(OWNER_PERSONAL_LISTING_FIELDS).not.toContain('ownerRole');
  });
});

describe('redactOwnerPersonalFields', () => {
  it('removes the keys entirely rather than blanking them', () => {
    const redacted = redactOwnerPersonalFields(listingDTO()) as Record<
      string,
      unknown
    >;

    for (const field of OWNER_PERSONAL_LISTING_FIELDS) {
      // `in`, not a value check. A key present with `null` or `''` would render
      // as an empty box that looks like stored data, and would round-trip into
      // a PATCH the write gate then refuses.
      expect(field in redacted).toBe(false);
    }
  });

  it('leaves every business field, including ownerRole, untouched', () => {
    const redacted = redactOwnerPersonalFields(listingDTO()) as Record<
      string,
      unknown
    >;

    expect(redacted.name).toBe('Lux Café');
    expect(redacted.hoursNote).toBe('Closed on public holidays');
    expect(redacted.ownerRole).toBe('Co-founder and baker');
  });

  it('does not mutate the DTO it was given', () => {
    const original = listingDTO();
    redactOwnerPersonalFields(original);

    expect(original.contactEmail).toBe('ana@example.com');
  });

  it('produces an object a co-manager can round-trip into a PATCH', () => {
    // This is the pairing that makes the 403 on write affordable: what a
    // co-manager loads is exactly what they are allowed to send back.
    const redacted = redactOwnerPersonalFields(listingDTO());

    expect(() =>
      assertNoOwnerPersonalListingFields(
        redacted as unknown as Record<string, unknown>,
      ),
    ).not.toThrow();
  });
});

describe('toManagedListingDTO', () => {
  it('gives the owner the full listing and tags the seat', () => {
    const managed = toManagedListingDTO(listingDTO(), true) as Record<
      string,
      unknown
    >;

    expect(managed.managementRole).toBe(ListingManagementRole.Owner);
    expect(managed.contactEmail).toBe('ana@example.com');
  });

  it('gives a co-manager the redacted listing and tags the seat', () => {
    const managed = toManagedListingDTO(listingDTO(), false) as Record<
      string,
      unknown
    >;

    expect(managed.managementRole).toBe(ListingManagementRole.CoManager);
    expect('contactEmail' in managed).toBe(false);
    expect('ownerBio' in managed).toBe(false);
    expect(managed.name).toBe('Lux Café');
  });
});

describe('assertNoOwnerPersonalListingFields', () => {
  it('accepts a body of ordinary business fields', () => {
    expect(() =>
      assertNoOwnerPersonalListingFields({
        name: 'Lux Café',
        hoursNote: 'Closed Mondays',
        ownerRole: 'Co-founder and baker',
      }),
    ).not.toThrow();
  });

  it.each([...OWNER_PERSONAL_LISTING_FIELDS])(
    'rejects a body carrying %s',
    (field) => {
      // 403 rather than a silent drop, and this is the assertion that keeps it
      // that way. A dropped field would answer 200 with an unchanged row, which
      // is indistinguishable from the policy having been refactored away.
      expect(() =>
        assertNoOwnerPersonalListingFields({ name: 'Lux Café', [field]: 'x' }),
      ).toThrow(ForbiddenException);
    },
  );

  it('rejects a falsy value too, since false is a real consent change', () => {
    // `consentOuting: false` is somebody withdrawing consent. A presence test
    // that skipped falsy values would let exactly that through.
    expect(() =>
      assertNoOwnerPersonalListingFields({ consentOuting: false }),
    ).toThrow(ForbiddenException);
    expect(() => assertNoOwnerPersonalListingFields({ ownerName: '' })).toThrow(
      ForbiddenException,
    );
  });

  it('ignores a key materialised as undefined by class-transformer', () => {
    // A `PartialType` DTO instance can carry absent optional properties as
    // `undefined`. Those are not a write, and treating them as one would 403
    // every honest PATCH.
    expect(() =>
      assertNoOwnerPersonalListingFields({
        name: 'Lux Café',
        contactEmail: undefined,
        ownerBio: undefined,
      }),
    ).not.toThrow();
  });

  it('names every offending field in the message, not just the first', () => {
    expect(() =>
      assertNoOwnerPersonalListingFields({
        contactEmail: 'x@example.com',
        ownerName: 'Someone Else',
      }),
    ).toThrow(/contactEmail, ownerName/);
  });
});
