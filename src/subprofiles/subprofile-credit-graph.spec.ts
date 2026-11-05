import {
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  CARD_CREDIT_FACE_LIMIT,
  CounterpartDirectory,
  CreditItemRef,
  CreditMemberIdentity,
  CreditPersonaIdentity,
  CreditSubject,
  firstOutboundPersonaCredit,
  orderCreditFaces,
  isPersonaPairCredit,
  summarizeCardCredits,
} from './subprofile-credit-graph';

function makePersona(
  overrides: Partial<CreditPersonaIdentity> & { id: string },
): CreditPersonaIdentity {
  return {
    handle: overrides.id,
    displayName: `Persona ${overrides.id}`,
    avatarUrl: null,
    accent: null,
    kind: SubprofileKind.Musician,
    status: SubprofileStatus.Published,
    visibility: SubprofileVisibility.Open,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    removedAt: null,
    userId: `owner-of-${overrides.id}`,
    isUnderTakedown: false,
    isOwnerBlocked: false,
    ...overrides,
  };
}

function makeMember(
  overrides: Partial<CreditMemberIdentity> & { userId: string },
): CreditMemberIdentity {
  return {
    name: `Member ${overrides.userId}`,
    avatarUrl: null,
    isBlocked: false,
    ...overrides,
  };
}

function makeDirectory(
  personas: CreditPersonaIdentity[],
  membersByHandle: Record<string, CreditMemberIdentity> = {},
  rosters: Record<string, string[]> = {},
): CounterpartDirectory {
  return {
    personaById: new Map(personas.map((persona) => [persona.id, persona])),
    personaIdByHandle: new Map(
      personas
        .filter((persona) => persona.handle)
        .map((persona) => [persona.handle as string, persona.id]),
    ),
    memberByHandle: new Map(Object.entries(membersByHandle)),
    rosterMembersById: new Map(Object.entries(rosters)),
  };
}

function item(
  subprofileId: string,
  collaborators: string[],
  isoDate = '2026-10-01T00:00:00.000Z',
): CreditItemRef {
  return { subprofileId, collaborators, createdAt: new Date(isoDate) };
}

const linkedSubject: CreditSubject = {
  id: 'subject',
  userId: 'subject-creator',
  handle: 'subject',
  linkVisibility: SubprofileLinkVisibility.Linked,
};

const unlinkedSubject: CreditSubject = {
  ...linkedSubject,
  linkVisibility: SubprofileLinkVisibility.Unlinked,
};

describe('isPersonaPairCredit', () => {
  it('accepts an eligible persona even when it shares the subject owner', () => {
    expect(
      isPersonaPairCredit(
        { id: 'subject' },
        makePersona({ id: 'sibling', userId: 'subject-creator' }),
      ),
    ).toBe(true);
  });

  it('never pairs a persona with itself', () => {
    expect(
      isPersonaPairCredit({ id: 'subject' }, makePersona({ id: 'subject' })),
    ).toBe(false);
  });
});

describe('summarizeCardCredits: member credits', () => {
  it('counts a member credited on a LINKED persona', () => {
    const directory = makeDirectory([], {
      ana: makeMember({ userId: 'ana-user', name: 'Ana Reis' }),
    });
    const summary = summarizeCardCredits(
      linkedSubject,
      [item('subject', ['ana'])],
      directory,
    );
    expect(summary.count).toBe(1);
    expect(summary.faces[0]).toMatchObject({
      kind: 'member',
      name: 'Ana Reis',
    });
  });

  it('excludes the owner crediting themselves', () => {
    const directory = makeDirectory([], {
      me: makeMember({ userId: 'subject-creator' }),
    });
    expect(
      summarizeCardCredits(linkedSubject, [item('subject', ['me'])], directory)
        .count,
    ).toBe(0);
  });

  it('excludes a co-owner on the persona roster', () => {
    const directory = makeDirectory(
      [],
      { coowner: makeMember({ userId: 'co-owner' }) },
      { subject: ['subject-creator', 'co-owner'] },
    );
    expect(
      summarizeCardCredits(
        linkedSubject,
        [item('subject', ['coowner'])],
        directory,
      ).count,
    ).toBe(0);
  });

  it('drops member credits from count and faces on an UNLINKED persona', () => {
    const directory = makeDirectory([], {
      ana: makeMember({ userId: 'ana-user' }),
    });
    const summary = summarizeCardCredits(
      unlinkedSubject,
      [item('subject', ['ana'])],
      directory,
    );
    expect(summary).toEqual({ count: 0, faces: [] });
  });

  it('excludes a member blocked either way with the viewer', () => {
    const directory = makeDirectory([], {
      ana: makeMember({ userId: 'ana-user', isBlocked: true }),
    });
    expect(
      summarizeCardCredits(linkedSubject, [item('subject', ['ana'])], directory)
        .count,
    ).toBe(0);
  });
});

