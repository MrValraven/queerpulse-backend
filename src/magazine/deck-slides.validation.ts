import { BadRequestException } from '@nestjs/common';
import { DeckSlide } from './entities/magazine-deck.entity';

/**
 * Pure validator for the JSONB `MagazineDeck.slides` union. No discriminated-
 * union DTO validation exists elsewhere in the repo, so this hand-rolls a
 * switch-on-`layout` (and `kind`, for `interactive`) check and throws
 * `BadRequestException` with a field-path message on the first violation.
 * Called by the service on create/update, before `save()`.
 */

const SLIDE_LAYOUTS = ['text', 'image', 'stat', 'interactive'] as const;
const TEXT_ALIGNS = ['left', 'center'] as const;
const INTERACTIVE_KINDS = ['before-after', 'reveal'] as const;

type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringIfPresent(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function fail(index: number, reason: string): never {
  throw new BadRequestException(`slides[${index}]: ${reason}`);
}

function validateTextSlide(
  record: Record<string, unknown>,
  index: number,
): void {
  for (const field of ['eyebrow', 'heading', 'body', 'pull'] as const) {
    if (!isStringIfPresent(record[field])) {
      fail(index, `${field} must be a string if present`);
    }
  }
  const hasContent = (['heading', 'body', 'pull'] as const).some((field) =>
    isNonEmptyString(record[field]),
  );
  if (!hasContent) {
    fail(
      index,
      'text slide requires at least one non-empty heading, body, or pull',
    );
  }
  if (
    record.align !== undefined &&
    (typeof record.align !== 'string' ||
      !(TEXT_ALIGNS as readonly string[]).includes(record.align))
  ) {
    fail(index, `align must be one of ${TEXT_ALIGNS.join(', ')}`);
  }
}

function validateImageSlide(
  record: Record<string, unknown>,
  index: number,
): void {
  if (!isNonEmptyString(record.src)) {
    fail(index, 'image slide requires a non-empty src');
  }
  if (!isNonEmptyString(record.alt)) {
    fail(index, 'image slide requires a non-empty alt');
  }
  if (!isNonEmptyString(record.tint)) {
    fail(index, 'image slide requires a non-empty tint');
  }
  for (const field of ['caption', 'overlay'] as const) {
    if (!isStringIfPresent(record[field])) {
      fail(index, `${field} must be a string if present`);
    }
  }
}

function validateStatSlide(
  record: Record<string, unknown>,
  index: number,
): void {
  if (!isNonEmptyString(record.value)) {
    fail(index, 'stat slide requires a non-empty value');
  }
  if (!isNonEmptyString(record.label)) {
    fail(index, 'stat slide requires a non-empty label');
  }
  if (!isNonEmptyString(record.tint)) {
    fail(index, 'stat slide requires a non-empty tint');
  }
  for (const field of ['unit', 'source'] as const) {
    if (!isStringIfPresent(record[field])) {
      fail(index, `${field} must be a string if present`);
    }
  }
}

function validateBeforeAfterPanel(
  value: unknown,
  index: number,
  panelName: 'before' | 'after',
): void {
  if (typeof value !== 'object' || value === null) {
    fail(index, `${panelName} must be an object`);
  }
  const panel = value as Record<string, unknown>;
  for (const field of ['src', 'alt', 'label'] as const) {
    if (!isNonEmptyString(panel[field])) {
      fail(index, `${panelName}.${field} must be a non-empty string`);
    }
  }
}

function validateInteractiveSlide(
  record: Record<string, unknown>,
  index: number,
): void {
  const kind = record.kind;
  if (
    typeof kind !== 'string' ||
    !(INTERACTIVE_KINDS as readonly string[]).includes(kind)
  ) {
    fail(index, `kind must be one of ${INTERACTIVE_KINDS.join(', ')}`);
  }

  if (kind === 'before-after') {
    validateBeforeAfterPanel(record.before, index, 'before');
    validateBeforeAfterPanel(record.after, index, 'after');
    return;
  }

  // kind === 'reveal'
  if (!isNonEmptyString(record.prompt)) {
    fail(index, 'reveal slide requires a non-empty prompt');
  }
  if (!isNonEmptyString(record.hidden)) {
    fail(index, 'reveal slide requires a non-empty hidden');
  }
  if (!isStringIfPresent(record.tint)) {
    fail(index, 'tint must be a string if present');
  }
}

/**
 * Validates an `unknown` payload as a `DeckSlide[]`: an array of at most 40
 * entries, each a valid slide for its `layout` (and `kind`, for
 * `interactive`). Throws `BadRequestException` on the first violation.
 */
export function validateDeckSlides(slides: unknown): DeckSlide[] {
  if (!Array.isArray(slides)) {
    throw new BadRequestException('slides must be an array');
  }
  if (slides.length > 40) {
    throw new BadRequestException('slides must not exceed 40 entries');
  }

  slides.forEach((slide, index) => {
    if (typeof slide !== 'object' || slide === null) {
      fail(index, 'must be an object');
    }
    const record = slide as Record<string, unknown>;

    const layout = record.layout;
    if (typeof layout !== 'string') {
      fail(index, 'layout is required');
    }
    if (!(SLIDE_LAYOUTS as readonly string[]).includes(layout)) {
      fail(index, `layout must be one of ${SLIDE_LAYOUTS.join(', ')}`);
    }

    switch (layout as SlideLayout) {
      case 'text':
        validateTextSlide(record, index);
        break;
      case 'image':
        validateImageSlide(record, index);
        break;
      case 'stat':
        validateStatSlide(record, index);
        break;
      case 'interactive':
        validateInteractiveSlide(record, index);
        break;
    }
  });

  return slides as DeckSlide[];
}
