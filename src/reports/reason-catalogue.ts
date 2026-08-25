import { ReportSubjectType } from './entities/report.entity';

/**
 * The single, shared reason taxonomy for the whole reporting → moderation
 * loop. Mirrors `queerpulse/src/features/safety/reportReasons.ts` exactly
 * (stable code → human label, and which codes are offered per subject type)
 * — this backend module is the server-owned source of truth the frontend's
 * `GET /reports/reasons` call renders instead of its own demo-mode fallback
 * (see `.superpowers/sdd/connect-FINAL-review.md` M4). `reasonCode` is also
 * reused, unmodified, by `src/moderation`'s action DTOs.
 */
export type ReasonCode =
  | 'outing'
  | 'doxxing'
  | 'harassment'
  | 'hate_speech'
  | 'unwanted_contact'
  | 'impersonation'
  | 'discrimination'
  | 'spam'
  | 'off_topic'
  | 'venue_safety'
  | 'venue_staff'
  | 'venue_accessibility'
  | 'housing_unsafe'
  | 'housing_scam'
  | 'not_affirming'
  | 'off_platform'
  // System-filed listing-domain codes (NOT member-selectable — deliberately
  // absent from `REASON_CODES` / `SUBJECT_REASONS`, so `GET /reports/reasons`
  // never offers them and `POST /reports`'s `@IsIn(REASON_CODES)` rejects them).
  // They are set only by `ListingsService` when it files through the reports
  // pipeline: `listing_dispute` = a member (possibly the named business)
  // contesting a "friendly"/unowned listing via `POST /listings/:ref/dispute`;
  // `listing_owner_notify` = the owner-outreach task auto-enqueued when a
  // friendly/suggested listing is created (item #13).
  | 'listing_dispute'
  | 'listing_owner_notify'
  | 'other';

/** Every valid `ReasonCode`, for `@IsIn` validation (no native string enum). */
export const REASON_CODES: readonly ReasonCode[] = [
  'outing',
  'doxxing',
  'harassment',
  'hate_speech',
  'unwanted_contact',
  'impersonation',
  'discrimination',
  'spam',
  'off_topic',
  'venue_safety',
  'venue_staff',
  'venue_accessibility',
  'housing_unsafe',
  'housing_scam',
  'not_affirming',
  'off_platform',
  'other',
];

/** One option in the reason taxonomy `GET /reports/reasons` returns. */
export interface ReasonOption {
  code: ReasonCode;
  label: string;
}

/** Stable code → human label. Labels are the only thing that gets localized. */
const REASON_LABELS: Record<ReasonCode, string> = {
  outing: 'Outing / sharing private identity without consent',
  doxxing: 'Sharing personal or location data (doxxing)',
  harassment: 'Targeted harassment or threats',
  hate_speech: 'Hate speech or a slur',
  unwanted_contact: 'Unwanted contact after being asked to stop',
  impersonation: 'Misrepresentation or impersonation',
  discrimination: 'Discrimination or misgendering',
  spam: 'Spam or self-promotion',
  off_topic: 'Off-topic or disruptive',
  venue_safety: 'A harassment or safety incident at the space',
  venue_staff: "Staff didn't intervene when needed",
  venue_accessibility: 'An accessibility problem',
  housing_unsafe: 'Unsafe, discriminatory, or misrepresented housing',
  housing_scam: 'Scam or fake listing',
  not_affirming: 'Not LGBTQ+ affirming — broke the community pledge',
  off_platform: 'Asked to pay or move off-platform',
  // System-filed listing codes (see the `ReasonCode` union comment) — labelled
  // so any code→label lookup is total, but never surfaced as a report option.
  listing_dispute: 'Dispute or claim of a business listing',
  listing_owner_notify: 'Owner outreach — friendly/suggested listing',
  other: 'Something else — explained in detail',
};

/**
 * Which reason codes are offered per subject type. Every subject also gets
 * `other`. Emergency severity (outing / doxxing) is derived server-side (see
 * `../report-severity.ts`) — the reporter never chooses it.
 */
