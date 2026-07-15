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
