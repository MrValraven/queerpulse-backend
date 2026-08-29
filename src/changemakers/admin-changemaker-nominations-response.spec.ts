import { MemberRef } from '../common/member-ref';
import {
  ChangemakerNomination,
  ChangemakerNominationStatus,
} from './entities/changemaker-nomination.entity';
import { toAdminChangemakerNominationDTO } from './admin-changemaker-nominations-response';

function memberRef(slug: string, firstName: string): MemberRef {
  return {
    slug,
    firstName,
    lastName: 'Tavares',
    pronouns: null,
    avatarUrl: null,
  };
}

const nomination = {
  id: 'cn-1',
  nominatorId: 'u1',
  nomineeName: 'Inês Tavares',
  reason: 'Always shows up for people.',
  nomineeUserId: 'u2',
  nomineeContact: 'instagram.com/ines',
  status: ChangemakerNominationStatus.Pending,
  reviewedBy: null,
  reviewNote: null,
  reviewedAt: null,
  createdAt: new Date('2026-07-15T12:00:00.000Z'),
} as ChangemakerNomination;

describe('toAdminChangemakerNominationDTO', () => {
  it('names the nominator, the linked nominee and the contact for platform staff', () => {
    const dto = toAdminChangemakerNominationDTO(
      nomination,
      memberRef('tiago', 'Tiago'),
      memberRef('ines-tavares', 'Inês'),
      null,
      true,
    );

    expect(dto.nominator).toEqual({
      slug: 'tiago',
      name: 'Tiago Tavares',
      avatarUrl: null,
    });
    expect(dto.nominee).toEqual({
      slug: 'ines-tavares',
      name: 'Inês Tavares',
      avatarUrl: null,
    });
    expect(dto.nomineeContact).toBe('instagram.com/ines');
  });

  it('omits all three "how to reach a third party" fields from a grant holder', () => {
    const dto = toAdminChangemakerNominationDTO(
      nomination,
      memberRef('tiago', 'Tiago'),
      memberRef('ines-tavares', 'Inês'),
      null,
      false,
    );

    // Omitted rather than nulled, so "withheld from you" stays
    // distinguishable from "there isn't one".
    expect('nominator' in dto).toBe(false);
    expect('nominee' in dto).toBe(false);
    expect('nomineeContact' in dto).toBe(false);
    // What a grant holder still reads: the pitch itself.
    expect(dto.nomineeName).toBe('Inês Tavares');
    expect(dto.reason).toBe('Always shows up for people.');
    expect(dto.status).toBe(ChangemakerNominationStatus.Pending);
  });

  it('nulls a nominee whose account is gone without hiding the row', () => {
    const dto = toAdminChangemakerNominationDTO(
      nomination,
      memberRef('tiago', 'Tiago'),
      null,
      null,
      true,
    );

    expect('nominee' in dto).toBe(true);
    expect(dto.nominee).toBeNull();
  });
});
