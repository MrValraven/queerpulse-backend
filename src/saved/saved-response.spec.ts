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
