/**
 * The closed, server-owned vocabularies the legal-request register is kept in
 * (PRD-32).
 *
 * They live in their own file rather than beside the entity because the public
 * Transparency Report publishes breakdowns keyed by them
 * (`transparency-response.ts`), and a public key set has to be readable
 * without dragging a database entity into the reader's head. Every value here
 * is a stable identifier the frontend translates. No label text is served from
 * the backend.
 */

/**
 * What kind of demand arrived. Broad enough that any real instrument lands in
 * a bucket, specific enough that a reader can tell a routine subpoena from an
 * emergency disclosure demand, which are very different things to be asked.
 *
 * `other` is the honest catch-all. A demand that keeps landing there is a gap
 * in this list to close, and it is still counted meanwhile.
 */
export enum LegalRequestType {
  Subpoena = 'subpoena',
  CourtOrder = 'court_order',
  PoliceRequest = 'police_request',
  EmergencyDisclosureRequest = 'emergency_disclosure_request',
  PreservationRequest = 'preservation_request',
  TakedownDemand = 'takedown_demand',
  Other = 'other',
}

/** Fixed render order, so two periods list their rows the same way and a
 *  reader can compare them line by line. */
export const LEGAL_REQUEST_TYPES: readonly LegalRequestType[] = [
  LegalRequestType.Subpoena,
  LegalRequestType.CourtOrder,
  LegalRequestType.PoliceRequest,
  LegalRequestType.EmergencyDisclosureRequest,
  LegalRequestType.PreservationRequest,
  LegalRequestType.TakedownDemand,
  LegalRequestType.Other,
];

/**
 * What QueerPulse did about it.
 *
 * `narrowed` is separate from `complied_in_part` on purpose. "Complied in
 * part" describes an answer that happened to be incomplete; "narrowed" says
 * the demand was pushed back on and shrunk before anything was handed over,
 * which is the outcome members are entitled to know we fought for.
 */
export enum LegalRequestOutcome {
  CompliedInFull = 'complied_in_full',
  CompliedInPart = 'complied_in_part',
  Narrowed = 'narrowed',
  Refused = 'refused',
  Withdrawn = 'withdrawn',
  Pending = 'pending',
}

/** Fixed render order, worst case for the member first. */
export const LEGAL_REQUEST_OUTCOMES: readonly LegalRequestOutcome[] = [
  LegalRequestOutcome.CompliedInFull,
  LegalRequestOutcome.CompliedInPart,
  LegalRequestOutcome.Narrowed,
  LegalRequestOutcome.Refused,
  LegalRequestOutcome.Withdrawn,
  LegalRequestOutcome.Pending,
];

/** The outcomes under which member data actually left the platform. Used to
 *  decide when a record must say why the affected members were not told. */
export const DISCLOSING_LEGAL_REQUEST_OUTCOMES: readonly LegalRequestOutcome[] =
  [
    LegalRequestOutcome.CompliedInFull,
    LegalRequestOutcome.CompliedInPart,
    LegalRequestOutcome.Narrowed,
  ];

/**
 * The categories of member data a disclosure can consist of.
 *
 * A closed key set rather than free prose, so "what did they actually hand
 * over" is a fact the register can be queried on years later, and so an
 * operator recording a request under time pressure picks from a list instead
 * of inventing a phrase. An empty array is a real and common answer: it means
 * nothing was disclosed.
 *
 * These keys are NOT published. The public report says how many requests
 * arrived and what happened to them; which categories a particular disclosure
 * covered is one request's content, and one request's content is exactly what
 * the aggregate exists to avoid printing.
 */
export const LEGAL_REQUEST_DATA_CATEGORIES = [
  'account_identifiers',
  'contact_details',
  'account_metadata',
  'connection_logs',
  'profile_content',
  'posts_and_comments',
  'private_messages',
  'uploaded_media',
  'membership_records',
  'other',
] as const;

export type LegalRequestDataCategory =
  (typeof LEGAL_REQUEST_DATA_CATEGORIES)[number];

export function isLegalRequestDataCategory(
  value: unknown,
): value is LegalRequestDataCategory {
  return (
    typeof value === 'string' &&
    (LEGAL_REQUEST_DATA_CATEGORIES as readonly string[]).includes(value)
  );
}
