import { Transform } from 'class-transformer';

/**
 * Collapses a message body to its trimmed form BEFORE validation runs, so
 * `@MinLength(1)` measures real characters rather than whitespace.
 *
 * Without it a body of `" "` (or three newlines) passed every bound on both
 * transports and persisted verbatim: an empty-looking bubble in the thread, a
 * "New message" push whose preview was blank, and a cheap way to farm read
 * receipts. The trim happens once, here at the write boundary, so nothing
 * downstream has to re-trim what it reads.
 */
export const TrimMessageBody = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
