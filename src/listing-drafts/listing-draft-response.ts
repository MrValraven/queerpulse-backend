import { ListingDraft } from './entities/listing-draft.entity';

/**
 * Hand-mapped response shapes for listing drafts. There is NO global
 * serializer in this codebase — entities are mapped to DTOs by hand so that a
 * column is never leaked by accident. In particular the `resumeToken` and
 * `userId` columns are NEVER placed on any response DTO: the token is only
 * ever delivered out of band (the resume-link email), never handed back to the
 * browser that could then share it.
 */

/** A row in `GET /listing-drafts` — enough to render the "resume a draft" list. */
export interface ListingDraftSummaryDTO {
  id: string;
  name: string;
  updatedAt: string;
}

/** The full draft returned by `GET /listing-drafts/:id` and the resume route. */
export interface ListingDraftDetailDTO {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Derive a human display name from the opaque wizard payload. The wizard's
 * business-name field is `name` (mirrors `CreateListingDto.name`); anything
 * else (blank draft, malformed payload) falls back to a stable placeholder so
 * the list never shows an empty row.
 */
export function deriveListingDraftName(
  payload: Record<string, unknown>,
): string {
  const rawName = payload?.name;
  if (typeof rawName === 'string' && rawName.trim().length > 0) {
    return rawName.trim();
  }
  return 'Untitled listing';
}

export function toListingDraftSummaryDTO(
  draft: ListingDraft,
): ListingDraftSummaryDTO {
  return {
    id: draft.id,
    name: deriveListingDraftName(draft.payload),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

export function toListingDraftDetailDTO(
  draft: ListingDraft,
): ListingDraftDetailDTO {
  return {
    id: draft.id,
    payload: draft.payload,
  };
}
