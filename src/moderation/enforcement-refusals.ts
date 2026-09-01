import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * The typed refusals an account-level moderator action can answer with, in one
 * place so the throw sites, the copy and the frontend contract cannot drift.
 *
 * ## Why these are typed at all
 *
 * The moderation queue drawer showed "Couldn't reach the safety service.
 * Restored." for every failed action. That was false twice over on a refusal:
 * the safety service WAS reached, and it refused for a specific reason the
 * moderator never saw. A moderator who cannot tell "the network dropped" from
 * "this subject has two possible authors and I must not guess" retries the
 * action, then works around it.
 *
 * So a refusal carries a machine-readable `code` and an additive `target`
 * discriminator, following the house convention exactly:
 * `INVITE_QUOTA_EXCEEDED` (`membership/invites.service.ts`) and
 * `REPORT_FLOOD_CAP` + its additive `cap` field
 * (`reports/report-flood-limits.ts`) are the precedents.
 * `AllExceptionsFilter.normalizeErrorBody` spreads the thrown body first and
 * only fills in a missing `statusCode`/`error`/`message`, so both extra fields
 * reach the wire untouched.
 *
 * `code` is the contract. `message` is the human fallback and is safe to show
 * verbatim to a moderator. Nothing should ever pattern-match the prose.
 */

/**
 * A 400: the report names no single account a sanction could land on.
 *
 * Deliberately NOT a "not found". The report is real, the moderator's
 * permission is real, and the content-level actions (`hide`, `remove`,
 * `dismiss`, `escalate`) are all still available on the very same report. The
 * only thing being refused is guessing which member to sanction.
 */
export const ENFORCEMENT_TARGET_UNRESOLVED_CODE =
  'ENFORCEMENT_TARGET_UNRESOLVED';

/**
 * A 403: the report resolves to an account that is out of scope for this
 * surface entirely. The moderator did nothing wrong and there is nothing for
 * them to retry, which is exactly why it should not read as a service failure.
 */
export const ENFORCEMENT_TARGET_PROTECTED_CODE = 'ENFORCEMENT_TARGET_PROTECTED';

/**
 * Why no single account can be sanctioned, on the additive `target` field of
 * an {@link ENFORCEMENT_TARGET_UNRESOLVED_CODE} body.
 *
 *  - `no_account`: the subject has nobody behind it. An unclaimed directory
 *    listing (`owner_id IS NULL`), an author who erased their account (every
 *    content FK is `ON DELETE SET NULL`), a `venue` report that describes a
 *    place in prose, a subject row that no longer exists.
 *  - `ambiguous_authors`: the subject covers content written by more than one
 *    member and the report does not record which of them was reported. Two
 *    subject types today, both the same shape: `listing_public_question` (a
 *    member's question AND the listing owner's answer under it) and `review`
 *    (a member's review AND the reviewed party's public reply under it, on a
 *    directory listing, an employer or a home).
 *
 * The two are worth separating because the moderator's next move differs. On
 * `no_account` there is no member to reach at all. On `ambiguous_authors`
 * there are two, and the moderator can identify the right one by reading the
 * exchange on the page it was posted to.
 */
export type EnforcementTargetProblem = 'no_account' | 'ambiguous_authors';

/**
 * Which protected account the report resolved to, on the additive `target`
 * field of an {@link ENFORCEMENT_TARGET_PROTECTED_CODE} body.
 */
export type ProtectedEnforcementTarget = 'house_account' | 'staff_account';

/**
 * The moderator-facing sentence for each refusal. Every one of them names what
 * happened AND what to do instead, because a refusal with no next step is how
 * a moderator ends up working around the system rather than with it.
 */
const NO_ACCOUNT_MESSAGE =
  'Could not resolve the "%s" this report names to an account. ' +
  'Act on the content instead, or find the member and act from their drawer.';

// Deliberately names no single surface. It answers a `listing_public_question`
// (a question and the answer under it) and a `review` (a review and the reply
// under it) alike, and a third pairing would read correctly too.
const AMBIGUOUS_AUTHORS_MESSAGE =
  'This report covers a statement and the answer posted under it, written by two ' +
  'different members, and it does not record which of them was reported. ' +
  'Acting on the account could sanction the wrong person. Act on the content ' +
  'instead, or open the page it was posted to, see who wrote the part you mean, ' +
  'and act from their drawer.';

const HOUSE_ACCOUNT_MESSAGE = 'The house account cannot be restricted.';

const STAFF_ACCOUNT_MESSAGE =
  'Moderation actions cannot target staff accounts.';

/**
 * The 400 an account-level action answers when the report names no single
 * member to act on.
 *
 * `subjectType` is the report's own subject type, echoed into the
 * `no_account` copy so a moderator reads "the 'listing' this report names"
 * rather than a generic sentence.
 */
export function enforcementTargetUnresolved(
  problem: EnforcementTargetProblem,
  subjectType: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: ENFORCEMENT_TARGET_UNRESOLVED_CODE,
    // Additive detail, safe to ignore: `code` alone is the contract.
    target: problem,
    message:
      problem === 'ambiguous_authors'
        ? AMBIGUOUS_AUTHORS_MESSAGE
        : NO_ACCOUNT_MESSAGE.replace('%s', subjectType),
  });
}

/**
 * The 403 an account-level action answers when the report resolves to an
 * account this surface may never touch.
 */
export function enforcementTargetProtected(
  target: ProtectedEnforcementTarget,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: ENFORCEMENT_TARGET_PROTECTED_CODE,
    target,
    message:
      target === 'house_account'
        ? HOUSE_ACCOUNT_MESSAGE
        : STAFF_ACCOUNT_MESSAGE,
  });
}
