import { Transform } from 'class-transformer';

/**
 * The stored form of a member-typed message body: CRLF and lone CR become
 * `\n`, every other C0/DEL control byte except `\t` and `\n` is removed, and
 * the outer whitespace is trimmed.
 *
 * Deliberately stops short of `toStoredPlainText`, which a caption goes
 * through: bodies are markdown-lite, and its HTML pass deletes ordinary chat
 * text such as `x<y and y>z`, `<https://...>` and a tag quoted in backticks.
 * Idempotent, so a body that passes through it twice is unchanged.
 */
export function sanitizeMessageBody(body: string): string {
  const withNormalizedLineBreaks = body
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  return withNormalizedLineBreaks
    .replace(
      // eslint-disable-next-line no-control-regex -- deliberately matching C0/DEL control bytes except \t (\x09) and \n (\x0a) to strip them.
      /[\x00-\x08\x0b-\x1f\x7f]/g,
      '',
    )
    .trim();
}

/**
 * Collapses a message body to its sanitized form BEFORE validation runs, so
 * `@MinLength(1)` measures real characters rather than whitespace or control
 * bytes.
 *
 * Without it a body of `" "` (or three newlines) passed every bound on both
 * transports and persisted verbatim: an empty-looking bubble in the thread, a
 * "New message" push whose preview was blank, and a cheap way to farm read
 * receipts. `MessagingCoreService.postMessage` applies the same function for
 * server-composed bodies that never pass through a DTO.
 */
export const TrimMessageBody = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? sanitizeMessageBody(value) : value,
  );
