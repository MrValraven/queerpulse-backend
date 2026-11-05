import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { SubprofileKind } from '../subprofiles/entities/subprofile.entity';
import { UserRole } from '../users/entities/user.entity';
import type { LeadEntry } from './entities/lead-entry.entity';
import type { Lead } from './entities/lead.entity';
import {
  canEditLeadEntry,
  type LeadCaller,
  type LeadPersonaSummaryRow,
  toLead,
  toLeadEntry,
  toLeadEntryAuthor,
  toLeadLinkedPersona,
  toLeadListItem,
  toLeadPersona,
} from './lead-response';

// Well-formed storage keys (`persona/<uuid>/<uuid><ext>`, `avatars/...`):
// `toImageUrl` drops anything that does not parse as one.
const AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg';
const AUTHOR_AVATAR_KEY =
  'persona/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg';

const AVATAR_CROP: CropRect = {
  x: 0.1,
  y: 0.1,
  width: 0.5,
  height: 0.5,
  aspect: '1:1',
};
const AUTHOR_CROP: CropRect = {
  x: 0,
  y: 0,
  width: 0.8,
  height: 0.8,
  aspect: '1:1',
};
const CROPS = new Map<string, CropRect>([
  [AVATAR_KEY, AVATAR_CROP],
  [AUTHOR_AVATAR_KEY, AUTHOR_CROP],
]);

const LEAD_ID = '6f1c2a40-8b3d-4e5f-9a10-1b2c3d4e5f60';
const PERSONA_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const HOLDER_ID = '8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const NOTE_ID = '9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f';
const CREATED_ENTRY_ID = 'ad4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a';

const ADMIN: LeadCaller = { userId: ADMIN_ID, role: UserRole.Admin };
const GRANT_HOLDER: LeadCaller = { userId: HOLDER_ID, role: UserRole.Member };

function personaRow(
  overrides: Partial<LeadPersonaSummaryRow> = {},
): LeadPersonaSummaryRow {
  return {
    id: PERSONA_ID,
    handle: 'ana-dj',
    displayName: 'Ana Dj',
    kind: SubprofileKind.Musician,
    avatarUrl: AVATAR_KEY,
    ...overrides,
  };
}

function leadRow(overrides: Partial<Lead> = {}): Lead {
  return {
    id: LEAD_ID,
    name: 'Ana Dj',
    type: 'dj',
    stage: 'in_talks',
    location: 'Lisbon',
    email: 'ana@example.org',
    phone: '+351 900 000 000',
    links: ['https://instagram.com/ana'],
    followUpOn: '2026-11-05',
    linkedSubprofileId: PERSONA_ID,
    linkedSubprofile: null,
    createdById: ADMIN_ID,
    createdBy: null,
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    updatedAt: new Date('2026-11-04T18:30:00.000Z'),
    ...overrides,
  };
}

function entryRow(overrides: Partial<LeadEntry> = {}): LeadEntry {
  return {
    id: NOTE_ID,
    leadId: LEAD_ID,
    kind: 'note',
    body: 'Met at the market',
    fromStage: null,
    toStage: null,
    subprofileId: null,
    subprofile: null,
    authorId: HOLDER_ID,
    author: null,
    createdAt: new Date('2026-11-02T12:00:00.000Z'),
    editedAt: null,
    ...overrides,
  };
}

