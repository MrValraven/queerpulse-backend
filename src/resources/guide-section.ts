/**
 * The structured body of an editorially-managed resource guide.
 *
 * A guide's prose used to live in the frontend i18n catalogs, meaning a
 * paragraph change was an engineer editing two catalog files and shipping a
 * deploy. This shape is what replaces that: an ordered list of sections, each
 * an H2 plus ordered blocks, stored as JSONB on `resources.sections` (English)
 * and `resources.sections_pt` (Portuguese). It is deliberately small (four
 * block kinds, no nesting) so a non-engineer editor can hold the whole model
 * in their head. Paragraph, list item and note blocks may carry sanitized
 * inline HTML (em, strong, a, br) in `html`; the service sanitizes it on write
 * and derives `text` from it.
 *
 * A guide with an EMPTY `sections` array is not managed yet: the frontend
 * keeps rendering its hardcoded page and the row exists only to carry the
 * title, category, route and the review dates. Adding a section in the admin
 * editor is what takes the page over.
 */
export type GuideBlockKind = 'paragraph' | 'subheading' | 'listItem' | 'note';

export interface GuideBlock {
  kind: GuideBlockKind;
  /** Plain text. Always present; derived from `html` on write when `html` is set. */
  text: string;
  /** Sanitized inline HTML (em, strong, a, br). Only on formatted kinds. */
  html?: string;
}

export interface GuideSection {
  /** Anchor id, unique within the guide (e.g. "what", "outro"). */
  id: string;
  /** H2 for the section. Empty string renders an unheaded lead section. */
  heading: string;
  blocks: GuideBlock[];
}

export const GUIDE_BLOCK_KINDS: GuideBlockKind[] = [
  'paragraph',
  'subheading',
  'listItem',
  'note',
];

/** The block kinds that accept inline formatting. Subheadings stay plain. */
export const FORMATTED_GUIDE_BLOCK_KINDS: GuideBlockKind[] = [
  'paragraph',
  'listItem',
  'note',
];

export function isFormattedGuideBlockKind(kind: GuideBlockKind): boolean {
  return FORMATTED_GUIDE_BLOCK_KINDS.includes(kind);
}

/** Upper bounds, enforced by the DTO validators and re-checked here so a
 *  hand-written migration cannot smuggle an oversized body past the API. */
export const MAX_GUIDE_SECTIONS = 40;
export const MAX_GUIDE_BLOCKS_PER_SECTION = 60;
export const MAX_GUIDE_BLOCK_LENGTH = 4000;
export const MAX_GUIDE_BLOCK_HTML_LENGTH = 8000;

/**
 * Narrows an untrusted JSONB value read back from Postgres. Anything that
 * fails the shape check is dropped rather than thrown on: a malformed row
 * should degrade to "not managed yet" (the hardcoded page) instead of 500ing
 * a health guide.
 */
export function parseGuideSections(value: unknown): GuideSection[] {
  if (!Array.isArray(value)) return [];
  const sections: GuideSection[] = [];
  for (const raw of value.slice(0, MAX_GUIDE_SECTIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.id !== 'string') continue;
    const heading =
      typeof candidate.heading === 'string' ? candidate.heading : '';
    const blocks: GuideBlock[] = [];
    if (Array.isArray(candidate.blocks)) {
      for (const rawBlock of candidate.blocks.slice(
        0,
        MAX_GUIDE_BLOCKS_PER_SECTION,
      )) {
        if (!rawBlock || typeof rawBlock !== 'object') continue;
        const block = rawBlock as Record<string, unknown>;
        const kind = block.kind;
        if (typeof block.text !== 'string' || !block.text.trim()) continue;
        if (!GUIDE_BLOCK_KINDS.includes(kind as GuideBlockKind)) continue;
        const parsedKind = kind as GuideBlockKind;
        const parsedBlock: GuideBlock = {
          kind: parsedKind,
          text: block.text.slice(0, MAX_GUIDE_BLOCK_LENGTH),
        };
        if (
          typeof block.html === 'string' &&
          isFormattedGuideBlockKind(parsedKind)
        ) {
          parsedBlock.html = block.html.slice(0, MAX_GUIDE_BLOCK_HTML_LENGTH);
        }
        blocks.push(parsedBlock);
      }
    }
    if (!heading && blocks.length === 0) continue;
    sections.push({ id: candidate.id, heading, blocks });
  }
  return sections;
}
