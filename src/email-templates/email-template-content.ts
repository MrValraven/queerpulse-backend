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
  'hero',
  'ticket',
  'featureList',
  'signature',
] as const;
export type EmailBlockType = (typeof EMAIL_BLOCK_TYPES)[number];

export const EMAIL_SPACER_SIZES = ['sm', 'md', 'lg'] as const;
export type EmailSpacerSize = (typeof EMAIL_SPACER_SIZES)[number];

/** The icons a feature list row can wear. Each one is a hosted PNG on the
 *  frontend (`design/emailAssets.ts`), which ships exactly this list. */
export const EMAIL_FEATURE_ICONS = [
  'communities',
  'gatherings',
  'directory',
  'messages',
  'magazine',
  'safety',
] as const;
export type EmailFeatureIcon = (typeof EMAIL_FEATURE_ICONS)[number];

export interface EmailFeatureItem {
  icon: EmailFeatureIcon;
  title: string;
  text: string;
}

/** A feature list holds one to this many rows. */
export const EMAIL_FEATURE_ITEMS_MAX = 4;

export type EmailBlock =
  | { id: string; type: 'heading'; text: string; level: 1 | 2 }
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'button'; label: string; href: string }
  | { id: string; type: 'image'; src: string; alt: string; width: number }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; size: EmailSpacerSize }
  | { id: string; type: 'html'; html: string }
  /** The opening moment. `eyebrow` and `text` may be empty strings. */
  | {
      id: string;
      type: 'hero';
      eyebrow: string;
      headline: string;
      text: string;
    }
  /** The invite as a pass, with its button inside. `text` may be empty. */
  | {
      id: string;
      type: 'ticket';
      label: string;
      title: string;
      text: string;
      buttonLabel: string;
      href: string;
    }
  | { id: string; type: 'featureList'; items: EmailFeatureItem[] }
  /** A person signing the email. `role`, `note` and `photoUrl` may be empty. */
  | {
      id: string;
      type: 'signature';
      name: string;
      role: string;
      note: string;
      photoUrl: string;
    };

export type EmailContentMode = 'blocks' | 'html';

export interface EmailLocaleContent {
  subject: string;
  /** The grey line an inbox shows after the subject. Stored only when it is
   *  non-empty, so rows saved before it existed look the same as new ones. */
  preheader?: string;
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
  preheader: 200,
  heroEyebrow: 60,
  heroHeadline: 200,
  heroText: 600,
  ticketLabel: 60,
  ticketTitle: 200,
  ticketText: 600,
  featureTitle: 80,
  featureText: 300,
  signatureName: 80,
  signatureRole: 120,
  signatureNote: 200,
} as const;
