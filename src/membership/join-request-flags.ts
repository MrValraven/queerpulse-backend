/**
 * Confidence-tiered triage signals for the join-request queue (guideline
 * audit E4). These are FLAGS surfaced to a human reviewer, never automated
 * accept/reject — identity-sensitive judgment calls stay human. Deliberately
 * bounded in scope: a static disposable-domain list (not a live-checking
 * third-party service) and exact-match duplicate detection (not fuzzy
 * similarity). Both are real, cheap signals; upgrading either to something
 * fancier is a separate follow-up, not a blocker for shipping the triage UX.
 */

export type JoinRequestFlag =
  'disposable_email' | 'duplicate_message' | 'source_burst';

// A small, curated set of well-known disposable/throwaway email providers.
// Not exhaustive — a real bad actor can always use a fresh domain — but it
// catches the common, lazy case cheaply with zero false positives on a real
// provider.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'dispostable.com',
  'fakeinbox.com',
  'sharklasers.com',
  'maildrop.cc',
]);

export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

// How many other requests in the SAME fetched batch must share an exact,
// whitespace-normalized message before it's flagged as likely copy-paste
// spam. >1 means "at least one other request says the same thing."
const DUPLICATE_MESSAGE_THRESHOLD = 1;

// How many pending requests sharing the same `source` value, created within
// the last hour, before that source is flagged as a possible burst.
const SOURCE_BURST_WINDOW_MS = 60 * 60 * 1000;
const SOURCE_BURST_THRESHOLD = 5;

function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface FlaggableRequest {
  id: string;
  email: string;
  message: string;
  source: string | null;
  createdAt: Date;
}

/**
 * Computes flags for every request in `batch` using only the batch itself
 * (no extra query) — duplicate-message and source-burst are both about
 * patterns WITHIN the currently-fetched page, which is exactly the set a
 * reviewer is looking at together.
 */
export function computeBatchFlags(
  batch: readonly FlaggableRequest[],
): Map<string, JoinRequestFlag[]> {
  const messageCounts = new Map<string, number>();
  for (const request of batch) {
    const key = normalizeMessage(request.message);
    messageCounts.set(key, (messageCounts.get(key) ?? 0) + 1);
  }

  const now = Date.now();
  const sourceRecentCounts = new Map<string, number>();
  for (const request of batch) {
    if (!request.source) continue;
    if (now - request.createdAt.getTime() > SOURCE_BURST_WINDOW_MS) continue;
    sourceRecentCounts.set(
      request.source,
      (sourceRecentCounts.get(request.source) ?? 0) + 1,
    );
  }

  const result = new Map<string, JoinRequestFlag[]>();
  for (const request of batch) {
    const flags: JoinRequestFlag[] = [];
    if (isDisposableEmail(request.email)) flags.push('disposable_email');
    const messageKey = normalizeMessage(request.message);
    if ((messageCounts.get(messageKey) ?? 0) > DUPLICATE_MESSAGE_THRESHOLD) {
      flags.push('duplicate_message');
    }
    if (
      request.source &&
      (sourceRecentCounts.get(request.source) ?? 0) > SOURCE_BURST_THRESHOLD
    ) {
      flags.push('source_burst');
    }
    result.set(request.id, flags);
  }
  return result;
}
