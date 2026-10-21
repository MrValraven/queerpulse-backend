import { SavedKind } from './entities/saved-item.entity';

/** How long an unsave keeps its original save time for a re-save. */
export const SAVED_UNSAVE_MEMORY_MS = 10 * 60_000;
/** A hard cap, so a burst of unsaves can never grow the process unbounded.
 *  The oldest entry goes first. */
export const SAVED_UNSAVE_MEMORY_MAX_ENTRIES = 10_000;

interface UnsaveEntry {
  createdAt: Date;
  unsavedAtMs: number;
}

/**
 * Re-liking keeps the original saved time: when a member unsaves something
 * and saves it again within ten minutes (the Undo on the Library toast, or a
 * second tap of the heart), the row comes back with its first `createdAt`,
 * so it returns to its old place in the list.
 *
 * In process memory only, on purpose. It holds the save time of a row the
 * member just deleted, keyed by member and subject, for ten minutes, and is
 * never written anywhere. A restart, or a re-save that reaches another
 * instance, simply saves with a fresh time, which is what a save did before.
 */
export class SavedUnsaveMemory {
  private readonly entries = new Map<string, UnsaveEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  remember(
    userId: string,
    subjectType: SavedKind,
    subjectId: string,
    createdAt: Date,
  ): void {
    this.prune();
    const key = this.keyOf(userId, subjectType, subjectId);
    // Re-inserted at the end, so the Map's order stays oldest first.
    this.entries.delete(key);
    this.entries.set(key, { createdAt, unsavedAtMs: this.now() });
    while (this.entries.size > SAVED_UNSAVE_MEMORY_MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  /** The original save time of a subject unsaved in the last ten minutes,
   *  read once: the entry is gone after this call. */
  take(userId: string, subjectType: SavedKind, subjectId: string): Date | null {
    const key = this.keyOf(userId, subjectType, subjectId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    return this.isFresh(entry) ? entry.createdAt : null;
  }

  private isFresh(entry: UnsaveEntry): boolean {
    return this.now() - entry.unsavedAtMs <= SAVED_UNSAVE_MEMORY_MS;
  }

  /** Entries go in oldest first, so pruning stops at the first fresh one. */
  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.isFresh(entry)) return;
      this.entries.delete(key);
    }
  }

  private keyOf(
    userId: string,
    subjectType: SavedKind,
    subjectId: string,
  ): string {
    return `${userId}\u0000${subjectType}\u0000${subjectId}`;
  }
}
