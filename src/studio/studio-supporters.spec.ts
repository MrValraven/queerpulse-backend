import { MemberRef } from '../common/member-ref';
import {
  STUDIO_SUPPORTER_WINDOW_INTERVAL,
  STUDIO_TOP_SUPPORTERS_SHOWN,
  SupporterPersonaRow,
  toStudioSupporterIdentity,
  toStudioSupporterPersona,
} from './studio-supporters';

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';

const MEMBER_REF: MemberRef = {
  slug: 'sam',
  firstName: 'Sam',
  lastName: 'Lee',
  pronouns: null,
  avatarUrl: null,
};

const personaRow: SupporterPersonaRow = {
  id: PERSONA_ID,
  handle: 'patch-notes',
  display_name: 'Patch Notes',
  kind: 'artist',
  avatar_url: null,
  is_linkable: true,
};

describe('studio supporters', () => {
  it('builds the account identity from the member ref with no user id', () => {
    expect(toStudioSupporterIdentity(null, MEMBER_REF, new Map())).toEqual({
      kind: 'account',
      member: { slug: 'sam', displayName: 'Sam Lee', avatarUrl: null },
    });
  });

  it('shows an empty slug for a member with no profile', () => {
    expect(toStudioSupporterIdentity(null, undefined, new Map())).toEqual({
      kind: 'account',
      member: { slug: '', displayName: 'Member', avatarUrl: null },
    });
  });

  it('builds the persona identity with its link state and any persona kind', () => {
    expect(
      toStudioSupporterIdentity(
        PERSONA_ID,
        MEMBER_REF,
        new Map([
          [
            PERSONA_ID,
            { ...personaRow, kind: 'developer', is_linkable: false },
          ],
        ]),
      ),
    ).toEqual({
      kind: 'persona',
      persona: {
        id: PERSONA_ID,
        handle: 'patch-notes',
        name: 'Patch Notes',
        kind: 'developer',
        avatarUrl: null,
        isLinkable: false,
      },
    });
  });

  it('answers an empty handle for a persona with no handle', () => {
    expect(
      toStudioSupporterPersona({ ...personaRow, handle: null }).handle,
    ).toBe('');
  });

  it('answers null for a chosen persona that is gone', () => {
    expect(
      toStudioSupporterIdentity(PERSONA_ID, MEMBER_REF, new Map()),
    ).toBeNull();
  });

  it('ranks ten supporters inside a 28-day window', () => {
    expect([
      STUDIO_TOP_SUPPORTERS_SHOWN,
      STUDIO_SUPPORTER_WINDOW_INTERVAL,
    ]).toEqual([10, '28 days']);
  });
});
