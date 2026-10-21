import { SavedKind } from './entities/saved-item.entity';
import {
  SAVED_UNSAVE_MEMORY_MAX_ENTRIES,
  SAVED_UNSAVE_MEMORY_MS,
  SavedUnsaveMemory,
} from './saved-unsave-memory';

describe('SavedUnsaveMemory', () => {
  const firstSavedAt = new Date('2026-07-01T09:00:00.000Z');
  let nowMs: number;
  let memory: SavedUnsaveMemory;

  beforeEach(() => {
    nowMs = Date.parse('2026-07-15T12:00:00.000Z');
    memory = new SavedUnsaveMemory(() => nowMs);
  });

  it('hands back the first save time within ten minutes, once', () => {
    memory.remember('u1', SavedKind.StudioRelease, 'r1', firstSavedAt);
    nowMs += SAVED_UNSAVE_MEMORY_MS;
    expect(memory.take('u1', SavedKind.StudioRelease, 'r1')).toBe(firstSavedAt);
    expect(memory.take('u1', SavedKind.StudioRelease, 'r1')).toBeNull();
  });

  it('forgets an unsave older than ten minutes', () => {
    memory.remember('u1', SavedKind.StudioRelease, 'r1', firstSavedAt);
    nowMs += SAVED_UNSAVE_MEMORY_MS + 1;
    expect(memory.take('u1', SavedKind.StudioRelease, 'r1')).toBeNull();
  });

  it('keeps members and subjects apart', () => {
    memory.remember('u1', SavedKind.StudioRelease, 'r1', firstSavedAt);
    expect(memory.take('u2', SavedKind.StudioRelease, 'r1')).toBeNull();
    expect(memory.take('u1', SavedKind.StudioTrack, 'r1')).toBeNull();
    expect(memory.take('u1', SavedKind.StudioRelease, 'r2')).toBeNull();
  });

  it('drops the oldest entry past the cap', () => {
    for (let index = 0; index <= SAVED_UNSAVE_MEMORY_MAX_ENTRIES; index += 1) {
      memory.remember('u1', SavedKind.Film, `film-${index}`, firstSavedAt);
    }
    expect(memory.take('u1', SavedKind.Film, 'film-0')).toBeNull();
    expect(
      memory.take(
        'u1',
        SavedKind.Film,
        `film-${SAVED_UNSAVE_MEMORY_MAX_ENTRIES}`,
      ),
    ).toBe(firstSavedAt);
  });
});
