# Decision: QueerPulse delivers no email

**Status:** Accepted, and still in force.
**Date:** 2026-08-03. Reaffirmed 2026-08-26 after a mailer was built and removed.
**Owners:** Platform / Governance
**Audit reference:** `queerpulse/docs/production-readiness/AUDIT-2026-07-30.md`, §L (The Mailer Question) and finding **P1-13**.
**Companion record:** `docs/ops/no-mailer-at-launch.md` covers the same decision from the flow-by-flow operational side. Both are current; read either.

---

## Decision

QueerPulse delivers **no email**. There is no email provider, no mail
dependency, and no sender wired anywhere in the backend. Sign-in is
Google-OAuth-only, so password-reset email is genuinely not needed. A set of
flows that would normally reach a member (or a not-yet-member) **out of band**
therefore have no channel at all. This document records that gap, the flows it
affects, and what would have to be settled before any of it changed.

We ship the gap **documented and honest** rather than building a mailer, and
rather than leaving copy that silently promises email nothing can send.

## What happened in August 2026 (the record this document exists to keep)

Between the original decision and 2026-08-26 a **nodemailer-backed
`MailerService` was introduced** in `src/mailer/`, wired into `AppModule`, and
called from four places: an intake concern update, an ops ping on a new
marketing inquiry, a listing-draft resume link, and a newsletter
double-opt-in confirmation. It carried SMTP env vars (`SMTP_URL`, `SMTP_HOST`,
`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`,
`OPS_INBOX_EMAIL`) and ran log-only until they were set, meaning a single
production env change would have started delivering mail on paths nobody had
reviewed for deliverability, consent, or unsubscribe.

**It was removed in full on 2026-08-26** (LB-07): `src/mailer/`,
`src/config/mail.config.ts`, the SMTP env validation and `.env.example` block,
the `nodemailer` and `@types/nodemailer` dependencies, and all four call sites.

**The position is unchanged.** Nothing in `src/` may reintroduce an outbound
mail transport. A mailer is not a follow-up item on this document; it is a
product decision that would have to be retaken first, and the section at the
end says what retaking it involves.

## Why we do not have one

- Auth is Google-OAuth-only — the single flow that *cannot* work without email
  (password reset) doesn't exist here, so email is not on the critical auth path.
- A mailer done properly (deliverability, DKIM/SPF/DMARC, bounce handling,
  idempotent keyed sends, unsubscribe for non-transactional mail) is a large
  standing commitment, and doing it badly is worse than not doing it. The
  August 2026 mailer is the proof: it shipped without any of that.
- The affected flows are tolerable at launch scale with **in-app** surfaces plus
  manual operator steps (see each flow below), provided we do not *pretend*
  email is happening.

## What this gap affects (flows with NO out-of-band channel)

Each of these would normally send an email. At launch none do. The mitigation is
in-app only (and, where noted, a manual operator action).

1. **Irreversible 30-day account erasure — no D-7 / D-1 warning.**
   `POST /account/deletion-request` schedules a hard erase 30 days out
   (`DELETION_GRACE_DAYS`, `src/account/account.constants.ts`). There is no
   reminder before the point of no return — a member who scheduled deletion and
   forgot has no nudge, and no cancel prompt, outside the app.
   *Highest-severity item in this list.*

2. **Join-request approve / decline — applicant has no account yet.**
   An approved or declined applicant cannot be told: they have no in-app inbox
   (no account), and there is no email. Today the admin copies the invite link
   and delivers it **manually** out of band.

3. **Moderation outcomes (ban / suspend / warn) to a locked-out member.**
   A banned or suspended member is blocked from in-app surfaces by
   `ActiveMemberGuard`, so an in-app notice can't reach them — email is the only
   channel that would, and there isn't one. They cannot be told *why*.

4. **Appeal decisions to a locked-out member.**
   Same root cause as (3): the appellant is exactly the member the guard shuts
   out, so the decision has no delivery path.

5. **DSAR responses within the 30-day `dueBy`.**
   `POST /account/dsar` records a request with a 30-day due date
   (`DSAR_DUE_DAYS`). The resolved outcome has no out-of-band delivery; the
   requester must return to the app to see it.

6. **Terms-change notices.**
   A material terms change that policy says to notify members of has no delivery
   channel. (Where FE Terms copy still promises email notification, it is
   wrong; see the copy list at the end.)

7. **Newsletter / digests + the whole `email_preference` matrix.**
   `GET|PATCH /account/email-preferences` (`src/account`) stored per-category
   toggles (`productUpdates`, `communityDigest`, `eventReminders`,
   `directMessages`, `securityAlerts`) that **nothing acted on**: no digest was
   built, no email was sent. **Closed on 2026-08-26 by removal**, see below.

## Backend posture: the email-preference surface is retired

The earlier posture was to keep the matrix and mark every item
`comingSoon: true`. That was the wrong shape for a permanent position: it left a
stored, unreadable, undeliverable preference standing next to a privacy policy
that says the platform sends no email. As of 2026-08-26 the whole surface is
gone:

