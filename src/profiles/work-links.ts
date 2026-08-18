import { WorkLink } from './entities/work-item.entity';

// The loose shape that arrives from `WorkLinkDto`. `kind` is narrowed and the
// per-kind fields (`entity`+`slug` for 'ref', `href` for 'external') are
// required by `WorkLinkDto`'s `@ValidateIf`+`@IsString()`/`@IsUrl()` pairing
// before this reaches normalizeWorkLinks, so a malformed entry never reaches
// storage — mirrors `OpenToEntryInput`/`normalizeOpenTo` (open-to.ts).
export interface WorkLinkInput {
  kind: string;
  entity?: string;
  slug?: string;
  href?: string;
}

/**
 * Narrows the DTO's loose `WorkLinkInput[]` into the strict `WorkLink[]`
 * discriminated union the entity stores. Defensive, not just a cast: an entry
 * missing its kind-required field (which validation should already have
 * rejected) is silently dropped rather than persisted half-formed.
 */
export function normalizeWorkLinks(entries: WorkLinkInput[]): WorkLink[] {
  const out: WorkLink[] = [];
  for (const entry of entries) {
    if (entry.kind === 'ref' && entry.entity && entry.slug) {
      out.push({ kind: 'ref', entity: entry.entity, slug: entry.slug });
    } else if (entry.kind === 'external' && entry.href) {
      out.push({ kind: 'external', href: entry.href });
    }
  }
  return out;
}
