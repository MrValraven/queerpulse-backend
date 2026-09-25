import {
  EMAIL_BLOCK_TYPES,
  EMAIL_FEATURE_ICONS,
  EMAIL_FEATURE_ITEMS_MAX,
  EMAIL_LIMITS,
  EMAIL_SPACER_SIZES,
  EMAIL_TEMPLATE_LOCALES,
  EmailBlock,
  EmailBlockType,
  EmailFeatureIcon,
  EmailFeatureItem,
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
 * union of eleven block types reads more clearly as one tested function, and it
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

/** Like `readText` for a field that may be left empty: a missing or blank
 *  value reads as `''`. */
function readOptionalText(
  record: UnknownRecord,
  key: string,
  path: string,
  max: number,
  errors: string[],
): string | null {
  const value = record[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors.push(`${path}.${key}: must be text`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    errors.push(`${path}.${key}: must be at most ${max} characters`);
    return null;
  }
  return trimmed;
}

/** A link target: an https URL or one whole placeholder such as
 *  `{inviteLink}`, the rule a button and a ticket share. */
function readHref(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): string | null {
  const href = readText(record, key, path, EMAIL_LIMITS.url, errors);
  if (href !== null && !isUrlOrPlaceholder(href)) {
    errors.push(
      `${path}.${key}: must be an https:// address or a single placeholder`,
    );
    return null;
  }
  return href;
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
      const href = readHref(raw, 'href', path, errors);
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
    case 'hero':
      return readHeroFields(raw, id, path, errors);
    case 'ticket':
      return readTicketFields(raw, id, path, errors);
    case 'featureList':
      return readFeatureListFields(raw, id, path, errors);
    case 'signature':
      return readSignatureFields(raw, id, path, errors);
  }
}

function readHeroFields(
  raw: UnknownRecord,
  id: string,
  path: string,
  errors: string[],
): EmailBlock | null {
  const eyebrow = readOptionalText(
    raw,
    'eyebrow',
    path,
    EMAIL_LIMITS.heroEyebrow,
    errors,
  );
  const headline = readText(
    raw,
    'headline',
    path,
    EMAIL_LIMITS.heroHeadline,
    errors,
  );
  const text = readOptionalText(
    raw,
    'text',
    path,
    EMAIL_LIMITS.heroText,
    errors,
  );
  if (text !== null) lintParagraphLinks(text, `${path}.text`, errors);
  return eyebrow === null || headline === null || text === null
    ? null
    : { id, type: 'hero', eyebrow, headline, text };
}

function readTicketFields(
  raw: UnknownRecord,
  id: string,
  path: string,
  errors: string[],
): EmailBlock | null {
  const label = readText(raw, 'label', path, EMAIL_LIMITS.ticketLabel, errors);
  const title = readText(raw, 'title', path, EMAIL_LIMITS.ticketTitle, errors);
  const text = readOptionalText(
    raw,
    'text',
    path,
    EMAIL_LIMITS.ticketText,
    errors,
  );
  if (text !== null) lintParagraphLinks(text, `${path}.text`, errors);
  const buttonLabel = readText(
    raw,
    'buttonLabel',
    path,
    EMAIL_LIMITS.buttonLabel,
    errors,
  );
  const href = readHref(raw, 'href', path, errors);
  if (
    label === null ||
    title === null ||
    text === null ||
    buttonLabel === null ||
    href === null
  ) {
    return null;
  }
  return { id, type: 'ticket', label, title, text, buttonLabel, href };
}

function readFeatureItem(
  raw: unknown,
  path: string,
  errors: string[],
): EmailFeatureItem | null {
  if (!isRecord(raw)) {
    errors.push(`${path}: must be an item`);
    return null;
  }
  const icon = raw.icon as EmailFeatureIcon;
  const isIconKnown = EMAIL_FEATURE_ICONS.includes(icon);
  if (!isIconKnown) {
    errors.push(
      `${path}.icon: must be one of ${EMAIL_FEATURE_ICONS.join(', ')}`,
    );
  }
  const title = readText(raw, 'title', path, EMAIL_LIMITS.featureTitle, errors);
  const text = readText(raw, 'text', path, EMAIL_LIMITS.featureText, errors);
  if (text !== null) lintParagraphLinks(text, `${path}.text`, errors);
  return !isIconKnown || title === null || text === null
    ? null
    : { icon, title, text };
}

function readFeatureListFields(
  raw: UnknownRecord,
  id: string,
  path: string,
  errors: string[],
): EmailBlock | null {
  if (!Array.isArray(raw.items)) {
    errors.push(`${path}.items: must be a list`);
    return null;
  }
  const rawItems: unknown[] = raw.items;
  if (rawItems.length === 0) {
    errors.push(`${path}.items: add at least one item`);
    return null;
  }
  if (rawItems.length > EMAIL_FEATURE_ITEMS_MAX) {
    errors.push(`${path}.items: at most ${EMAIL_FEATURE_ITEMS_MAX} items`);
    return null;
  }
  const items = rawItems.map((item, index) =>
    readFeatureItem(item, `${path}.items[${index}]`, errors),
  );
  return items.every((item): item is EmailFeatureItem => item !== null)
    ? { id, type: 'featureList', items }
    : null;
}

function readSignatureFields(
  raw: UnknownRecord,
  id: string,
  path: string,
  errors: string[],
): EmailBlock | null {
  const name = readText(raw, 'name', path, EMAIL_LIMITS.signatureName, errors);
  const role = readOptionalText(
    raw,
    'role',
    path,
    EMAIL_LIMITS.signatureRole,
    errors,
  );
  const note = readOptionalText(
    raw,
    'note',
    path,
    EMAIL_LIMITS.signatureNote,
    errors,
  );
  const photoUrl = readOptionalText(
    raw,
    'photoUrl',
    path,
    EMAIL_LIMITS.url,
    errors,
  );
  const isPhotoUrlValid =
    photoUrl !== null && (photoUrl === '' || HTTPS_URL.test(photoUrl));
  if (photoUrl !== null && !isPhotoUrlValid) {
    errors.push(`${path}.photoUrl: must be an https:// address`);
  }
  return name === null || role === null || note === null || !isPhotoUrlValid
    ? null
    : { id, type: 'signature', name, role, note, photoUrl };
}

function textsOfBlock(block: EmailBlock): string[] {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return [block.text];
    case 'button':
      return [block.label, block.href];
    case 'image':
      return [block.alt];
    case 'html':
      return [block.html];
    case 'hero':
      return [block.eyebrow, block.headline, block.text];
    case 'ticket':
      return [
        block.label,
        block.title,
        block.text,
        block.buttonLabel,
        block.href,
      ];
    case 'featureList':
      return block.items.flatMap((item) => [item.title, item.text]);
    case 'signature':
      return [block.name, block.role, block.note, block.photoUrl];
    case 'divider':
    case 'spacer':
      return [];
  }
}

/** Every piece of admin-written text in a language, for the placeholder scan. */
function textsOf(content: EmailLocaleContent): string[] {
  const texts = [content.subject, content.preheader ?? '', content.html ?? ''];
  for (const block of content.blocks) {
    texts.push(...textsOfBlock(block));
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
  const preheader = readOptionalText(
    raw,
    'preheader',
    locale,
    EMAIL_LIMITS.preheader,
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

  if (
    errors.length !== errorCountBefore ||
    subject === null ||
    preheader === null ||
    mode === null
  ) {
    return null;
  }
  // An empty preheader is left off the row entirely, so a row saved before
  // the field existed and a new one without it have the same shape.
  const content: EmailLocaleContent =
    preheader === ''
      ? { subject, mode, blocks, html }
      : { subject, preheader, mode, blocks, html };
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
