import {
  EMAIL_BLOCK_TYPES,
  EMAIL_LIMITS,
  EMAIL_SPACER_SIZES,
  EMAIL_TEMPLATE_LOCALES,
  EmailBlock,
  EmailBlockType,
  EmailLocaleContent,
  EmailSpacerSize,
  EmailTemplateLocale,
  EmailTemplateLocales,
} from './email-template-content';
import {
  EMAIL_TEMPLATE_PURPOSES,
  EmailTemplatePurpose,
  placeholdersIn,
} from './email-template-purposes';

/**
 * The single write-boundary check for a template's `locales` jsonb.
 *
 * A pure function over `unknown` rather than nested class-validator DTOs: a
 * union of seven block types reads more clearly as one tested function, and it
 * returns normalised content (trimmed, unknown fields dropped) so the row only
 * ever stores the shape the frontend renders.
 *
 * Every error is prefixed with a path such as `en.blocks[2].href` so the editor
 * can show the admin exactly which language and block to fix.
 */
export type LocalesValidationResult =
  | { isValid: true; locales: EmailTemplateLocales }
  | { isValid: false; errors: string[] };

const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/;
const WHOLE_PLACEHOLDER = /^\{[a-zA-Z][a-zA-Z0-9]*\}$/;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Email clients strip all of these anyway; rejecting them keeps the stored
 *  HTML honest about what a recipient will actually get. */
const FORBIDDEN_MARKUP: ReadonlyArray<[RegExp, string]> = [
  [/<script\b/i, '<script>'],
  [/<iframe\b/i, '<iframe>'],
  [/<form\b/i, '<form>'],
  [/\son[a-z]+\s*=/i, 'inline event handlers (on...=)'],
  [/javascript:/i, 'javascript: URLs'],
];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUrlOrPlaceholder(value: string): boolean {
  return HTTPS_URL.test(value) || WHOLE_PLACEHOLDER.test(value);
}

function readText(
  record: UnknownRecord,
  key: string,
  path: string,
  max: number,
  errors: string[],
): string | null {
  const value = record[key];
  if (typeof value !== 'string') {
    errors.push(`${path}.${key}: must be text`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push(`${path}.${key}: is required`);
    return null;
  }
  if (trimmed.length > max) {
    errors.push(`${path}.${key}: must be at most ${max} characters`);
    return null;
  }
  return trimmed;
}

function lintMarkup(html: string, path: string, errors: string[]): void {
  for (const [pattern, name] of FORBIDDEN_MARKUP) {
    if (pattern.test(html)) {
      errors.push(`${path}: ${name} is not allowed in an email`);
    }
  }
}

function lintParagraphLinks(
  text: string,
  path: string,
  errors: string[],
): void {
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const url = match[2] ?? '';
    if (!isUrlOrPlaceholder(url)) {
      errors.push(
        `${path}: links must use an https:// address or a placeholder`,
      );
      return;
    }
  }
}

function validateBlock(
  raw: unknown,
  path: string,
  errors: string[],
): EmailBlock | null {
  if (!isRecord(raw)) {
    errors.push(`${path}: must be a block`);
    return null;
  }
  const id = readText(raw, 'id', path, EMAIL_LIMITS.blockId, errors);
  const type = raw.type as EmailBlockType;
  if (!EMAIL_BLOCK_TYPES.includes(type)) {
    errors.push(`${path}.type: unknown block type`);
    return null;
  }
  if (id === null) return null;
  const errorCountBefore = errors.length;
  const block = readBlockFields(raw, id, type, path, errors);
  return errors.length === errorCountBefore ? block : null;
}

function readBlockFields(
  raw: UnknownRecord,
  id: string,
  type: EmailBlockType,
  path: string,
  errors: string[],
): EmailBlock | null {
  switch (type) {
    case 'heading': {
      const text = readText(
        raw,
        'text',
        path,
        EMAIL_LIMITS.headingText,
        errors,
      );
      const level = raw.level === 2 ? 2 : raw.level === 1 ? 1 : null;
      if (level === null) errors.push(`${path}.level: must be 1 or 2`);
      return text === null || level === null ? null : { id, type, text, level };
    }
    case 'paragraph': {
      const text = readText(
        raw,
        'text',
        path,
        EMAIL_LIMITS.paragraphText,
        errors,
      );
      if (text !== null) lintParagraphLinks(text, `${path}.text`, errors);
      return text === null ? null : { id, type, text };
    }
    case 'button': {
      const label = readText(
        raw,
        'label',
        path,
        EMAIL_LIMITS.buttonLabel,
        errors,
      );
      const href = readText(raw, 'href', path, EMAIL_LIMITS.url, errors);
      if (href !== null && !isUrlOrPlaceholder(href)) {
        errors.push(
          `${path}.href: must be an https:// address or a single placeholder`,
        );
      }
      return label === null || href === null ? null : { id, type, label, href };
    }
    case 'image': {
      const src = readText(raw, 'src', path, EMAIL_LIMITS.url, errors);
      if (src !== null && !HTTPS_URL.test(src)) {
        errors.push(`${path}.src: must be an https:// address`);
      }
      const alt = readText(raw, 'alt', path, EMAIL_LIMITS.imageAlt, errors);
      const width = raw.width;
      const isWidthValid =
        typeof width === 'number' &&
        Number.isInteger(width) &&
        width >= 1 &&
        width <= EMAIL_LIMITS.imageWidth;
      if (!isWidthValid) {
        errors.push(
          `${path}.width: must be a whole number from 1 to ${EMAIL_LIMITS.imageWidth}`,
        );
      }
      return src === null || alt === null || !isWidthValid
        ? null
        : { id, type, src, alt, width };
    }
    case 'divider':
      return { id, type };
    case 'spacer': {
      const size = raw.size as EmailSpacerSize;
      if (!EMAIL_SPACER_SIZES.includes(size)) {
        errors.push(`${path}.size: must be sm, md or lg`);
        return null;
      }
      return { id, type, size };
    }
    case 'html': {
      const html = readText(raw, 'html', path, EMAIL_LIMITS.htmlBlock, errors);
      if (html !== null) lintMarkup(html, `${path}.html`, errors);
      return html === null ? null : { id, type, html };
    }
  }
}

