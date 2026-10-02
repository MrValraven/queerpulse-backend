import { MemberRef } from '../common/member-ref';
import { ListingDraft } from './entities/listing-draft.entity';

/**
 * Hand-mapped response shapes for listing drafts. There is NO global
 * serializer in this codebase — entities are mapped to DTOs by hand so that a
 * column is never leaked by accident. In particular the `resumeToken` column
 * is NEVER placed on any response DTO: the token is the resume link's only
 * secret, so it is never handed back to a browser that could then share it.
 * Nothing delivers it either, since QueerPulse delivers no email. `userId` is
 * likewise absent from every member-facing shape; it appears only as the
 * owner's id on the Admin-only `AdminListingDraftDTO`, where the official
 * messages route needs it.
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
 * The wizard state inside the opaque payload. The frontend saves
 * `{ draft: ListingDraft, step: number }` (its `ListingDraftPayload`), so the
 * form fields live one level down under `draft`. A payload with no object at
 * `draft` is read as the wizard state itself, so a flat payload still yields
 * its `name`.
 */
function readWizardState(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const nested = payload?.draft;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return payload ?? {};
}

function readTrimmedString(source: Record<string, unknown>, key: string) {
  const raw = source[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Derive a human display name from the opaque wizard payload. The wizard's
 * business-name field is `draft.name` (mirrors `CreateListingDto.name`);
 * anything else (blank draft, malformed payload) falls back to a stable
 * placeholder so the list never shows an empty row.
 *
 * This used to read `payload.name`, one level too high for the payload the
 * frontend actually saves, so every member's drafts list read "Untitled
 * listing" whatever they had typed.
 */
export function deriveListingDraftName(
  payload: Record<string, unknown>,
): string {
  return (
    readTrimmedString(readWizardState(payload), 'name') || 'Untitled listing'
  );
}

/** The wizard paths a draft can be on (`ListingPath` on the frontend). */
const LISTING_DRAFT_PATHS = ['claim', 'suggest'] as const;
type ListingDraftPath = (typeof LISTING_DRAFT_PATHS)[number];

/** The member who started a draft, as staff see it. `userId` rides along
 *  because the reach-out action, `POST /admin/official-messages/members/:id`,
 *  is keyed by it. */
export interface ListingDraftOwnerDTO extends MemberRef {
  userId: string;
}

/**
 * A row in `GET /admin/listing-drafts`: a SUMMARY of a member's unfinished
 * draft, never its payload. The payload carries the owner's outing and guide
 * consent decisions and their personal bio, which even the listing moderation
 * queue withholds from staff (`toDirectoryModerationListingDTO`). Four fields
 * are read out of it here, each type-checked because the payload is opaque
 * client-written JSON, and nothing else from it leaves this mapper. Only
 * `GET /admin/listing-drafts/:id` returns more, and only the business half
 * (`AdminListingDraftDetailDTO`).
 */
export interface AdminListingDraftDTO {
  id: string;
  /** The place name typed so far; `''` when none (the UI supplies a label). */
  name: string;
  hood: string;
  /** `''` until the member picks a path. */
  path: ListingDraftPath | '';
  /** Zero-based wizard step reached; `0` when absent or malformed. */
  step: number;
  /** `null` when the owner has no profile to show. */
  owner: ListingDraftOwnerDTO | null;
  createdAt: string;
  updatedAt: string;
}

export function toAdminListingDraftDTO(
  draft: ListingDraft,
  ownerRef: MemberRef | null,
): AdminListingDraftDTO {
  const wizardState = readWizardState(draft.payload);
  const rawPath = readTrimmedString(wizardState, 'path');
  const rawStep = draft.payload?.step;
  return {
    id: draft.id,
    name: readTrimmedString(wizardState, 'name'),
    hood: readTrimmedString(wizardState, 'hood'),
    path: (LISTING_DRAFT_PATHS as readonly string[]).includes(rawPath)
      ? (rawPath as ListingDraftPath)
      : '',
    step:
      typeof rawStep === 'number' && Number.isInteger(rawStep) && rawStep > 0
        ? rawStep
        : 0,
    owner: ownerRef ? { userId: draft.userId, ...ownerRef } : null,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

/**
 * The wizard-state keys that describe the BUSINESS, the only ones
 * `GET /admin/listing-drafts/:id` hands back.
 *
 * An allow-list on purpose. The payload is opaque client-written JSON whose
 * shape the frontend owns, so a deny-list would pass through any field the
 * wizard grows later, including one about the member. With an allow-list a
 * new field stays behind until someone decides it is about the business.
 *
 * Left behind, as the member's own answers that staff may not carry onto a
 * team listing: the eight owner-personal fields (`rel`, `ownerName`,
 * `ownerBio`, `visibility`, `linkToProfile`, `ownedBy`, `consentOuting`,
 * `consentGuide`, see `OWNER_PERSONAL_LISTING_FIELDS`), `ownerRole` (omitted
 * from the admin create body), the affirming pledge, and the queer-owned
 * `badge` with its `evidence`: a queer-owned claim says the owner is queer,
 * an outing risk exactly like `ownedBy`, and the member never confirmed it.
 * Also the wizard-only state `path`, `managementRole` and `isStaffAuthored`.
 */
export const LISTING_DRAFT_BUSINESS_KEYS = [
  'name',
  'cats',
  'hood',
  'price',
  'blurb',
  'tagline',
  'whatItIs',
  'tags',
  'goodFor',
  'accessibility',
  'services',
  'pricingMode',
  'menu',
  'langs',
  'online',
  'address',
  'geocoded',
  'latitude',
  'longitude',
  'hours',
  'hoursNote',
  'hoursExceptions',
  'social',
  'photos',
  'alt',
] as const;

/**
 * `GET /admin/listing-drafts/:id`: the summary plus the business half of the
 * member's wizard state, flattened out of the stored `{ draft, step }`
 * envelope, for the console's "Finish as a team listing". It goes out as a
 * team listing offered back to the member, who adds their own answers when
 * they accept.
 */
export interface AdminListingDraftDetailDTO extends AdminListingDraftDTO {
  payload: Record<string, unknown>;
}

export function toAdminListingDraftDetailDTO(
  draft: ListingDraft,
  ownerRef: MemberRef | null,
): AdminListingDraftDetailDTO {
  const wizardState = readWizardState(draft.payload);
  const payload: Record<string, unknown> = {};
  for (const key of LISTING_DRAFT_BUSINESS_KEYS) {
    if (Object.hasOwn(wizardState, key)) payload[key] = wizardState[key];
  }
  return { ...toAdminListingDraftDTO(draft, ownerRef), payload };
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