- `GET|PATCH /account/email-preferences` removed
  (`src/account/account.controller.ts`).
- `UpdateEmailPreferenceDto` and the `EmailPreference` entity deleted.
- `DEFAULT_EMAIL_PREFERENCES` / `LOCKED_EMAIL_CATEGORIES` removed
  (`src/account/account.constants.ts`).
- `EmailPreferenceResponse`, including the always-`true` `comingSoon` flag,
  removed (`src/account/account-response.ts`).
- `AccountService.getEmailPreferences` / `updateEmailPreference` removed, along
  with the repository injection.
- The `email_preference` table dropped by
  `src/migrations/1795740000000-DropEmailPreference.ts`, which carries the
  reasoning and a `down()` restoring the exact schema.

Nothing on the frontend called any of it, so no UI changed. What remains, and is
untouched, is the real preference system for the channels that exist: in-app and
push, at `GET|PUT /me/notification-preferences` (`src/notifications`).

## If you are about to add email

Adding a transport is not a code change with a config flag on it. Nothing in
`src/` may reintroduce one until all four of these are decided and written down,
by the owners named at the top:

1. **Deliverability.** A sending domain, SPF, DKIM and DMARC records, a
   monitored bounce and complaint path, and someone accountable for the sender
   reputation. Mail that silently lands in spam is worse than no mail: the
   product believes it delivered.
2. **Consent.** Which categories are transactional (a member asked for this
   specific thing) and which are marketing (they did not). Marketing mail needs
   a working unsubscribe on every message, honoured before the next send, and a
   lawful basis recorded for each address.
3. **An outbox.** A persisted queue with a deterministic idempotency key per
   message, so a retry cannot double-send and a failure is visible rather than
   swallowed in a log line. Sending inline from a request handler is what the
   removed `MailerService` did, and it is how a flaky provider turns into a
   timing oracle or a duplicated notice.
4. **A sub-processor entry.** An email provider processes members' addresses
   and message contents. It belongs in the privacy policy's sub-processor list
   and in the DPA record before the first send, not after.

Only once those exist does an implementation order make sense, and it should be
harm-first: the 30-day erasure warning, then moderation and appeal outcomes to a
locked-out member, then join-request approve/decline, then DSAR responses.
Bulk mail (digests, newsletter) comes last and needs item 2 fully in place.

When and if that happens, the `comingSoon` flag and the inert banners listed
above come off, and the softened copy below is restored to promise the email
that would then actually arrive. Until then, treat any code review that
introduces a mail transport as a blocking finding and point at this file.

## Related copy to soften (frontend)

Some FE copy currently promises email delivery and should read "email isn't live
yet" (or be channel-neutral) so the product doesn't imply a channel that isn't
wired.

**Softened in the P1 pass (EN + PT, in lockstep):**

- `catalogs/{en,pt}/community.ts` — reading-group waitlist "We'll email you the
  moment someone cancels" → channel-neutral "We'll let you know the moment a spot
  opens up".
- `catalogs/{en,pt}/system.ts` — pending-review activation "You'll get an email
  with a single-use link" → "You'll get a single-use link to activate your
  account".
- `catalogs/{en,pt}/gatherings.ts` — organiser broadcast + invite success copy
  "they'll get it by email and in their QueerPulse notifications" → "…in their
  QueerPulse notifications" (in-app only).

**Deliberately left (documented, not softened) — needs a product/feature call,
not a copy tweak:**

- `catalogs/{en,pt}/system.ts` — the **magic-link re-auth** flow
  (`verificationNeeded.magicLink.*`, "We'll email a one-time confirmation link").
  This is a whole step-up-auth feature, not just a string; softening the copy
  without deciding the flow would misrepresent it. The **status page**
  (`status.services.*`, `status.incidents.emailDelay.*`, `maintenance.affected.email`)
  is a monitoring dashboard describing components/past incidents — not a promise
  to the reader — so it stays.
- `catalogs/{en,pt}/settings.ts` — the email-delivery **preferences block**
  (`notifications.delivery.email.*`) is already gone from the catalogue. The
  remaining email wording there was rewritten on 2026-08-26 to name
  notifications instead: the delete-account pause strip
  (`deleteAccount.pauseStrip.cta`, `deleteAccount.toast.pausedEmails`) and the
  reading-frequency options (`interests.freq.*`). There is no email channel to
  offer a coming-soon state for.
- `catalogs/{en,pt}/gatherings.ts` — **ticket-by-email** copy inside the
  Multibanco/ticketing flow sits behind the already-gated fake-payment surface
  (P0-6); soften it when that flow is wired to a real PSP.
- `catalogs/{en,pt}/marketing.ts` — privacy-policy / help text where "email"
  legitimately refers to the **OAuth sign-in identity** (true today) — leave.
- Terms page — the "email notification of terms changes" promise (item 6):
  channel-neutralise when the Terms copy is next revised.
