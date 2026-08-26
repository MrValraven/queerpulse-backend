/**
 * THE single source of truth for the current revision of every member-facing
 * policy document. Nothing else in either repo may declare one of these
 * literals.
 *
 * WHY HERE, AND WHY ONE FILE (ID-14)
 * ----------------------------------
 * Before this, three literals lived in three places and two of them had already
 * drifted apart:
 *
 *   - the privacy-policy version was `'3.3'` in `consent.constants.ts` while
 *     the frontend's `POLICY_VERSION` (`shared/api/consent.api.ts`) — the value
 *     the privacy page actually PRINTS and the value stamped onto every
 *     `consent_record` row — said `'3.4'`;
 *   - the Terms version existed ONLY on the frontend
 *     (`features/auth/api/ageAttestation.api.ts`), so the server stamped
 *     whatever a client told it and had no opinion of its own;
 *   - the guidelines version was already server-authoritative
 *     (`UsersService.CURRENT_GUIDELINES_VERSION`, read by the frontend over
 *     `GET /platform-status`), which is the pattern that worked and the one the
 *     other two now follow.
 *
 * So the BACKEND is authoritative for all three, this file declares them, and
 * the frontend reads them over the wire in two places:
 *
 *   - `GET /platform-status` (public, works with no session) carries all three
 *     for the pre-auth surfaces: the cookie banner, the request-invite form,
 *     and the sign-in age attestation;
 *   - `GET /auth/me` carries `policyVersions` — the two documents a member has
 *     to AGREE to, paired with the revisions that member has on file — which is
 *     what the re-acceptance gate compares.
 *
 * The frontend keeps a literal for each only as a last-resort fallback for the
 * moment before the network answers, documented as such at each site.
 *
 * Every value is kept ≤ 32 characters: `users.terms_version`,
 * `users.guidelines_version` and `policy_acceptance.*_version` are all
 * `varchar(32)`.
 *
 * BUMPING ONE OF THESE IS A GOVERNANCE ACT. A member whose stored version is
 * behind is shown the re-acceptance sheet on their next visit and cannot use
 * the member surface until they agree, and the agreement is appended to
 * `policy_acceptance`. Bump only for a MATERIAL change — a typo fix is not
 * worth re-prompting the whole community.
 */

/**
 * The Terms of Service revision in effect. Its first clause carries the 18+
 * eligibility rule that every age attestation is made against, which is why
 * `users.terms_version` is written at signup from the attestation.
 */
export const CURRENT_TERMS_VERSION = '2.4';

/**
 * The Community Guidelines revision in effect — the norms a member agrees to on
 * the onboarding wizard's welcome step (`users.guidelines_version`).
 *
 * Re-exported by `UsersService` so its existing importers
 * (`PlatformStatusController`, `markOnboarded`) keep working unchanged.
 */
export const CURRENT_GUIDELINES_VERSION = '1.0';

/**
 * The Privacy Policy revision the cookie/monitoring consent record pins to.
 *
 * Resolved UP to the frontend's `'3.4'` rather than down to the old backend
 * `'3.3'`: `3.4` is the revision the privacy page displays and the revision
 * already stamped on live `consent_record` rows, so `3.3` was the stale half of
 * the pair. Writing `3.3` here would have re-prompted the whole community for a
 * policy change that never happened.
 */
export const CURRENT_PRIVACY_POLICY_VERSION = '3.4';