/** Every piece of admin-written text in a language, for the placeholder scan. */
function textsOf(content: EmailLocaleContent): string[] {
  const texts = [content.subject, content.html ?? ''];
  for (const block of content.blocks) {
    if (block.type === 'heading' || block.type === 'paragraph')
      texts.push(block.text);
    if (block.type === 'button') texts.push(block.label, block.href);
    if (block.type === 'image') texts.push(block.alt);
    if (block.type === 'html') texts.push(block.html);
  }
  return texts;
}

function checkPlaceholders(
  content: EmailLocaleContent,
  locale: EmailTemplateLocale,
  purpose: EmailTemplatePurpose,
  errors: string[],
): void {
  const allowed: readonly string[] = EMAIL_TEMPLATE_PURPOSES[purpose];
  const allowedList =
    allowed.length === 0
      ? 'none'
      : allowed.map((token) => `{${token}}`).join(', ');
  const unknown = placeholdersIn(textsOf(content).join('\n')).filter(
    (token) => !allowed.includes(token),
  );
  for (const token of unknown) {
    errors.push(
      `${locale}: {${token}} is not a placeholder for ${purpose}. Allowed: ${allowedList}`,
    );
  }
}

function validateLocale(
  raw: unknown,
  locale: EmailTemplateLocale,
  purpose: EmailTemplatePurpose,
  errors: string[],
): EmailLocaleContent | null {
  if (!isRecord(raw)) {
    errors.push(`${locale}: must be an object`);
    return null;
  }
  const errorCountBefore = errors.length;
  const subject = readText(
    raw,
    'subject',
    locale,
    EMAIL_LIMITS.subject,
    errors,
  );
  const mode =
    raw.mode === 'html' ? 'html' : raw.mode === 'blocks' ? 'blocks' : null;
  if (mode === null) errors.push(`${locale}.mode: must be blocks or html`);

  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : null;
  if (rawBlocks === null) errors.push(`${locale}.blocks: must be a list`);
  if (rawBlocks !== null && rawBlocks.length > EMAIL_LIMITS.blocksPerLocale) {
    errors.push(
      `${locale}.blocks: at most ${EMAIL_LIMITS.blocksPerLocale} blocks`,
    );
  }
  const blocks = (rawBlocks ?? [])
    .slice(0, EMAIL_LIMITS.blocksPerLocale)
    .map((block, index) =>
      validateBlock(block, `${locale}.blocks[${index}]`, errors),
    )
    .filter((block): block is EmailBlock => block !== null);
  if (mode === 'blocks' && rawBlocks !== null && rawBlocks.length === 0) {
    errors.push(`${locale}.blocks: add at least one block`);
  }

  let html: string | null = null;
  if (mode === 'html') {
    html = readText(raw, 'html', locale, EMAIL_LIMITS.html, errors);
    if (html !== null) lintMarkup(html, `${locale}.html`, errors);
  }

  if (errors.length !== errorCountBefore || subject === null || mode === null) {
    return null;
  }
  const content: EmailLocaleContent = { subject, mode, blocks, html };
  checkPlaceholders(content, locale, purpose, errors);
  return errors.length === errorCountBefore ? content : null;
}

export function validateEmailTemplateLocales(
  value: unknown,
  purpose: EmailTemplatePurpose,
): LocalesValidationResult {
  if (!isRecord(value)) {
    return {
      isValid: false,
      errors: ['locales: must be an object with an en entry'],
    };
  }
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!(EMAIL_TEMPLATE_LOCALES as readonly string[]).includes(key)) {
      errors.push(`locales.${key}: unsupported language`);
    }
  }
  if (value.en === undefined || value.en === null) {
    errors.push('locales.en: English is required');
  }
  const english =
    value.en === undefined || value.en === null
      ? null
      : validateLocale(value.en, 'en', purpose, errors);
  const portuguese =
    value.pt === undefined || value.pt === null
      ? undefined
      : validateLocale(value.pt, 'pt', purpose, errors);

  if (errors.length > 0 || english === null || portuguese === null) {
    return { isValid: false, errors };
  }
  return {
    isValid: true,
    locales: portuguese ? { en: english, pt: portuguese } : { en: english },
  };
}
