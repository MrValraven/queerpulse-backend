# Decision: No transactional email at launch

**Status:** Accepted — launch-gating decision, consciously taken (not an accident).
**Date:** 2026-08-03
**Owners:** Platform / Governance
**Audit reference:** `queerpulse/docs/production-readiness/AUDIT-2026-07-30.md` — §L (The Mailer Question) and finding **P1-13**.

---

## Decision

QueerPulse launches with **no transactional mailer**. There is no email provider,
no mail dependency, and no sender wired anywhere in the backend (no
nodemailer / Postmark / SendGrid / SES). Sign-in is Google-OAuth-only, so
password-reset email is genuinely not needed — but a set of flows that would
normally reach a member (or a not-yet-member) **out of band** have no channel at
launch. This document records that gap, the flows it affects, and the follow-up.

We are shipping the gap **documented and honest** rather than building a mailer
now, and rather than leaving copy that silently promises email it can't send.

## Why launch without one

- Auth is Google-OAuth-only — the single flow that *cannot* work without email
  (password reset) doesn't exist here, so email is not on the critical auth path.
- A mailer done properly (deliverability, DKIM/SPF/DMARC, bounce handling,
  idempotent keyed sends, unsubscribe for non-transactional mail) is more work
  than the launch scope allows, and doing it badly is worse than not doing it.
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
   channel. (The FE Terms copy promises email notification — see the follow-up.)

7. **Newsletter / digests + the whole `email_preference` matrix.**
   `GET|PATCH /account/email-preferences` (`src/account`) stores per-category
   toggles (`productUpdates`, `communityDigest`, `eventReminders`,
   `directMessages`, `securityAlerts`) but **nothing acts on them** — no digest
   is built, no email is sent. This is dead weight until a mailer exists.

## Backend posture at launch (how the gap is marked)

The email-preference surface is kept (so it's ready the day the mailer lands) but
marked **not-yet-active** so nothing implies delivery:

- `EmailPreferenceResponse` now carries a `comingSoon: boolean` that is
  **always `true`** at launch; every item from `GET /account/email-preferences`
  returns it. (`src/account/account-response.ts`, `src/account/account.service.ts`)
- `DEFAULT_EMAIL_PREFERENCES` / `LOCKED_EMAIL_CATEGORIES` carry a not-yet-active
  banner comment. (`src/account/account.constants.ts`)
- Both endpoints' Swagger `@ApiOperation` summaries state plainly that toggles
  are stored but not delivered. (`src/account/account.controller.ts`)
- The FE email-template catalogue (`account.api.ts:20-40`) is already labelled
  "⚠️ NONE OF THIS IS BUILT" and is a design note, not a promise — leave it.

Nothing above sends mail; they make the *absence* explicit in the payload and the
docs so a consumer cannot mistake a stored toggle for a working switch.

## Follow-up (the actual fix, later)

Ship a **minimal Postmark transactional mailer** (Postmark is already in the
governance budget), covering, in priority order:

1. **Erasure warning** (D-7 / D-1 before the 30-day hard erase) — item (1).
2. **Join-request** approve/decline to the applicant — item (2).
3. **Moderation outcome + appeal decision** to a locked-out member — items (3)/(4).
4. **DSAR response** within `dueBy` — item (5).

Non-transactional mail (digests/newsletter, item 7) comes after, and needs
unsubscribe handling; the `email_preference` matrix is where those toggles
already live. When the mailer lands, drop the `comingSoon` flag and the
not-yet-active banners listed above.

Track this as a **launch-gating decision**, not a bug — the launch checklist
should carry "no email at launch (accepted)" with a link here.

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
  (`notifications.delivery.email.*`, "paused for 30 days"). This is a settings UI
  for a future feature; the backend `email_preference` matrix is already flagged
  `comingSoon`, so the toggles should surface a coming-soon state rather than
  have their copy rewritten.
- `catalogs/{en,pt}/gatherings.ts` — **ticket-by-email** copy inside the
  Multibanco/ticketing flow sits behind the already-gated fake-payment surface
  (P0-6); soften it when that flow is wired to a real PSP.
- `catalogs/{en,pt}/marketing.ts` — privacy-policy / help text where "email"
  legitimately refers to the **OAuth sign-in identity** (true today) — leave.
- Terms page — the "email notification of terms changes" promise (item 6):
  channel-neutralise when the Terms copy is next revised.
