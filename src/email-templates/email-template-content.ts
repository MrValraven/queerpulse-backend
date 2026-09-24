/**
 * The stored shape of one email template's content, shared by the entity, the
 * validator and the seed. Mirrored by hand in the frontend at
 * `src/features/admin/emailTemplates/emailTemplate.types.ts`; change both.
 *
 * Each language holds BOTH its blocks and, while it is in HTML mode, its custom
 * HTML. The blocks are kept so "Back to blocks" can restore them: HTML is never
 * parsed back into blocks.
 */
export const EMAIL_TEMPLATE_LOCALES = ['en', 'pt'] as const;
export type EmailTemplateLocale = (typeof EMAIL_TEMPLATE_LOCALES)[number];

export const EMAIL_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'button',
  'image',
  'divider',
  'spacer',
  'html',
] as const;
export type EmailBlockType = (typeof EMAIL_BLOCK_TYPES)[number];

export const EMAIL_SPACER_SIZES = ['sm', 'md', 'lg'] as const;
export type EmailSpacerSize = (typeof EMAIL_SPACER_SIZES)[number];

export type EmailBlock =
  | { id: string; type: 'heading'; text: string; level: 1 | 2 }
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'button'; label: string; href: string }
  | { id: string; type: 'image'; src: string; alt: string; width: number }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; size: EmailSpacerSize }
  | { id: string; type: 'html'; html: string };

export type EmailContentMode = 'blocks' | 'html';

export interface EmailLocaleContent {
  subject: string;
  mode: EmailContentMode;
  blocks: EmailBlock[];
  /** Set only while `mode` is `html`. */
  html: string | null;
}

export interface EmailTemplateLocales {
  en: EmailLocaleContent;
  pt?: EmailLocaleContent;
}

export const EMAIL_LIMITS = {
  subject: 200,
  headingText: 200,
  paragraphText: 2000,
  buttonLabel: 60,
  url: 2000,
  imageAlt: 200,
  imageWidth: 600,
  htmlBlock: 20_000,
  html: 100_000,
  blocksPerLocale: 50,
  blockId: 64,
} as const;
