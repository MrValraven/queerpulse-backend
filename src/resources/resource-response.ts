import { GlossaryTerm } from './entities/glossary-term.entity';
import { Resource } from './entities/resource.entity';

// Mirrors `contracts.ts`'s `ResourceResponse` exactly (slug/category/title/
// description/body/meta/externalUrl) — list and detail share this one shape
// since the frontend contract declares no separate list-item type.
export interface ResourceResponseDTO {
  slug: string;
  category: string;
  title: string;
  description: string;
  body: string;
  meta: string | null;
  externalUrl: string | null;
  /** ISO timestamp of the last editorial verification, or null if never verified. */
  lastVerifiedAt: string | null;
}

// Mirrors `contracts.ts`'s `GlossaryTermResponse` exactly.
export interface GlossaryTermResponseDTO {
  slug: string;
  term: string;
  definition: string;
  category: string | null;
}

export function toResourceResponse(resource: Resource): ResourceResponseDTO {
  return {
    slug: resource.slug,
    category: resource.category,
    title: resource.title,
    description: resource.description,
    body: resource.body,
    meta: resource.meta,
    externalUrl: resource.externalUrl,
    lastVerifiedAt: resource.lastVerifiedAt
      ? resource.lastVerifiedAt.toISOString()
      : null,
  };
}

/**
 * Lightweight row for the cross-entity global search (`SearchService`) — the
 * body/meta columns stay out of it. Mapped to a `SearchResultDTO` by hand in
 * `search/search-response.ts`.
 */
export interface ResourceSearchRow {
  slug: string;
  title: string;
  category: string;
}

export function toResourceSearchRow(resource: Resource): ResourceSearchRow {
  return {
    slug: resource.slug,
    title: resource.title,
    category: resource.category,
  };
}

export function toGlossaryTermResponse(
  term: GlossaryTerm,
): GlossaryTermResponseDTO {
  return {
    slug: term.slug,
    term: term.term,
    definition: term.definition,
    category: term.category,
  };
}
