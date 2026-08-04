# No Transactional Email at Launch

**Status:** conscious launch decision (audit P1-13 / §L "The Mailer Question").
QueerPulse ships **without any mailer**. There is no mail provider, no
dependency, no sender — no nodemailer/Postmark/SendGrid/SES anywhere in the
backend. This is a **decision, not an oversight**: it is recorded here so that
every flow that would normally reach a member out-of-band is a known, accepted
gap rather than a silent one.

**Why this is tenable at all:** auth is **Google-OAuth-only + invite redemption**.
There is no password on a QueerPulse account, so the one flow email is usually
load-bearing for — password reset — **genuinely does not exist and is not
needed**. Email verification is likewise moot (Google already verified the
address). What email *would* have carried is a set of **notice/receipt** flows,
none of which block sign-in. Those are enumerated below with how each behaves
without email, and the risk each carries.

**Scope:** the production NestJS backend and the React frontend copy that
describes these flows. The FE used to literally catalogue the unbuilt templates
in `queerpulse/src/features/settings/api/account.api.ts` (the "Email template
catalogue" block) — that block stays as the design-of-record for when email
lands, and it already warns "Do not write UI copy that promises any of these
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

- [ ] **Newsletter double-opt-in confirmation** (`homepage:*` newsletter subscribe
      copy + `system:*` "we'll email a one-time confirmation link"). The newsletter
      cannot send a confirmation link with no mailer. Either gate the newsletter
      form behind demo mode or soften the copy. Tracked with the homepage owner.
- [ ] **Event RSVP / host copy** ("you'll receive a confirmation email",
      "you'll get an email notification for each new attendee",
      `gatherings:*`). Owned by the events work-stream. In-app notifications
      exist; the email half is the false promise.
- [ ] **DSAR intake** (`marketing:dsar.legalStrip` — "we'll respond within 30
      days"). Does **not** over-promise email specifically (legally accurate),
      but the *response channel* is the gap in §3 below.

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
at all. That risk is named per-flow below and is the reason a mailer is the first
post-launch infrastructure item.

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
  to be reachable. First to wire when a mailer lands.

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
  cadence control, weekly-digest toggles, and the newsletter double-opt-in all
  presuppose a mailer. **None can function.**
- **In-app handling:** the settings email-delivery and login-alert controls are
  already `comingSoon`-gated (rendered `inert` with a "Coming soon" badge), so
  they don't lie. The **newsletter confirmation copy** is the exception still to
  close (see §0).
- **Risk:** none to safety — this is unused schema and inert UI. The only risk is
  a member *subscribing* to a newsletter that can never send them a confirmation.

---

## 3. When we add a mailer — wire order

Postmark is already in the governance budget; it is the intended provider (see
the template catalogue in `account.api.ts`). All sends are **transactional** (no
unsubscribe) unless noted, each carries a deterministic `messageKey` for
idempotent resends. Wire in this order (harm-reduction first):

1. **Erasure grace-window warning (D-7 / D-1)** — §2a. The only flow where the
   absence of email causes *irreversible* harm to a member who wanted reaching.
2. **Moderation / appeal outcome** — §2c. Closes the due-process gap for
   locked-out members; the one flow the app *structurally cannot* deliver in-app.
3. **Join-request approve/decline** — §2b. Removes the manual-copy step and the
   silent-decline gap.
4. **DSAR received + resolved** — §2d. Puts the statutory clock on rails instead
   of a human's memory.
5. **Data-export ready** (if/when export goes async) — §2f. Today it's synchronous
   and downloads on the page, so this is only needed if the worker model changes.
6. **Terms-change notice**, then **newsletter/digests** — §2e/§2f. Lowest harm;
   newsletter is the only non-transactional (needs unsubscribe + double-opt-in).

When any of these lands, **re-audit the corresponding copy** — the softened
strings in §0 should be restored to promise the email that now actually arrives.

---

## 4. What this does NOT cover (adjacent, tracked elsewhere)

- **In-app notifications** exist and are unaffected — this doc is only about the
  out-of-band (email) channel. ~14 notification *types* are still missing (audit
  §K); that's a separate gap.
- **The `email_preference` schema** stays in place as dead weight rather than
  being dropped — cheaper to leave than to migrate out and back in when Postmark
  lands. Recorded here so it isn't mistaken for a live feature.
- **Bucket object deletion on erasure** (no `DeleteObjectCommand`) — a separate
  erasure/GDPR gap noted in `backup-restore.md` §5.
