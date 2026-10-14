import { SavedItem, SavedKind } from './entities/saved-item.entity';
import {
  toResolvedSavedItemDTO,
  toResolvedSavedItemDTOs,
  toSavedItemDTO,
  toSharedSavedItemDTO,
  toSharedSavedItemDTOs,
} from './saved-response';

const now = new Date('2026-09-01T12:00:00.000Z');

const item = (overrides: Partial<SavedItem> = {}): SavedItem => ({
  id: 'item-1',
  userId: 'u1',
  subjectType: SavedKind.Flatmate,
  subjectId: 'harper',
  title: 'Harper',
  href: '/members/harper',
  meta: 'Bairro Alto',
  description: null,
  readTime: null,
  createdAt: now,
  ...overrides,
});

describe('toSavedItemDTO', () => {
  it('carries the snapshot with no availability claim, for hydrateItems', () => {
    const result = toSavedItemDTO(item());
    expect(result).not.toHaveProperty('availability');
    expect(result.title).toBe('Harper');
    expect(result.meta).toBe('Bairro Alto');
  });
});

describe('toResolvedSavedItemDTO / toResolvedSavedItemDTOs (the OWNER’s own saved list)', () => {
  // The owner saved this themselves: an unavailable subject is something they
  // are RECOGNISING, so the snapshot stays.
  it('keeps the snapshot for an unavailable item', () => {
    const result = toResolvedSavedItemDTO(item(), false);
    expect(result.availability).toBe('unavailable');
    expect(result.href).toBeNull();
    expect(result.title).toBe('Harper');
    expect(result.meta).toBe('Bairro Alto');
  });

  it('reports href for an available item and nulls it otherwise', () => {
    expect(toResolvedSavedItemDTO(item(), true).href).toBe('/members/harper');
    expect(toResolvedSavedItemDTO(item(), false).href).toBeNull();
  });

  it('maps a whole page against the resolved set of refs', () => {
    const rows = [item(), item({ id: 'item-2', subjectId: 'casa-verde' })];
    const result = toResolvedSavedItemDTOs(rows, new Set(['flatmate:harper']));
    expect(result[0]?.availability).toBe('available');
    expect(result[1]?.availability).toBe('unavailable');
  });
});

describe('toSharedSavedItemDTO / toSharedSavedItemDTOs (ENG-443, the shared-list RECIPIENT)', () => {
  // The recipient is a third party who saved nothing. An unavailable subject
  // can mean its owner blocked or hid from THIS recipient specifically, and
  // the flatmate snapshot named in the scan (title = name, meta =
  // neighbourhood) must not cross that boundary.
  it('blanks the snapshot for an unavailable item', () => {
    const result = toSharedSavedItemDTO(item(), false);
    expect(result.availability).toBe('unavailable');
    expect(result.href).toBeNull();
    expect(result.title).toBe('');
    expect(result.meta).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.readTime).toBeUndefined();
  });

  it('still returns the id, kind and savedAt for an unavailable item', () => {
    const result = toSharedSavedItemDTO(item(), false);
    expect(result.id).toBe('flatmate:harper');
    expect(result.kind).toBe(SavedKind.Flatmate);
    expect(result.savedAt).toBe(now.toISOString());
  });

  it('keeps the snapshot for an available item, same as the owner-facing formatter', () => {
    const result = toSharedSavedItemDTO(item(), true);
    expect(result.availability).toBe('available');
    expect(result.href).toBe('/members/harper');
    expect(result.title).toBe('Harper');
    expect(result.meta).toBe('Bairro Alto');
  });

  it('maps a whole shared page, blanking only the unavailable rows', () => {
    const rows = [
      item(),
      item({ id: 'item-2', subjectId: 'casa-verde', title: 'Casa Verde' }),
    ];
    const result = toSharedSavedItemDTOs(rows, new Set(['flatmate:harper']));

    expect(result[0]?.availability).toBe('available');
    expect(result[0]?.title).toBe('Harper');
    expect(result[1]?.availability).toBe('unavailable');
    expect(result[1]?.title).toBe('');
    expect(JSON.stringify(result)).not.toContain('Casa Verde');
  });
});

describe('the withdrawn reason (Studio open demo pages)', () => {
  const studioRelease = item({
    subjectType: SavedKind.StudioRelease,
    subjectId: '9e000000-0000-4000-8000-000000000001',
    title: 'Lisbon at four',
    href: '/studio/album?id=9e000000-0000-4000-8000-000000000001',
    meta: 'Night Shift',
  });

  it('reads a withdrawn release as unavailable, says why, and keeps its link', () => {
    const result = toResolvedSavedItemDTO(studioRelease, false, true);
    expect(result.availability).toBe('unavailable');
    expect(result.unavailableReason).toBe('withdrawn');
    expect(result.href).toBe(
      '/studio/album?id=9e000000-0000-4000-8000-000000000001',
    );
    expect(result.title).toBe('Lisbon at four');
  });

  it('sends no reason for any other unavailable item, and withholds its link', () => {
    const result = toResolvedSavedItemDTO(studioRelease, false);
    expect(result).not.toHaveProperty('unavailableReason');
    expect(result.href).toBeNull();
  });

  it('sends no reason for an available item, whatever the withdrawn set says', () => {
    const result = toResolvedSavedItemDTO(studioRelease, true, true);
    expect(result.availability).toBe('available');
    expect(result).not.toHaveProperty('unavailableReason');
  });

  it('maps a page against both sets', () => {
    const results = toResolvedSavedItemDTOs(
      [studioRelease, item()],
      new Set<string>(),
      new Set([`studio_release:${studioRelease.subjectId}`]),
    );
    expect(results.map((result) => result.unavailableReason)).toEqual([
      'withdrawn',
      undefined,
    ]);
  });

  it('keeps shared lists free of the reason', () => {
    expect(toSharedSavedItemDTO(studioRelease, false)).not.toHaveProperty(
      'unavailableReason',
    );
  });
});
