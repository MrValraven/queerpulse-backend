import { ForbiddenException } from '@nestjs/common';
import { ListingDTO } from './listing-response';

/**
 * The columns on a `Listing` that describe the OWNER as a person rather than
 * the business as a business.
 *
 * The first five are not a new judgement. `ListingClaimsService.review` already
 * clears exactly `contactEmail`, `ownerName`, `ownerBio`, `consentOuting` and
 * `consentGuide` when a listing changes hands on an approved claim, on the
 * stated grounds that they belong to the previous owner and cannot transfer to
 * somebody else. That set is treated here as authoritative, and this module is
 * the single place it is written down for both purposes.
 *
 * Three more are added for the co-manager boundary:
 *
 *  - `visibility` decides how much of the owner's identity the public listing
 *    reveals (`public`, `role`, `anon`). It is the owner's answer to "how
 *    visible do I want to be as a queer business owner", which is a personal
 *    safety decision.
 *  - `linkToProfile` publishes the tie between this business and the owner's
 *    QueerPulse profile. Same decision, aimed at the member directory.
 *  - `rel` states the owner's own relationship to the business ("I own it",
 *    "I work here"). It is a claim about a person, and it is one of the inputs
 *    a moderator weighs on a queer-owned verification.
 *
 * `ownerRole` is deliberately NOT in this set, matching the claim-transfer
 * precedent, which leaves it alone. It is a job title at the business
 * ("co-founder and baker") rather than a fact about the person, and it stays
 * editable by a co-manager along with the rest of the business's copy.
 *
 * The set is used in both directions and both are required for it to mean
 * anything:
 *
 *  - READ: `redactOwnerPersonalFields` omits these keys from any listing
 *    response a co-manager receives.
 *  - WRITE: `assertNoOwnerPersonalListingFields` rejects a co-manager's PATCH
 *    that carries any of them.
 */
export const OWNER_PERSONAL_LISTING_FIELDS = [
  'contactEmail',
  'ownerName',
  'ownerBio',
  'consentOuting',
  'consentGuide',
  'visibility',
  'linkToProfile',
  'rel',
] as const;

export type OwnerPersonalListingField =
  (typeof OWNER_PERSONAL_LISTING_FIELDS)[number];

/**
 * A listing as a CO-MANAGER sees it: every business field, and none of the
 * eight owner-personal ones.
 *
 * Modelled as an `Omit` rather than as "the same interface with nulls" on
 * purpose. A co-manager's response does not contain a blanked-out contact
 * email; it contains no `contactEmail` key at all, so a frontend that renders
 * the field cannot render an empty box that looks like stored data, and a
 * frontend that round-trips the object it just loaded into a PATCH sends a body
 * with the field absent, which is exactly the body the write gate accepts.
 */
export type CoManagerListingDTO = Omit<ListingDTO, OwnerPersonalListingField>;

/** Which of the two management seats the caller holds on a listing. */
export enum ListingManagementRole {
  Owner = 'owner',
  CoManager = 'co_manager',
}

/**
 * A listing returned on one of the caller's own management surfaces
 * (`GET /listings/mine`, `GET /listings/:ref`, and every owner-or-co-manager
 * write that echoes the listing back), carrying which seat the caller holds.
 *
 * The union is the whole point: `managementRole: 'owner'` comes with the full
 * `ListingDTO`, `managementRole: 'co_manager'` comes with the redacted one, and
 * TypeScript will not let a caller build the second shape out of the first
 * without going through `toManagedListingDTO`.
 */
export type ManagedListingDTO =
  | (ListingDTO & { managementRole: ListingManagementRole.Owner })
  | (CoManagerListingDTO & { managementRole: ListingManagementRole.CoManager });

/**
 * Strips the owner-personal keys from a listing response.
 *
 * Deletes the keys rather than overwriting them, so the result genuinely has no
 * such property. `structuredClone`-free shallow copy is enough: every one of
 * the eight is a scalar.
 */
export function redactOwnerPersonalFields(
  listing: ListingDTO,
): CoManagerListingDTO {
  const redacted: Partial<ListingDTO> = { ...listing };
  for (const field of OWNER_PERSONAL_LISTING_FIELDS) {
    delete redacted[field];
  }
  return redacted as CoManagerListingDTO;
}

/**
 * Tags a listing response with the caller's seat, redacting it first when that
 * seat is co-manager. Every owner-or-co-manager route funnels its response
 * through here, so no path can forget the redaction by accident.
 */
export function toManagedListingDTO(
  listing: ListingDTO,
  isOwner: boolean,
): ManagedListingDTO {
  if (isOwner) {
    return { ...listing, managementRole: ListingManagementRole.Owner };
  }
  return {
    ...redactOwnerPersonalFields(listing),
    managementRole: ListingManagementRole.CoManager,
  };
}

/**
 * Refuses a write from a co-manager that touches any owner-personal field.
 *
 * WHY 403 AND NOT A SILENT DROP. Both close the hole; they differ in what the
 * caller learns, and this API has already made that choice everywhere else.
 * The global `ValidationPipe` runs with `forbidNonWhitelisted: true`, and
 * `UpdateListingDto` says in its own doc comment that
 * `affirmingBaselineAccepted` is OMITTED rather than ignored precisely so a
 * PATCH carrying it is rejected "instead of silently accepting a change that
 * never happens". A silent drop here would contradict that posture inside the
 * same endpoint.
 *
 * It is also the safer of the two to maintain. A dropped field produces a 200
 * and an unchanged row, which looks identical to a successful no-op write, so
 * no test and no frontend can tell the difference between the policy working
 * and the policy having been refactored away. A 403 is an assertion a spec can
 * hold onto, and this module's spec does.
 *
 * The cost of being loud is a co-manager who round-trips the listing they just
 * loaded and gets a 403 for fields they never meant to send. That cost is paid
 * by `redactOwnerPersonalFields`: the object they loaded has no such keys, so
 * the round-trip body has none either.
 *
 * The presence test is `field in body && body[field] !== undefined`, which
 * holds whether or not `class-transformer` materialised absent optional
 * properties as `undefined` on the DTO instance. An explicit `undefined` is not
 * expressible in JSON, so nothing a client can actually send slips past it.
 */
export function assertNoOwnerPersonalListingFields(
  body: Record<string, unknown>,
): void {
  const attemptedFields = OWNER_PERSONAL_LISTING_FIELDS.filter(
    (field) => field in body && body[field] !== undefined,
  );
  if (attemptedFields.length === 0) return;
  throw new ForbiddenException(
    `Only the listing owner can change ${attemptedFields.join(', ')}`,
  );
}
