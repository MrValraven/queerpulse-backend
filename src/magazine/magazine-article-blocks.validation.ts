import { BadRequestException } from '@nestjs/common';
import { isStorageKey } from '../storage/storage-key';
import { ArticleBlock } from './entities/magazine-article.entity';

/**
 * Pure validator for the JSONB `MagazineArticle.blocks` union. Mirrors
 * `deck-slides.validation.ts`: hand-rolls a switch-on-`kind` check and throws
 * `BadRequestException` with a field-path message on the first violation.
 * Called by the service on create/update, before `save()`.
 */

const BLOCK_KINDS = [
  'paragraph',
  'heading',
  'pullQuote',
  'quote',
  'image',
  'qa',
  'stats',
] as const;
const IMAGE_RIGHTS = ['commissioned', 'licensed', 'courtesy', 'cc'] as const;
const IMAGE_TINTS = ['coral', 'jade', 'plum', 'violet'] as const;
const IMAGE_CROPS = ['16:9', '4:5', '1:1'] as const;

// Size ceilings. The article row is rewritten in full on every autosave and
// `snapshotArticleVersion` copies `blocks` again per version, so an unbounded
// jsonb blob is not one big row — it is one big row multiplied by its edit
// history, re-read by `listArticleVersions` and `searchArchive`. These are set
// well above any real piece (the longest published article in the archive is a
// few hundred paragraphs of a few kilobytes each) purely to stop a runaway or
// hostile payload.
const MAX_BLOCKS_PER_ARTICLE = 400;
const MAX_BLOCK_HTML_LENGTH = 20_000;
const MAX_BLOCK_TEXT_LENGTH = 500;
const MAX_STATS_ITEMS = 12;

type BlockKind = (typeof BLOCK_KINDS)[number];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringIfPresent(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function fail(index: number, reason: string): never {
  throw new BadRequestException(`blocks[${index}]: ${reason}`);
}

/** Rich-text field (`html`) — capped, since it holds a whole paragraph. */
function checkHtmlLength(value: string, field: string, index: number): void {
  if (value.length > MAX_BLOCK_HTML_LENGTH) {
    fail(index, `${field} must be at most ${MAX_BLOCK_HTML_LENGTH} characters`);
  }
}

/** Short single-line field (a cite, an alt, a credit, a stat label). */
function checkTextLength(value: string, field: string, index: number): void {
  if (value.length > MAX_BLOCK_TEXT_LENGTH) {
    fail(index, `${field} must be at most ${MAX_BLOCK_TEXT_LENGTH} characters`);
  }
}

function validateId(record: Record<string, unknown>, index: number): void {
  if (!isNonEmptyString(record.id)) {
    fail(index, 'id must be a non-empty string');
  }
}

function validateParagraphBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  const html = record.html;
  if (!isNonEmptyString(html)) {
    fail(index, 'paragraph block requires a non-empty html');
  }
  checkHtmlLength(html, 'html', index);
  if (record.lead !== undefined && typeof record.lead !== 'boolean') {
    fail(index, 'lead must be a boolean if present');
  }
}

function validateHeadingBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  const html = record.html;
  if (!isNonEmptyString(html)) {
    fail(index, 'heading block requires a non-empty html');
  }
  checkHtmlLength(html, 'html', index);
}

function validatePullQuoteBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  const html = record.html;
  if (!isNonEmptyString(html)) {
    fail(index, 'pullQuote block requires a non-empty html');
  }
  checkHtmlLength(html, 'html', index);
}

function validateQuoteBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  const html = record.html;
  if (!isNonEmptyString(html)) {
    fail(index, 'quote block requires a non-empty html');
  }
  checkHtmlLength(html, 'html', index);
  const cite = record.cite;
  if (!isNonEmptyString(cite)) {
    fail(index, 'quote block requires a non-empty cite');
  }
  checkTextLength(cite, 'cite', index);
}

function validateFocalPoint(value: unknown, index: number): void {
  if (typeof value !== 'object' || value === null) {
    fail(index, 'focal must be an object');
  }
  const focal = value as Record<string, unknown>;
  if (typeof focal.x !== 'number' || typeof focal.y !== 'number') {
    fail(index, 'focal.x and focal.y must be numbers');
  }
}

function validateImageBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  const alt = record.alt;
  if (!isNonEmptyString(alt)) {
    fail(index, 'image block requires a non-empty alt');
  }
  const credit = record.credit;
  if (!isNonEmptyString(credit)) {
    fail(index, 'image block requires a non-empty credit');
  }
  const caption = record.caption;
  if (!isString(caption)) {
    fail(index, 'image block requires caption to be a string (may be empty)');
  }
  if (
    typeof record.rights !== 'string' ||
    !(IMAGE_RIGHTS as readonly string[]).includes(record.rights)
  ) {
    fail(index, `rights must be one of ${IMAGE_RIGHTS.join(', ')}`);
  }
  if (
    typeof record.tint !== 'string' ||
    !(IMAGE_TINTS as readonly string[]).includes(record.tint)
  ) {
    fail(index, `tint must be one of ${IMAGE_TINTS.join(', ')}`);
  }
  if (
    typeof record.crop !== 'string' ||
    !(IMAGE_CROPS as readonly string[]).includes(record.crop)
  ) {
    fail(index, `crop must be one of ${IMAGE_CROPS.join(', ')}`);
  }
  checkTextLength(alt, 'alt', index);
  checkTextLength(credit, 'credit', index);
  checkHtmlLength(caption, 'caption', index);
  validateFocalPoint(record.focal, index);
  const src = record.src;
  if (!isStringIfPresent(src)) {
    fail(index, 'src must be a string if present');
  }
  // Same rule as every other image field in the codebase (`IsImageReference`):
  // one of our uploaded storage keys, or an `https://` URL. `blocks` is a bare
  // `unknown` on the DTO, so class-validator never reaches this field — an
  // untyped `src` here was the one image reference in the app that could carry
  // a `javascript:`/`data:` URI into a reader's browser, or an `http://` URL
  // the browser blocks as mixed content. `''` means "no image yet", which the
  // editor sends for a freshly inserted image block.
  if (
    typeof src === 'string' &&
    src !== '' &&
    !isStorageKey(src) &&
    !src.startsWith('https://')
  ) {
    fail(index, 'src must be an uploaded image key or an https:// URL');
  }
}

function validateQaBlock(record: Record<string, unknown>, index: number): void {
  const question = record.q;
  if (!isNonEmptyString(question)) {
    fail(index, 'qa block requires a non-empty q');
  }
  checkHtmlLength(question, 'q', index);
  const html = record.html;
  if (!isNonEmptyString(html)) {
    fail(index, 'qa block requires a non-empty html');
  }
  checkHtmlLength(html, 'html', index);
  const who = record.who;
  if (!isNonEmptyString(who)) {
    fail(index, 'qa block requires a non-empty who');
  }
  checkTextLength(who, 'who', index);
}

function validateStatsItem(value: unknown, index: number): void {
  if (typeof value !== 'object' || value === null) {
    fail(index, 'each stats item must be an object');
  }
  const item = value as Record<string, unknown>;
  const statValue = item.value;
  if (!isNonEmptyString(statValue)) {
    fail(index, 'each stats item requires a non-empty value');
  }
  checkTextLength(statValue, 'items[].value', index);
  const statLabel = item.label;
  if (!isNonEmptyString(statLabel)) {
    fail(index, 'each stats item requires a non-empty label');
  }
  checkTextLength(statLabel, 'items[].label', index);
}

function validateStatsBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  if (!Array.isArray(record.items)) {
    fail(index, 'stats block requires items to be an array');
  }
  if (record.items.length > MAX_STATS_ITEMS) {
    fail(index, `stats block can have at most ${MAX_STATS_ITEMS} items`);
  }
  record.items.forEach((item) => validateStatsItem(item, index));
}

/**
 * Validates an `unknown` payload as an `ArticleBlock[]`: an array of blocks,
 * each a valid block for its `kind`. Throws `BadRequestException` on the
 * first violation.
 */
export function validateArticleBlocks(input: unknown): ArticleBlock[] {
  if (!Array.isArray(input)) {
    throw new BadRequestException('blocks must be an array');
  }
  if (input.length > MAX_BLOCKS_PER_ARTICLE) {
    throw new BadRequestException(
      `blocks must have at most ${MAX_BLOCKS_PER_ARTICLE} entries`,
    );
  }

  input.forEach((block, index) => {
    if (typeof block !== 'object' || block === null) {
      fail(index, 'must be an object');
    }
    const record = block as Record<string, unknown>;

    validateId(record, index);

    const kind = record.kind;
    if (typeof kind !== 'string') {
      fail(index, 'kind is required');
    }
    if (!(BLOCK_KINDS as readonly string[]).includes(kind)) {
      fail(index, `kind must be one of ${BLOCK_KINDS.join(', ')}`);
    }

    switch (kind as BlockKind) {
      case 'paragraph':
        validateParagraphBlock(record, index);
        break;
      case 'heading':
        validateHeadingBlock(record, index);
        break;
      case 'pullQuote':
        validatePullQuoteBlock(record, index);
        break;
      case 'quote':
        validateQuoteBlock(record, index);
        break;
      case 'image':
        validateImageBlock(record, index);
        break;
      case 'qa':
        validateQaBlock(record, index);
        break;
      case 'stats':
        validateStatsBlock(record, index);
        break;
    }
  });

  return input as ArticleBlock[];
}
