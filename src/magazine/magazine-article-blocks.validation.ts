import { BadRequestException } from '@nestjs/common';
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

function validateId(record: Record<string, unknown>, index: number): void {
  if (!isNonEmptyString(record.id)) {
    fail(index, 'id must be a non-empty string');
  }
}

function validateParagraphBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  if (!isNonEmptyString(record.html)) {
    fail(index, 'paragraph block requires a non-empty html');
  }
  if (record.lead !== undefined && typeof record.lead !== 'boolean') {
    fail(index, 'lead must be a boolean if present');
  }
}

function validateHeadingBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  if (!isNonEmptyString(record.html)) {
    fail(index, 'heading block requires a non-empty html');
  }
}

function validatePullQuoteBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  if (!isNonEmptyString(record.html)) {
    fail(index, 'pullQuote block requires a non-empty html');
  }
}

function validateQuoteBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  if (!isNonEmptyString(record.html)) {
    fail(index, 'quote block requires a non-empty html');
  }
  if (!isNonEmptyString(record.cite)) {
    fail(index, 'quote block requires a non-empty cite');
  }
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
  if (!isNonEmptyString(record.alt)) {
    fail(index, 'image block requires a non-empty alt');
  }
  if (!isNonEmptyString(record.credit)) {
    fail(index, 'image block requires a non-empty credit');
  }
  if (!isString(record.caption)) {
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
  validateFocalPoint(record.focal, index);
  if (!isStringIfPresent(record.src)) {
    fail(index, 'src must be a string if present');
  }
}

function validateQaBlock(record: Record<string, unknown>, index: number): void {
  if (!isNonEmptyString(record.q)) {
    fail(index, 'qa block requires a non-empty q');
  }
  if (!isNonEmptyString(record.html)) {
    fail(index, 'qa block requires a non-empty html');
  }
  if (!isNonEmptyString(record.who)) {
    fail(index, 'qa block requires a non-empty who');
  }
}

function validateStatsItem(value: unknown, index: number): void {
  if (typeof value !== 'object' || value === null) {
    fail(index, 'each stats item must be an object');
  }
  const item = value as Record<string, unknown>;
  if (!isNonEmptyString(item.value)) {
    fail(index, 'each stats item requires a non-empty value');
  }
  if (!isNonEmptyString(item.label)) {
    fail(index, 'each stats item requires a non-empty label');
  }
}

function validateStatsBlock(
  record: Record<string, unknown>,
  index: number,
): void {
  if (!Array.isArray(record.items)) {
    fail(index, 'stats block requires items to be an array');
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