describe('lead response shaping', () => {
  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  it('carries persona fields only, even when the row holds owner fields', () => {
    const rowWithOwnerFields = {
      ...personaRow(),
      userId: '55555555-5555-4555-8555-555555555555',
      linkVisibility: 'linked',
      slug: 'ana-silva',
      coverUrl: AVATAR_KEY,
      accent: 'coral',
      status: 'published',
    } as LeadPersonaSummaryRow;
    expect(
      Object.keys(toLeadPersona(rowWithOwnerFields, new Map())).sort(),
    ).toEqual([
      'avatarCrop',
      'avatarUrl',
      'displayName',
      'handle',
      'id',
      'kind',
    ]);
    expect(
      Object.keys(
        toLeadLinkedPersona(
          { row: rowWithOwnerFields, publicState: 'shown' },
          new Map(),
        ),
      ).sort(),
    ).toEqual([
      'avatarCrop',
      'avatarUrl',
      'displayName',
      'handle',
      'id',
      'kind',
      'publicState',
    ]);
  });

  it('resolves the avatar url and its crop', () => {
    const persona = toLeadPersona(personaRow(), CROPS);
    expect(persona).toEqual({
      id: PERSONA_ID,
      handle: 'ana-dj',
      displayName: 'Ana Dj',
      kind: SubprofileKind.Musician,
      avatarUrl: toImageUrl(AVATAR_KEY),
      avatarCrop: AVATAR_CROP,
    });
    const blankAvatar = toLeadPersona(personaRow({ avatarUrl: '' }), CROPS);
    expect(blankAvatar.avatarUrl).toBeNull();
    expect(blankAvatar.avatarCrop).toBeNull();
    expect(
      toLeadPersona(personaRow({ handle: null }), CROPS).handle,
    ).toBeNull();
  });

  it('carries the public state on a linked persona', () => {
    expect(
      toLeadLinkedPersona({ row: personaRow(), publicState: 'draft' }, CROPS),
    ).toEqual({
      id: PERSONA_ID,
      handle: 'ana-dj',
      displayName: 'Ana Dj',
      kind: SubprofileKind.Musician,
      avatarUrl: toImageUrl(AVATAR_KEY),
      avatarCrop: AVATAR_CROP,
      publicState: 'draft',
    });
  });

  it('maps a list row with three links and the full link count', () => {
    const links = [
      'https://a.org/1',
      'https://a.org/2',
      'https://a.org/3',
      'https://a.org/4',
      'https://a.org/5',
    ];
    const lastEntryAt = new Date('2026-11-04T18:30:00.123Z');
    const linkedPersona = toLeadLinkedPersona(
      { row: personaRow(), publicState: 'shown' },
      CROPS,
    );
    const item = toLeadListItem(
      leadRow({ links }),
      { noteCount: 4, lastEntryAt },
      linkedPersona,
      '2026-11-05',
    );
    expect(item).toEqual({
      id: LEAD_ID,
      name: 'Ana Dj',
      type: 'dj',
      stage: 'in_talks',
      location: 'Lisbon',
      links: links.slice(0, 3),
      linkCount: 5,
      followUpOn: '2026-11-05',
      isFollowUpDue: true,
      linkedPersona,
      noteCount: 4,
      lastEntryAt: '2026-11-04T18:30:00.123Z',
      updatedAt: '2026-11-04T18:30:00.000Z',
    });
    expect(Object.keys(item)).not.toContain('email');
    expect(Object.keys(item)).not.toContain('phone');
  });

  it('reads the due flag from the stage and the day', () => {
    const stats = { noteCount: 0, lastEntryAt: new Date() };
    expect(
      toLeadListItem(leadRow({ stage: 'on_board' }), stats, null, '2026-11-05')
        .isFollowUpDue,
    ).toBe(false);
    expect(
      toLeadListItem(leadRow(), stats, null, '2026-11-04').isFollowUpDue,
    ).toBe(false);
  });

  it('builds the author name from the profile and trims it', () => {
    expect(
      toLeadEntryAuthor(
        HOLDER_ID,
        { firstName: 'Ana', lastName: '', avatarUrl: AUTHOR_AVATAR_KEY },
        CROPS,
      ),
    ).toEqual({
      id: HOLDER_ID,
      displayName: 'Ana',
      avatarUrl: toImageUrl(AUTHOR_AVATAR_KEY),
      avatarCrop: AUTHOR_CROP,
    });
    expect(
      toLeadEntryAuthor(
        HOLDER_ID,
        { firstName: 'Ana', lastName: 'Silva', avatarUrl: null },
        CROPS,
      ).displayName,
    ).toBe('Ana Silva');
    expect(toLeadEntryAuthor(HOLDER_ID, null, CROPS)).toEqual({
      id: HOLDER_ID,
      displayName: '',
      avatarUrl: null,
      avatarCrop: null,
    });
  });

  it('lets the author or an Admin edit a note and nobody edit other kinds', () => {
    const ownNote = { kind: 'note' as const, authorId: HOLDER_ID };
    const otherNote = { kind: 'note' as const, authorId: ADMIN_ID };
    const orphanNote = { kind: 'note' as const, authorId: null };
    const ownStageChange = {
      kind: 'stage_changed' as const,
      authorId: HOLDER_ID,
    };
    const adminStageChange = {
      kind: 'stage_changed' as const,
      authorId: ADMIN_ID,
    };
    expect(canEditLeadEntry(ownNote, GRANT_HOLDER)).toBe(true);
    expect(canEditLeadEntry(otherNote, ADMIN)).toBe(true);
    expect(canEditLeadEntry(otherNote, GRANT_HOLDER)).toBe(false);
    expect(canEditLeadEntry(ownNote, ADMIN)).toBe(true);
    expect(canEditLeadEntry(orphanNote, ADMIN)).toBe(true);
    expect(canEditLeadEntry(orphanNote, GRANT_HOLDER)).toBe(false);
    expect(canEditLeadEntry(ownStageChange, GRANT_HOLDER)).toBe(false);
    expect(canEditLeadEntry(adminStageChange, ADMIN)).toBe(false);
    expect(
      canEditLeadEntry(
        { kind: 'note', authorId: null },
        { userId: HOLDER_ID, role: UserRole.Moderator },
      ),
    ).toBe(false);
  });

  it('maps every lead field and the entries in the given order', () => {
    const author = toLeadEntryAuthor(
      HOLDER_ID,
      { firstName: 'Rui', lastName: 'Costa', avatarUrl: AUTHOR_AVATAR_KEY },
      CROPS,
    );
    const persona = toLeadPersona(personaRow(), CROPS);
    const linkedPersona = toLeadLinkedPersona(
      { row: personaRow(), publicState: 'shown' },
      CROPS,
    );
    const noteEntry = toLeadEntry(
      entryRow({ editedAt: new Date('2026-11-03T08:00:00.000Z') }),
      author,
      null,
      true,
    );
    const linkedEntry = toLeadEntry(
      entryRow({
        id: 'be5f6a7b-8c9d-4e0f-8a1b-3c4d5e6f7a8b',
        kind: 'persona_linked',
        body: null,
        subprofileId: PERSONA_ID,
        createdAt: new Date('2026-10-20T12:00:00.000Z'),
      }),
      author,
      persona,
      false,
    );
    const createdEntry = toLeadEntry(
      entryRow({
        id: CREATED_ENTRY_ID,
        kind: 'created',
        body: null,
        toStage: 'to_contact',
        authorId: null,
        createdAt: new Date('2026-10-01T09:00:00.000Z'),
      }),
      null,
      null,
      false,
    );
    const lead = toLead(
      leadRow({ links: ['https://instagram.com/ana', 'https://a.org/press'] }),
      linkedPersona,
      [noteEntry, linkedEntry, createdEntry],
      '2026-11-05',
    );
    expect(lead).toEqual({
      id: LEAD_ID,
      name: 'Ana Dj',
      type: 'dj',
      stage: 'in_talks',
      location: 'Lisbon',
      email: 'ana@example.org',
      phone: '+351 900 000 000',
      links: ['https://instagram.com/ana', 'https://a.org/press'],
      followUpOn: '2026-11-05',
      isFollowUpDue: true,
      linkedPersona,
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-11-04T18:30:00.000Z',
      entries: [
        {
          id: NOTE_ID,
          kind: 'note',
          body: 'Met at the market',
          fromStage: null,
          toStage: null,
          persona: null,
          author,
          createdAt: '2026-11-02T12:00:00.000Z',
          editedAt: '2026-11-03T08:00:00.000Z',
          canEdit: true,
        },
        {
          id: 'be5f6a7b-8c9d-4e0f-8a1b-3c4d5e6f7a8b',
          kind: 'persona_linked',
          body: null,
          fromStage: null,
          toStage: null,
          persona,
          author,
          createdAt: '2026-10-20T12:00:00.000Z',
          editedAt: null,
          canEdit: false,
        },
        {
          id: CREATED_ENTRY_ID,
          kind: 'created',
          body: null,
          fromStage: null,
          toStage: 'to_contact',
          persona: null,
          author: null,
          createdAt: '2026-10-01T09:00:00.000Z',
          editedAt: null,
          canEdit: false,
        },
      ],
    });
    expect(Object.keys(lead).sort()).toEqual([
      'createdAt',
      'email',
      'entries',
      'followUpOn',
      'id',
      'isFollowUpDue',
      'linkedPersona',
      'links',
      'location',
      'name',
      'phone',
      'stage',
      'type',
      'updatedAt',
    ]);
  });

  it('copies the links array so a later change to the row stays off the answer', () => {
    const row = leadRow({ links: ['https://a.org/1'] });
    const lead = toLead(row, null, [], '2026-11-05');
    row.links.push('https://a.org/2');
    expect(lead.links).toEqual(['https://a.org/1']);
  });
});