describe('summarizeCardCredits: outbound persona credits', () => {
  it('counts an eligible unlinked persona and matches handles case-insensitively', () => {
    const directory = makeDirectory([makePersona({ id: 'ember' })]);
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('subject', ['  EMBER '])],
        directory,
      ).count,
    ).toBe(1);
  });

  it('excludes the persona crediting itself', () => {
    const self = makePersona({
      id: 'subject',
      userId: 'subject-creator',
    });
    const directory = makeDirectory([self]);
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('subject', ['subject'])],
        directory,
      ).count,
    ).toBe(0);
  });

  // No roster-overlap exclusion: the persona page shows this credit, so the
  // card must count it too, or the difference would tie the two personas to
  // one owner.
  it('COUNTS a persona that shares a roster member with the subject', () => {
    const sibling = makePersona({ id: 'sibling', userId: 'sibling-creator' });
    const directory = makeDirectory(
      [sibling],
      {},
      {
        sibling: ['subject-creator'],
      },
    );
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('subject', ['sibling'])],
        directory,
      ).count,
    ).toBe(1);
  });

  it('COUNTS a persona run by the same creator', () => {
    const sibling = makePersona({ id: 'sibling', userId: 'subject-creator' });
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('subject', ['sibling'])],
        makeDirectory([sibling]),
      ).count,
    ).toBe(1);
  });

  it.each<[string, Partial<CreditPersonaIdentity>]>([
    ['network', { visibility: SubprofileVisibility.Network }],
    ['private', { visibility: SubprofileVisibility.Private }],
    ['draft', { status: SubprofileStatus.Draft }],
    ['removed', { removedAt: new Date('2026-09-01T00:00:00.000Z') }],
    ['taken down', { isUnderTakedown: true }],
    ['owner blocked', { isOwnerBlocked: true }],
    ['linked', { linkVisibility: SubprofileLinkVisibility.Linked }],
  ])('excludes a %s counterpart persona', (_label, overrides) => {
    const directory = makeDirectory([
      makePersona({ id: 'ember', ...overrides }),
    ]);
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('subject', ['ember'])],
        directory,
      ).count,
    ).toBe(0);
  });

  it('ignores a handle that resolves to nothing', () => {
    expect(
      summarizeCardCredits(
        linkedSubject,
        [item('subject', ['ghost'])],
        makeDirectory([]),
      ).count,
    ).toBe(0);
  });
});

describe('summarizeCardCredits: inbound credits', () => {
  it('counts another persona whose item lists the unlinked subject, even a linked one', () => {
    const author = makePersona({
      id: 'author',
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    const directory = makeDirectory([author]);
    const summary = summarizeCardCredits(
      unlinkedSubject,
      [item('author', ['subject'])],
      directory,
    );
    expect(summary.count).toBe(1);
    expect(summary.faces[0]).toMatchObject({
      kind: 'persona',
      name: 'Persona author',
    });
  });

  it('gives a LINKED subject no inbound credits', () => {
    const directory = makeDirectory([makePersona({ id: 'author' })]);
    expect(
      summarizeCardCredits(
        linkedSubject,
        [item('author', ['subject'])],
        directory,
      ).count,
    ).toBe(0);
  });

  it('ignores another persona item that does not list the subject', () => {
    const directory = makeDirectory([makePersona({ id: 'author' })]);
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('author', ['someone-else'])],
        directory,
      ).count,
    ).toBe(0);
  });

  // Same differential reason as the outbound case: the subject's persona page
  // shows this inbound credit, so the card counts it.
  it('COUNTS an inbound author sharing the subject roster', () => {
    const author = makePersona({ id: 'author', userId: 'co-owner' });
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('author', ['subject'])],
        makeDirectory([author], {}, { subject: ['co-owner'] }),
      ).count,
    ).toBe(1);
  });

  it('never counts the subject crediting its own handle as inbound', () => {
    const self = makePersona({ id: 'subject', userId: 'subject-creator' });
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('subject', ['subject'])],
        makeDirectory([self]),
      ).count,
    ).toBe(0);
  });

  it.each<[string, Partial<CreditPersonaIdentity>]>([
    ['network', { visibility: SubprofileVisibility.Network }],
    ['removed', { removedAt: new Date('2026-09-01T00:00:00.000Z') }],
    ['taken down', { isUnderTakedown: true }],
    ['handle-less', { handle: null }],
  ])('excludes a %s inbound author', (_label, overrides) => {
    const author = makePersona({ id: 'author', ...overrides });
    expect(
      summarizeCardCredits(
        unlinkedSubject,
        [item('author', ['subject'])],
        makeDirectory([author]),
      ).count,
    ).toBe(0);
  });
});

