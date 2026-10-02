import { MemberRef } from '../common/member-ref';
import { ListingDraft } from './entities/listing-draft.entity';
import {
  deriveListingDraftName,
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
