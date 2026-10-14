import {
  OwnerCreditRow,
  creditRoleRank,
  orderedCreditRoles,
  toStudioPersonaCreditOwnerRow,
  toStudioPersonaRef,
} from './studio-persona-credit-response';

const columns = (kind: string) => ({
  id: 'persona-1',
  handle: 'river-ink',
  displayName: 'River Ink',
  kind,
  avatarUrl: null,
});

describe('Studio persona credit mappers', () => {
  it('links a public persona of a Studio artist kind to Studio and every other kind to its persona page', () => {
    expect(toStudioPersonaRef(columns('dj'), true).isListenable).toBe(true);
    expect(toStudioPersonaRef(columns('musician'), true).isListenable).toBe(
      true,
    );
    expect(
      toStudioPersonaRef(columns('visual_artist'), true).isListenable,
    ).toBe(false);
    expect(toStudioPersonaRef(columns('dj'), false).isListenable).toBe(false);
  });

  it('carries persona fields only, and the kind as stored', () => {
    expect(toStudioPersonaRef(columns('visual_artist'), true)).toEqual({
      id: 'persona-1',
      handle: 'river-ink',
      name: 'River Ink',
      kind: 'visual_artist',
      avatarUrl: null,
      isListenable: false,
    });
  });

  it('orders roles by the vocabulary, drops repeats and unknown roles', () => {
    expect(
      orderedCreditRoles([
        'other',
        'producer',
        'drums',
        'featured',
        'producer',
      ]),
    ).toEqual(['featured', 'producer', 'other']);
    expect(creditRoleRank('featured')).toBeLessThan(
      creditRoleRank('cover-art'),
    );
  });

  it('maps an owner row with its status and the public flag', () => {
    const row: OwnerCreditRow = {
      id: 'credit-1',
      role: 'mixing',
      status: 'declined',
      created_at: new Date('2026-10-13T09:00:00.000Z'),
      is_persona_public: false,
      is_persona_linkable: false,
      persona_id: 'persona-1',
      persona_handle: 'river-ink',
      persona_display_name: 'River Ink',
      persona_kind: 'dj',
      persona_avatar_url: null,
    };
    expect(toStudioPersonaCreditOwnerRow(row)).toEqual([
      {
        id: 'credit-1',
        persona: {
          id: 'persona-1',
          handle: 'river-ink',
          name: 'River Ink',
          kind: 'dj',
          avatarUrl: null,
          isListenable: false,
        },
        role: 'mixing',
        status: 'declined',
        isPersonaPublic: false,
        createdAt: '2026-10-13T09:00:00.000Z',
      },
    ]);
    expect(toStudioPersonaCreditOwnerRow({ ...row, role: 'drums' })).toEqual(
      [],
    );
  });

  // A public persona whose creator is blocked either way with the viewer
  // stays public on the row and its chip renders unlinked, since its artist
  // page answers this viewer 404.
  it('links the persona chip only when the row says the persona is reachable', () => {
    const row: OwnerCreditRow = {
      id: 'credit-1',
      role: 'mixing',
      status: 'accepted',
      created_at: new Date('2026-10-13T09:00:00.000Z'),
      is_persona_public: true,
      is_persona_linkable: false,
      persona_id: 'persona-1',
      persona_handle: 'river-ink',
      persona_display_name: 'River Ink',
      persona_kind: 'dj',
      persona_avatar_url: null,
    };
    const [blocked] = toStudioPersonaCreditOwnerRow(row);
    expect(blocked?.isPersonaPublic).toBe(true);
    expect(blocked?.persona.isListenable).toBe(false);
    const [reachable] = toStudioPersonaCreditOwnerRow({
      ...row,
      is_persona_linkable: true,
    });
    expect(reachable?.persona.isListenable).toBe(true);
  });
});