describe('summarizeCardCredits: dedup and faces', () => {
  it('counts a persona credited both ways once, keeping the newest shared item', () => {
    const ember = makePersona({ id: 'ember' });
    const summary = summarizeCardCredits(
      unlinkedSubject,
      [
        item('subject', ['ember'], '2026-08-01T00:00:00.000Z'),
        item('ember', ['subject'], '2026-10-20T00:00:00.000Z'),
        item('subject', ['ember'], '2026-09-01T00:00:00.000Z'),
      ],
      makeDirectory([ember]),
    );
    expect(summary.count).toBe(1);
    expect(summary.faces).toHaveLength(1);
    expect(summary.faces[0]!.latestSharedAt.toISOString()).toBe(
      '2026-10-20T00:00:00.000Z',
    );
  });

  it('caps faces at three while the count keeps every counterpart', () => {
    const personas = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) =>
      makePersona({ id }),
    );
    const summary = summarizeCardCredits(
      unlinkedSubject,
      personas.map((persona, index) =>
        item('subject', [persona.id], `2026-10-0${index + 1}T00:00:00.000Z`),
      ),
      makeDirectory(personas),
    );
    expect(summary.count).toBe(5);
    expect(summary.faces).toHaveLength(CARD_CREDIT_FACE_LIMIT);
    expect(summary.faces.map((face) => face.identityKey)).toEqual([
      'persona:p5',
      'persona:p4',
      'persona:p3',
    ]);
  });

  it('orders faces by newest shared item, then by name', () => {
    const sameDay = new Date('2026-10-01T00:00:00.000Z');
    const ordered = orderCreditFaces([
      {
        identityKey: 'persona:b',
        kind: 'persona',
        name: 'Bea',
        avatarUrl: null,
        accent: null,
        latestSharedAt: sameDay,
      },
      {
        identityKey: 'persona:a',
        kind: 'persona',
        name: 'Ada',
        avatarUrl: null,
        accent: null,
        latestSharedAt: sameDay,
      },
      {
        identityKey: 'member:c',
        kind: 'member',
        name: 'Zed',
        avatarUrl: null,
        accent: null,
        latestSharedAt: new Date('2026-10-05T00:00:00.000Z'),
      },
    ]);
    expect(ordered.map((face) => face.name)).toEqual(['Zed', 'Ada', 'Bea']);
  });
});

describe('firstOutboundPersonaCredit', () => {
  it('skips member and ineligible credits and returns the first eligible persona', () => {
    const author = makePersona({ id: 'author' });
    const directory = makeDirectory(
      [
        author,
        makePersona({ id: 'hidden', isUnderTakedown: true }),
        makePersona({ id: 'partner' }),
        makePersona({ id: 'later' }),
      ],
      { ana: makeMember({ userId: 'ana-user' }) },
    );
    expect(
      firstOutboundPersonaCredit(
        author,
        ['ana', 'hidden', 'partner', 'later'],
        directory,
      )?.id,
    ).toBe('partner');
  });

  it('returns null when no credit resolves to an eligible persona', () => {
    const author = makePersona({ id: 'author' });
    const directory = makeDirectory([author], {
      ana: makeMember({ userId: 'ana-user' }),
    });
    expect(
      firstOutboundPersonaCredit(author, ['ana', 'author'], directory),
    ).toBeNull();
  });
});
