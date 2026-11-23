/**
 * Markdown-lite to plain text, for the short excerpts a community post or
 * reply body becomes (mention and new-post notification payloads, the
 * profile activity event, the weekly digest, the community moderation queue,
 * the feed card summary).
 *
 * Community posts are written with a markdown-lite toolbar and stored as
 * written. The frontend renders them through
 * `queerpulse/src/shared/markdown/markdownLiteParser.ts`, and this helper
 * mirrors that parser's grammar line for line, so an excerpt reads as the
 * words the published post shows:
 *
 *   **bold**              becomes bold
 *   *italic*              becomes italic (never matched inside `**`)
 *   a line of just **X**  becomes X (a heading)
 *   `- ` / `* ` lines     lose the bullet
 *   `1. ` lines           lose the number
 *   `> ` lines            lose the quote mark
 *   [text](https://...)   becomes text
 *   a bare https://...    stays as typed
 *
 * Mentions (`@name`, `c/slug`) are plain text to the parser and stay as
 * typed. Newlines are kept: each caller already decides whether to collapse
 * whitespace or keep the line breaks. Pure string work with no dependencies,
 * so it runs before any truncation and a cut can never land inside a marker.
 */

/** `- item` / `* item`. The trailing `\s+` keeps `*italic*` at the start of
 *  a line from being read as a bullet. */
const UNORDERED_ITEM = /^\s*[-*]\s+/;
/** `1. item`, any run of digits. */
const ORDERED_ITEM = /^\s*\d+\.\s*/;
/** `> quoted`, with the space after the marker optional. */
const QUOTE_LINE = /^>\s?/;
/** A line that is nothing but `**...**` is a heading. */
const HEADING_LINE = /^\*\*[^*]+\*\*$/;

const STRONG_RUN = /^\*\*(.+?)\*\*/;
const EMPHASIS_RUN = /^\*(?!\*)(.+?)\*(?!\*)/;
const MARKDOWN_LINK = /^\[(.+?)\]\((https?:\/\/[^\s)]+)\)/;
const BARE_URL = /^https?:\/\/[^\s<]+/;

/**
 * The visible text of the inline marker starting at the head of `rest`, and
 * how many characters of the line it consumed. Left to right and single pass,
 * in the parser's order (strong, emphasis, link, bare URL), so a marker is
 * consumed once and its contents stay literal. A bare URL is consumed whole
 * so an asterisk inside one is never read as emphasis.
 */
function matchInlineMarker(
  rest: string,
  previousCharacter: string,
): { visibleText: string; consumedLength: number } | null {
  const strongMatch = STRONG_RUN.exec(rest);
  if (strongMatch) {
    return {
      visibleText: strongMatch[1] ?? '',
      consumedLength: strongMatch[0].length,
    };
  }
  if (previousCharacter !== '*') {
    const emphasisMatch = EMPHASIS_RUN.exec(rest);
    if (emphasisMatch) {
      return {
        visibleText: emphasisMatch[1] ?? '',
        consumedLength: emphasisMatch[0].length,
      };
    }
  }
  const linkMatch = MARKDOWN_LINK.exec(rest);
  if (linkMatch) {
    return {
      visibleText: linkMatch[1] ?? '',
      consumedLength: linkMatch[0].length,
    };
  }
  // A bare URL only counts at a word boundary, as in the parser.
  if (previousCharacter === '' || /\s/.test(previousCharacter)) {
    const bareUrlMatch = BARE_URL.exec(rest);
    if (bareUrlMatch) {
      return {
        visibleText: bareUrlMatch[0],
        consumedLength: bareUrlMatch[0].length,
      };
    }
  }
  return null;
}

/** One line's inline markers removed, every other character kept. */
function inlinePlainText(line: string): string {
  let plainText = '';
  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    const marker = matchInlineMarker(rest, line[index - 1] ?? '');
    if (marker) {
      plainText += marker.visibleText;
      index += marker.consumedLength;
      continue;
    }
    plainText += rest[0];
    index += 1;
  }
  return plainText;
}

/** One line with its block marker (bullet, number, quote, heading) removed,
 *  tested in the parser's order, then its inline markers. */
function linePlainText(line: string): string {
  if (UNORDERED_ITEM.test(line)) {
    return inlinePlainText(line.replace(UNORDERED_ITEM, ''));
  }
  if (ORDERED_ITEM.test(line)) {
    return inlinePlainText(line.replace(ORDERED_ITEM, ''));
  }
  if (QUOTE_LINE.test(line)) {
    return inlinePlainText(line.replace(QUOTE_LINE, ''));
  }
  const trimmedLine = line.trim();
  if (HEADING_LINE.test(trimmedLine)) {
    return inlinePlainText(trimmedLine.slice(2, -2));
  }
  return inlinePlainText(line);
}

/** The body with every markdown-lite mark removed and its newlines kept. */
export function markdownLitePlainText(text: string): string {
  return text.split('\n').map(linePlainText).join('\n');
}