const SUBJECT_REASONS: Record<ReportSubjectType, ReasonCode[]> = {
  [ReportSubjectType.Member]: [
    'outing',
    'doxxing',
    'harassment',
    'unwanted_contact',
    'impersonation',
    'discrimination',
    'other',
  ],
  [ReportSubjectType.Post]: [
    'outing',
    'doxxing',
    'harassment',
    'hate_speech',
    'discrimination',
    'spam',
    'off_topic',
    'other',
  ],
  [ReportSubjectType.Reply]: [
    'outing',
    'doxxing',
    'harassment',
    'hate_speech',
    'discrimination',
    'spam',
    'off_topic',
    'other',
  ],
  [ReportSubjectType.Venue]: [
    'venue_safety',
    'discrimination',
    'venue_staff',
    'venue_accessibility',
    'other',
  ],
  [ReportSubjectType.Message]: [
    'outing',
    'doxxing',
    'harassment',
    'hate_speech',
    'unwanted_contact',
    'spam',
    'other',
  ],
  [ReportSubjectType.Community]: ['hate_speech', 'spam', 'other'],
  [ReportSubjectType.Housing]: [
    'housing_scam',
    'housing_unsafe',
    'not_affirming',
    'discrimination',
    'off_platform',
    'harassment',
    'other',
  ],
  [ReportSubjectType.Flatmate]: [
    'harassment',
    'not_affirming',
    'discrimination',
    'impersonation',
    'unwanted_contact',
    'other',
  ],
  [ReportSubjectType.Landlord]: [
    'not_affirming',
    'discrimination',
    'harassment',
    'impersonation',
    'spam',
    'other',
  ],
  // Business-directory listing (`src/listings`, NOT `src/housing-listings`).
  // No dedicated codes are introduced — every concern a listing report is
  // likely to raise already has a fitting existing code: `housing_scam`'s
  // "Scam or fake listing" label covers a listing that doesn't exist / is
  // fraudulent, `spam` covers self-promotion abuse, `venue_safety` covers a
  // safety incident at the business, `discrimination` covers discriminatory
  // or otherwise inappropriate content/practices, and `other` (with the
  // free-text `detail`) covers inaccurate/outdated info or anything else.
  [ReportSubjectType.Listing]: [
    'housing_scam',
    'spam',
    'venue_safety',
    'discrimination',
    'other',
  ],
  // An event (`myevents` report-an-event flow on the frontend). No new codes:
  // `hate_speech` / `harassment` cover an abusive or threatening event or its
  // promotion, `discrimination` an exclusionary event, `spam` self-promotion
  // abuse, `venue_safety` a harassment/safety incident at the gathering,
  // `off_topic` "this shouldn't be here", and `other` (free-text) anything
  // else. Mirrors the frontend `SUBJECT_REASONS.event` exactly.
  [ReportSubjectType.Event]: [
    'hate_speech',
    'harassment',
    'discrimination',
    'venue_safety',
    'spam',
    'off_topic',
    'other',
  ],
  // A business-directory business/company/job posting. Same shape as
  // `Listing` — `housing_scam`'s "Scam or fake listing" label covers a fake
  // business, `spam` self-promotion abuse, `venue_safety` a safety incident,
  // `discrimination` discriminatory content/practices, `other` inaccurate info.
  [ReportSubjectType.Business]: [
    'housing_scam',
    'spam',
    'venue_safety',
    'discrimination',
    'other',
  ],
  // An employer/company profile. `housing_scam` ("Scam or fake listing") a
  // fake company, `discrimination` a discriminatory employer, `harassment`
  // targeted abuse, `spam` self-promotion abuse, `other` anything else.
  [ReportSubjectType.Company]: [
    'housing_scam',
    'discrimination',
    'harassment',
    'spam',
    'other',
  ],
  // A job posting. `housing_scam` ("Scam or fake listing") a fake/fraudulent
  // job, `spam` self-promotion abuse, `discrimination` a discriminatory ad,
  // `harassment` targeted abuse, `other` anything else.
  [ReportSubjectType.Job]: [
    'housing_scam',
    'spam',
    'discrimination',
    'harassment',
    'other',
  ],
  // A member subprofile / persona. Person-shaped like `Member`/`Flatmate`:
  // `harassment`, `impersonation` (a persona impersonating someone),
  // `discrimination`, `spam`, and `other`.
  [ReportSubjectType.Subprofile]: [
    'harassment',
    'impersonation',
    'discrimination',
    'spam',
    'other',
  ],
  // A directory-listing review. No new codes: `harassment` covers an abusive
  // review, `hate_speech` a slur, `discrimination` a discriminatory one,
  // `housing_scam` ("Scam or fake listing") a fake/planted review, `spam`
  // self-promotion abuse, and `other` (free-text) anything else.
  [ReportSubjectType.Review]: [
    'harassment',
    'hate_speech',
    'discrimination',
    'housing_scam',
    'spam',
    'other',
  ],
  // A public reader comment on a magazine article (CNT-10). Same shape as
  // `Reply`: it's a small piece of user-generated text under a piece of
  // content, so the same reason set applies unchanged.
  [ReportSubjectType.MagazineComment]: [
    'outing',
    'doxxing',
    'harassment',
    'hate_speech',
    'discrimination',
    'spam',
    'off_topic',
    'other',
  ],
  // A public question (or its answer) on a business listing. Shaped like
  // `MagazineComment` rather than `Review`: a question box on a venue's page is
  // where someone gets asked, in public, whether they were at a place or who
  // they went with, so `outing` and `doxxing` belong here in a way they do not
  // on a star review. `off_topic` covers the question that is really an
  // advertisement for somewhere else.
  [ReportSubjectType.ListingPublicQuestion]: [
    'outing',
    'doxxing',
    'harassment',
    'hate_speech',
    'discrimination',
    'spam',
    'off_topic',
    'other',
  ],
};

/** The reason options a given subject type should offer, as `{code, label}`. */
export function reasonsFor(subjectType: ReportSubjectType): ReasonOption[] {
  return SUBJECT_REASONS[subjectType].map((code) => ({
    code,
    label: REASON_LABELS[code],
  }));
}
