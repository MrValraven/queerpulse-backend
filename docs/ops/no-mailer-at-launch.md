# No Mailer, Ever: the flow-by-flow record

**Status:** accepted and in force (audit P1-13 / §L "The Mailer Question").
**Reaffirmed:** 2026-08-26, after a mailer was built and removed again.
**Companion record:** `docs/ops/no-email-at-launch.md` states the same decision
and carries the "if you are about to add email" bar. This file is the
operational half: what each affected flow does instead, and the risk it carries.

QueerPulse delivers **no email**. There is no mail provider, no dependency, no
sender anywhere in the backend. This is a **decision, not an oversight**: it is
recorded here so that every flow that would normally reach a member out of band
is a known, accepted gap rather than a silent one.

## What happened in August 2026

A **nodemailer-backed `MailerService`** was introduced in `src/mailer/` in
violation of this decision, wired into `AppModule` with SMTP env vars and four
call sites (intake concern update, ops inquiry ping, listing-draft resume link,
newsletter confirmation). It ran log-only until SMTP env was set, so one
production env change would have started delivering mail on paths that had
never been reviewed for deliverability, consent, or unsubscribe.

**It was removed in full on 2026-08-26** (LB-07): the module, the config
factory, the SMTP env validation and `.env.example` block, the `nodemailer` and
`@types/nodemailer` dependencies, and every call site. **Nothing in `src/` may
reintroduce an outbound mail transport.** The bar that would have to be cleared
first is in the companion record, and repeated at the end of this file.

**Why this is tenable at all:** auth is **Google-OAuth-only + invite redemption**.
There is no password on a QueerPulse account, so the one flow email is usually
load-bearing for — password reset — **genuinely does not exist and is not
needed**. Email verification is likewise moot (Google already verified the
address). What email *would* have carried is a set of **notice/receipt** flows,
none of which block sign-in. Those are enumerated below with how each behaves
without email, and the risk each carries.

**Scope:** the production NestJS backend and the React frontend copy that
describes these flows. The FE email-template catalogue in
`queerpulse/src/features/settings/api/account.api.ts` is a design note, not a
plan, and it already warns "Do not write UI copy that promises any of these
arrive." This document is the operational half of that warning.

---

## 0. Go-live checklist (copy promises that must be gone before real users)

The launch blocker is **honesty**: no screen may promise an email that will
never arrive. The copy audit under P1-13 removed/softened the promises below.
Verify each is still honest before go-live (another edit could regress them):

- [x] **Account-deletion confirm modal** — no longer says "we'll email you to
      finish the request" (`settings:controls.deleteModal.body`, EN + PT).
- [x] **Deletion-scheduled result screen** — no longer says "check your inbox
      for a confirmation email"; now points to sign-back-in-to-cancel
      (`settings:destructiveFlow.delete.resultBody`, EN + PT).
- [x] **Data-export "building" / "ready" copy** — no longer promises "we'll
      email you the moment it's ready"; the archive builds and downloads on the
      page (`settings:dataExport.status.building.body`,
      `settings:modals.dataExport.readyBody`, EN + PT).
- [x] **Session sign-out toast + footnote** — no longer claims "we'll email the
      address on file" as an out-of-band record (`settings:sessions.toast.signedOut`,
      `settings:sessions.footNote`, EN + PT).
- [x] **Privacy-policy & Terms change notice** — no longer promises notice "by
      email"; now "an in-app notice before they take effect"
      (`marketing:privacy.changes.p1`, `marketing:terms.changesTerms.p1`, EN + PT).
- [x] **Moderation-appeal outcome copy** — no longer says "you'll be notified by
      email" / "we'll email you the moment there's an outcome"; now points to the
      in-app appeal-tracking page (`safety:appeal.pending.info`,
      `safety:appealSubmit.notice`, `safety:appealSubmit.success.sub`, EN + PT).

**Still open (owned by other work-streams — do not regress, do not ship a promise):**

