import { MemberRef } from '../common/member-ref';
import { ListingDraft } from './entities/listing-draft.entity';
import {
  deriveListingDraftName,
  toAdminListingDraftDetailDTO,
  toAdminListingDraftDTO,
} from './listing-draft-response';

const createdAt = new Date('2026-09-01T10:00:00.000Z');
const updatedAt = new Date('2026-09-20T18:30:00.000Z');

const draftRow = (payload: Record<string, unknown>): ListingDraft => ({
  id: 'draft-1',
  userId: 'user-1',
  payload,
  resumeToken: 'secret-token',
  createdAt,
  updatedAt,
});

const ownerRef: MemberRef = {
  slug: 'marta',
  firstName: 'Marta',
  lastName: 'Fonseca',
  pronouns: 'she/her',
  avatarUrl: null,
};

// What the frontend wizard actually saves: `{ draft, step }`.
const wizardPayload = {
  step: 3,
  draft: {
    name: '  Tasca da Graça ',
    hood: 'Graça',
    path: 'claim',
    ownerBio: 'Private bio',
    consentOuting: true,
    consentGuide: false,
  },
};

describe('deriveListingDraftName', () => {
  it('reads the name from the nested wizard draft the frontend saves', () => {
    expect(deriveListingDraftName(wizardPayload)).toBe('Tasca da Graça');
  });

  it('still reads a flat payload', () => {
    expect(deriveListingDraftName({ name: 'Bar Flat' })).toBe('Bar Flat');
  });

  it('falls back to a placeholder for a blank draft', () => {
    expect(deriveListingDraftName({ step: 0, draft: { name: ' ' } })).toBe(
      'Untitled listing',
    );
  });
});

describe('toAdminListingDraftDTO', () => {
  it('summarises the draft and carries the owner id for reach-out', () => {
    expect(toAdminListingDraftDTO(draftRow(wizardPayload), ownerRef)).toEqual({
      id: 'draft-1',
      name: 'Tasca da Graça',
      hood: 'Graça',
      path: 'claim',
      step: 3,
      owner: { userId: 'user-1', ...ownerRef },
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
  });

  it('never exposes the payload, consent decisions or resume token', () => {
    const serialised = JSON.stringify(
      toAdminListingDraftDTO(draftRow(wizardPayload), ownerRef),
    );
    expect(serialised).not.toContain('consent');
    expect(serialised).not.toContain('Private bio');
    expect(serialised).not.toContain('secret-token');
    expect(serialised).not.toContain('payload');
  });

  it('blanks malformed fields instead of echoing them', () => {
    const dto = toAdminListingDraftDTO(
      draftRow({ step: 'two', draft: { name: 42, hood: null, path: 'other' } }),
      null,
    );
    expect(dto).toMatchObject({
      name: '',
      hood: '',
      path: '',
      step: 0,
      owner: null,
    });
  });
});

describe('toAdminListingDraftDetailDTO', () => {
  // Every answer about the member filled in, beside the business details.
  const fullWizardPayload = {
    step: 4,
    draft: {
      path: 'claim',
      name: 'Tasca da Graça',
      hood: 'Graça',
      cats: ['food'],
      blurb: 'Petiscos and a long table.',
      social: { instagram: 'tascadagraca' },
      badge: 'owned',
      evidence: 'I am the owner and I am trans.',
      rel: 'own',
      ownerName: 'Marta Fonseca',
      ownerRole: 'Co-founder',
      ownerBio: 'Private bio',
      visibility: 'anon',
      linkToProfile: true,
      ownedBy: ['women', 'trans'],
      consentOuting: true,
      consentGuide: true,
      affirmingBaselineAccepted: true,
      managementRole: 'owner',
      isStaffAuthored: false,
      someFutureField: 'not yet reviewed',
    },
  };

  it('returns the summary and the business half, flattened out of the envelope', () => {
    const dto = toAdminListingDraftDetailDTO(
      draftRow(fullWizardPayload),
      ownerRef,
    );
    expect(dto).toMatchObject({
      id: 'draft-1',
      name: 'Tasca da Graça',
      step: 4,
      owner: { userId: 'user-1', slug: 'marta' },
    });
    expect(dto.payload).toEqual({
      name: 'Tasca da Graça',
      hood: 'Graça',
      cats: ['food'],
      blurb: 'Petiscos and a long table.',
      social: { instagram: 'tascadagraca' },
    });
  });

  it('leaves every answer about the member, and any unreviewed key, behind', () => {
    const serialised = JSON.stringify(
      toAdminListingDraftDetailDTO(draftRow(fullWizardPayload), ownerRef)
        .payload,
    );
    for (const leaked of [
      'consent',
      'Private bio',
      'Marta Fonseca',
      'Co-founder',
      'owned',
      'trans',
      'evidence',
      'affirming',
      'visibility',
      'linkToProfile',
      'rel',
      'managementRole',
      'isStaffAuthored',
      'someFutureField',
      'path',
    ]) {
      expect(serialised).not.toContain(leaked);
    }
    expect(
      JSON.stringify(
        toAdminListingDraftDetailDTO(draftRow(fullWizardPayload), ownerRef),
      ),
    ).not.toContain('secret-token');
  });

  it('carries the online business fields and leaves the 18+ acceptance behind', () => {
    const onlineDetails = {
      mainLink: { url: 'https://fiorosa.pt', kind: 'shop' },
      fulfilment: ['shipsEu'],
    };
    const shopItems = [{ id: 'item-1', name: 'Skein', price: '9 EUR' }];
    const dto = toAdminListingDraftDetailDTO(
      draftRow({
        step: 3,
        draft: {
          name: 'Fio Rosa',
          online: true,
          city: 'Porto',
          hasOnlineShop: false,
          onlineDetails,
          shopItems,
          adultTermsAccepted: true,
        },
      }),
      ownerRef,
    );

    expect(dto.payload).toEqual({
      name: 'Fio Rosa',
      online: true,
      city: 'Porto',
      hasOnlineShop: false,
      onlineDetails,
      shopItems,
    });
  });

  it('carries the out-and-about fields to the staff console', () => {
    const mobileDetails = {
      allOfCity: false,
      parishes: ['Arroios', 'Estrela'],
      alsoTravelsTo: ['Almada'],
      byAppointment: true,
    };
    const dto = toAdminListingDraftDetailDTO(
      draftRow({
        step: 3,
        draft: {
          name: 'Corte Movel',
          mobile: true,
          mobileDetails,
          hood: '',
          address: '',
        },
      }),
      ownerRef,
    );

    expect(dto.payload).toEqual({
      name: 'Corte Movel',
      mobile: true,
      mobileDetails,
      hood: '',
      address: '',
    });
  });

  it('reads a flat payload and keeps an empty one empty', () => {
    expect(
      toAdminListingDraftDetailDTO(
        draftRow({ name: 'Bar Flat', ownerBio: 'x' }),
        null,
      ).payload,
    ).toEqual({ name: 'Bar Flat' });
    expect(
      toAdminListingDraftDetailDTO(draftRow({ step: 0, draft: {} }), null)
        .payload,
    ).toEqual({});
  });
});
