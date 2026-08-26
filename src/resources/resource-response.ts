import { GlossaryTerm } from './entities/glossary-term.entity';
import { Resource } from './entities/resource.entity';
import { GuideSection, parseGuideSections } from './guide-section';

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
  /** Portuguese title/description, or null when the guide has no translation
   *  yet — the frontend falls back to the English copy. */
  titlePt: string | null;
  descriptionPt: string | null;
  /** The editor-authored prose. An EMPTY array means this guide is not
   *  managed yet and the frontend keeps rendering its hardcoded page. */
  sections: GuideSection[];
  /** Portuguese prose, or null when never translated. */
  sectionsPt: GuideSection[] | null;
  /** Frontend path this guide is addressable at, e.g. "/resources/sober". */
  routePath: string | null;
  /** ISO date (YYYY-MM-DD) an editor last read the guide end to end, who
   *  that was, and when it is due again. All null means never reviewed. */
  lastReviewedOn: string | null;
  reviewedBy: string | null;
  reviewDueOn: string | null;
}

/** Compact row for the guide index (`GET /resources/index`) — every
 *  published guide with just what a category-grouped link list needs. Keeps
 *  the index one small request instead of paging the full library. */
export interface ResourceIndexEntryDTO {
  slug: string;
  category: string;
  title: string;
  description: string;
  routePath: string | null;
  lastReviewedOn: string | null;
  /** True when the guide's body lives in the database (the renderer takes
   *  the page over); false while its hardcoded page is still the source. */
  isManaged: boolean;
}

export function toResourceIndexEntry(
  resource: Resource,
): ResourceIndexEntryDTO {
  const sections = parseGuideSections(resource.sections);
  return {
    slug: resource.slug,
    category: resource.category,
    title: resource.title,
    description: resource.description,
    routePath: resource.routePath,
    lastReviewedOn: resource.lastReviewedOn,
    isManaged: sections.length > 0,
  };
}

// Mirrors `contracts.ts`'s `GlossaryTermResponse` exactly.
export interface GlossaryTermResponseDTO {
  slug: string;
  term: string;
  definition: string;
  /** Portuguese definition, or null when the term has no translation yet. */
  definitionPt: string | null;
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
    titlePt: resource.titlePt,
    descriptionPt: resource.descriptionPt,
    sections: parseGuideSections(resource.sections),
    sectionsPt:
      resource.sectionsPt === null
        ? null
        : parseGuideSections(resource.sectionsPt),
    routePath: resource.routePath,
    lastReviewedOn: resource.lastReviewedOn,
    reviewedBy: resource.reviewedBy,
    reviewDueOn: resource.reviewDueOn,
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
    definitionPt: term.definitionPt,
    category: term.category,
  };
}

// ── Admin shapes ────────────────────────────────────────────────────────────

/** Admin view of a guide: the public shape plus the publish state and the
 *  audit timestamps an editor needs to see. `updatedBy` stays out — the CRUD
 *  table shows the content, not which staff member touched it (mirrors
 *  `AdminResourceListingDTO`). */
export interface AdminResourceDTO extends ResourceResponseDTO {
  id: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAdminResourceResponse(resource: Resource): AdminResourceDTO {
  return {
    ...toResourceResponse(resource),
    id: resource.id,
    publishedAt: resource.publishedAt
      ? resource.publishedAt.toISOString()
      : null,
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
  };
}

/** Admin view of a glossary term — the public shape plus its id and the
 *  review fields the staleness list sorts on. */
export interface AdminGlossaryTermDTO extends GlossaryTermResponseDTO {
  id: string;
  lastReviewedOn: string | null;
  reviewedBy: string | null;
  reviewDueOn: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAdminGlossaryTermResponse(
  term: GlossaryTerm,
): AdminGlossaryTermDTO {
  return {
    ...toGlossaryTermResponse(term),
    id: term.id,
    lastReviewedOn: term.lastReviewedOn,
    reviewedBy: term.reviewedBy,
    reviewDueOn: term.reviewDueOn,
    createdAt: term.createdAt.toISOString(),
    updatedAt: term.updatedAt.toISOString(),
  };
}
