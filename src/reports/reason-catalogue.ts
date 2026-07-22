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
    'housing_unsafe',
    'harassment',
    'discrimination',
    'housing_scam',
    'other',
  ],
  [ReportSubjectType.Flatmate]: [
    'harassment',
    'discrimination',
    'impersonation',
    'unwanted_contact',
    'other',
  ],
  [ReportSubjectType.Landlord]: [
    'discrimination',
    'harassment',
    'impersonation',
    'spam',
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