- [ ] **Newsletter confirmation** (`homepage:*` newsletter subscribe copy +
      `system:*` "we'll email a one-time confirmation link"). `POST
      /newsletter/subscribe` records a `pending` row and mints a confirm token,
      and **nothing delivers it**: the confirm and unsubscribe routes stay
      reachable only for a token someone is handed out of band. Any copy that
      says a link is on its way is false. Either gate the newsletter form behind
      demo mode or soften the copy. Tracked with the homepage owner.
- [ ] **Event RSVP / host copy** ("you'll receive a confirmation email",
      "you'll get an email notification for each new attendee",
      `gatherings:*`). Owned by the events work-stream. In-app notifications
      exist; the email half is the false promise.
- [ ] **DSAR intake** (`marketing:dsar.legalStrip` — "we'll respond within 30
      days"). Does **not** over-promise email specifically (legally accurate),
      but the *response channel* is the gap named in §2d.

> Demo-mode narrative copy (supper-club Multibanco tickets, magazine print-run
> ship notices, mentorship/economy intros, studio receipts) promises email
> *inside the mock prototype simulation*. It is fiction, not a live launch flow,
> and is intentionally left as-is unless the orchestrator decides otherwise.

---

## 1. The decision, stated plainly

We ship with **no transactional email**. We accept that the flows in §2 have **no
out-of-band channel** at launch. We mitigate by (a) making every one of them
honest in-app — nothing tells a member to expect an email — and (b) keeping the
irreversible/most-dangerous ones visible in-app so a signed-in member can always
see where they stand. The residual risk is that a member who is **locked out**
(banned/suspended) or **has no account yet** (invite applicant) cannot be reached
at all. That risk is named per-flow below, and it is accepted.

---

## 2. Affected flows, how each is handled without email, and the risk

### 2a. Irreversible 30-day account erasure — **highest risk**

- **What email would do:** a D-7 / D-1 "your account erases in N days, sign in to
  cancel" warning during the grace window.
- **Without email:** the grace window is real and cancellation works (sign back
  in with Google → the scheduled erasure is stopped). But there is **no reminder**.
  A member who requested deletion and then forgets has **no nudge** before the
  data is permanently gone.
- **In-app handling:** the deletion-scheduled screen states the 30-day window and
  that signing back in cancels it. Copy no longer implies an email will remind them.
- **Risk:** **irreversible data loss with no second touch.** This is the single
  flow where "no email" can cause real, unrecoverable harm to a member who *wanted*
  to be reachable, and it is the accepted cost of the decision in §1.

### 2b. Join-request approval / decline

- **What email would do:** tell an **applicant who has no account yet** that they
  were approved (with their invite link) or declined.
- **Without email:** the applicant is never told automatically. The admin
  **copies the invite link and sends it manually** (DM, Signal, in person).
- **In-app handling:** the admin UI is already honest about this — it says
  "Nothing has been emailed. Send this invite link to {email} yourself — it's the
  only way they get in" (`admin:*`). This is the model for how "no email" copy
  should read.
- **Risk:** approvals silently stall if an admin forgets to send the link; a
  decline is never communicated at all. Operational drag, not data loss.

### 2c. Moderation outcomes (ban / suspend / warn) and appeal decisions

- **What email would do:** tell a member **why** they were actioned, and the
  outcome of any appeal.
- **Without email:** a banned/suspended member is locked out of most in-app
  surfaces by `ActiveMemberGuard`, so the app **cannot show them the reason**. The
  appeal *status* page is reachable and the copy now points there, but a fully
  banned member may not be able to reach even that.
- **In-app handling:** appeal copy softened to "the outcome shows up on this
  page — check back / sign in to track it" (`safety:*`), which is honest for a
  member who retains enough access to load the appeal tracker.
- **Risk:** **due-process gap.** A member can be actioned and, if locked out, have
  no channel to learn why or to receive an appeal outcome. This is a fairness and
  potentially a legal exposure, not just UX.

### 2d. DSAR responses within the 30-day `dueBy`

- **What email would do:** deliver the DSAR outcome (access/rectification/
  erasure/objection) within the statutory 30 days.
- **Without email:** the request is stored and worked by the privacy team, but the
  **response channel is manual** — a team member must reach the requester out-of-band.
- **In-app handling:** the DSAR page states "we'll respond within 30 days" (legally
  accurate) without promising email specifically.
- **Risk:** a statutory deadline with no automated delivery — reliant on a human
  remembering to respond by whatever channel the requester provided.

### 2e. Terms / privacy-policy change notices

- **What email would do:** notify members of material changes before they take effect.
- **Without email:** notice is **in-app only**. Copy now says exactly that.
- **Risk:** members who don't sign in during the notice window won't see the change
  before it takes effect. Low harm; the version number + date at the top of the
  policy page remain the source of truth.

### 2f. Newsletter / digests / the whole `email_preference` matrix — **dead weight**

- The `email_preference` matrix, the settings "Email notifications" delivery
  cadence control, weekly-digest toggles, and the newsletter confirmation all
  presuppose a mailer. **None can function.** The magazine digest queue and its
  drain cron were deleted outright; shipping an issue writes in-app
  notifications only.
- **Superseded 2026-08-26 for the matrix specifically:** the two
  `/account/email-preferences` routes, the DTO, the category constants, the
  response shape and the `email_preference` table are all removed. See §4.
- **In-app handling:** the settings email-delivery and login-alert controls are
  already `comingSoon`-gated (rendered `inert` with a "Coming soon" badge), so
  they don't lie. The **newsletter confirmation copy** is the exception still to
  close (see §0).
- **Risk:** none to safety — this is unused schema and inert UI. The only risk is
  a member *subscribing* to a newsletter that can never send them a confirmation.

---

## 3. If you are about to add email

There is no wire order waiting to be picked up. Building a transport is a
product decision that has to be retaken, and it does not start in `src/`.
All four of these must be decided and written down first, by the owners of this
record:

1. **Deliverability.** A sending domain, SPF, DKIM and DMARC records, a
   monitored bounce and complaint path, and a named owner for sender
   reputation. Mail that silently lands in spam is worse than no mail: the
   product believes it delivered.
2. **Consent.** Which categories are transactional (the member asked for this
   specific thing) and which are marketing (they did not). Marketing mail needs
   a working unsubscribe on every message, honoured before the next send, and a
   recorded lawful basis per address.
3. **An outbox.** A persisted queue with a deterministic idempotency key per
   message, so a retry cannot double-send and a failure is visible rather than
   swallowed in a log line. The removed `MailerService` sent inline from the
   request handler, which is exactly how a flaky provider becomes a timing
   oracle or a duplicated notice.
4. **A sub-processor entry.** An email provider processes members' addresses
   and message bodies. It belongs in the privacy policy's sub-processor list and
   in the DPA record before the first send, not after.

Only with those settled does an order make sense, and it should be harm-first:
§2a erasure warning, then §2c moderation and appeal outcomes, then §2b
join-request approve/decline, then §2d DSAR, and bulk mail (§2f) last because
it needs item 2 fully in place.

If any of that ever lands, **re-audit the corresponding copy**: the softened
strings in §0 would be restored to promise the email that then actually
arrives. Until then, a code review that introduces a mail transport is a
blocking finding; point at this file.

---

## 4. What this does NOT cover (adjacent, tracked elsewhere)

- **In-app notifications** exist and are unaffected — this doc is only about the
  out-of-band (email) channel. ~14 notification *types* are still missing (audit
  §K); that's a separate gap.
- **The `email_preference` schema** is **gone** as of 2026-08-26, reversing the
  earlier "keep it inert" call recorded in §2f. Once the routes came out there
  was no writer and no reader, and the rows were never in the Art. 20 export
  either, so what remained was personal data with no purpose. Dropping it also
  fails safe in every case: a stored row says either "send me this" (impossible)
  or "do not send me this" (which is satisfied by sending nothing, forever).
  `src/migrations/1795740000000-DropEmailPreference.ts` carries the full
  reasoning and a `down()` that restores the table's exact shape, both indexes
  and its cascading FK. The rows themselves come back only from a database
  backup.
- **Bucket object deletion on erasure** (no `DeleteObjectCommand`) — a separate
  erasure/GDPR gap noted in `backup-restore.md` §5.
