# Data Subject Access Request (DSAR) Runbook

**Status:** LG-06. How a data-subject request is received, verified, worked and
closed, with a service level that stays inside the statutory one.

**Related:** `docs/ops/retention-periods.md` (what is held and for how long),
`docs/ops/sub-processors-and-processing.md` (who else holds it),
`docs/ops/breach-notification.md` (a request that turns out to be a breach
report).

---

## 0. Owner

| Role | Who | What they own |
|---|---|---|
| **DSAR owner** | `[OWNER: name and contact to be filled in]` | The queue. Acknowledges, works and closes every request. Answers for the clock. |
| **Backup DSAR owner** | `[OWNER: name and contact to be filled in]` | Everything above whenever the owner is away, and by default on any request whose deadline falls inside an absence. |
| **Escalation for a refusal or an extension** | `[OWNER: name and contact to be filled in]` | Signs off any decision to refuse, narrow, or extend. The DSAR owner does not make that call alone. |

**Cover.** Before any absence longer than three days, the owner hands the backup
a written list of every open request with its `dueBy` date. A request whose
deadline falls inside the absence is reassigned before the absence starts, never
during it. `[OWNER: confirm this handover ritual and where the list lives]`

**Access needed.** Both owners need the `moderator` or `admin` platform role,
which is what `GET /admin/dsar` is guarded by
(`src/admin-dsar/admin-dsar.controller.ts:46-51`). The controller's own comment
explains the choice: "answering a data request inside the statutory window is
operational work, not an admin-only privilege"
(`admin-dsar.controller.ts:41-44`).

---

## 1. The service level

### 1.1 What the law requires

- **One month** from receipt to respond (Article 12(3)). Not 30 days: a request
  received on 15 January is due on 15 February.
- **Extendable by two further months** for complex or numerous requests, but only
  if the requester is told **inside the first month**, with the reasons.
- **Free of charge** (Article 12(5)), except for manifestly unfounded or
  excessive requests.
- **A refusal still needs an answer**, inside the same month, with the reasons
  and a note about complaining to the supervisory authority.

### 1.2 What the platform enforces

The backend stamps `dueBy = submittedAt + 30 days`
(`DSAR_DUE_DAYS = 30`, `src/account/account.constants.ts:15`;
`AccountService.submitDsar`, `src/account/account.service.ts:507-524`). Thirty
days is **stricter** than one calendar month in every month except February, so
the platform's own deadline is safe to work to. The admin queue sorts by `dueBy`
ascending, "because here the question is never 'what just arrived', it is 'what
runs out next'" (`src/admin-dsar/admin-dsar.service.ts:54-63`), and each row
carries a countdown and an overdue flag (`admin-dsar.controller.ts:36-38`).

The published promise matches: *"It's free and we respond within 30 days"*
(`queerpulse/src/shared/i18n/catalogs/en/marketing.ts:1139-1140`) and *"We'll
respond within **30 days**, as required by law"*
(`dsar.legalStrip`, `queerpulse/src/shared/i18n/catalogs/en/marketing.ts:676-677`).

### 1.3 The internal SLA

Set so the legal deadline is never the first one hit.

| Stage | Internal target | Measured from |
|---|---|---|
| **Acknowledge** | **2 working days** | `submittedAt` |
| **Identity confirmed** | **3 working days** | `submittedAt` |
| **Move to `in_review`** | **5 working days** | `submittedAt` |
| **Complexity call** (ordinary, or needs an extension) | **10 calendar days** | `submittedAt` |
| **Extension notice sent, if needed** | **20 calendar days** | `submittedAt`, so it lands well inside the first month |
| **Internal completion target** | **21 calendar days** | `submittedAt` |
| **Platform deadline `dueBy`** | 30 days | `submittedAt` |
| **Statutory deadline** | one month | receipt |

The nine-day gap between the internal target and `dueBy` is deliberate: it
absorbs an owner falling ill, a requester replying late to a clarification, and
the one thing that reliably eats a week, which is discovering mid-request that
the answer needs a code change.

**Working the queue.** Open `/admin/dsar` (`queerpulse/src/app/routeMap.ts:87`)
at least **twice a week**. Nothing pages anyone when a `dueBy` approaches: there
is no alerting on this queue, which makes the calendar habit the control.

---

## 2. Request types

The register in `docs/ops/sub-processors-and-processing.md` §2 has to match this
list, so all seven are covered here even where the intake form does not offer
them.

| Right | Article | Intake today | Notes |
|---|---|---|---|
| **Access** | 15 | `POST /account/dsar` with `article: 15`, and the self-service export | The export is usually the faster and more complete answer. See §4. |
| **Rectification** | 16 | `POST /account/dsar` with `article: 16` | Most rectification is self-service: a member edits their own profile. A DSAR is for what they cannot edit. |
| **Erasure** | 17 | `POST /account/dsar` with `article: 17`, and self-service account deletion | The form's own copy is careful here: "This is separate from deleting your account. Tell us exactly what you want removed" (`marketing.ts:642-643`). |
| **Restriction** | 18 | **No dedicated intake.** The DTO accepts only 15, 16, 17, 21 (`src/account/dto/submit-dsar.dto.ts:14`; `src/account/entities/dsar-request.entity.ts:3-6`) | Accept it as an Article 21 objection with the restriction described in `details`, and handle it under §5.4. This gap is item D10 in `docs/ops/retention-periods.md` §2.3. |
| **Portability** | 20 | **Self-service**: `POST /account/export` (`src/account/account.controller.ts:131-149`) | Structured, commonly used, machine-readable JSON, plus CSV in a zip. This is a complete Article 20 answer for a member who can sign in. |
| **Objection** | 21 | `POST /account/dsar` with `article: 21` | The commonest real case is objecting to error monitoring, which is already self-service: withdrawing `monitoring` consent stops transmission live (`queerpulse/src/shared/observability/sentry.ts:91-97`). |
| **Withdraw consent** | 7(3) | **Self-service, three separate places** | Cookie and monitoring consent through the preference centre, writing an append-only `consent_record` row (`src/consent/entities/consent-record.entity.ts:21-25`). Special-category flatmate fields by clearing `special_category_consent_at`, which also clears the fields (`src/flatmate-profiles/entities/flatmate-profile.entity.ts:139-152`). Push notifications by revoking browser permission. |

**Tell requesters about the self-service routes first.** For access, portability
and most rectification and erasure, self-service is faster for the member and
lighter for the platform. It is never a substitute for answering a DSAR that has
been filed.

---

## 3. How a request arrives

### 3.1 The intended path

A signed-in member opens `/policies/privacy/data-request`
(`queerpulse/src/app/routeMap.ts:174`,
`queerpulse/src/features/marketing/DsarPage.tsx`), picks a right, describes what
they want, selects the data scopes, and submits.

`POST /account/dsar` writes a `dsar_request` row with a `DSAR-XXXXXXXX`
reference, `status: received`, and `dueBy` 30 days out
(`src/account/account.service.ts:507-524`,
`src/account/entities/dsar-request.entity.ts:20-76`). The member sees the
reference in a toast (`marketing.ts` key `dsar.toast.submitted`) and the request
appears in their own history at `GET /account/dsar`
(`src/account/account.controller.ts:489-492`).

Input is bounded: at most 10 scopes of 64 characters, 4000 characters of details,
1000 of context (`src/account/dto/submit-dsar.dto.ts:17-35`).

### 3.2 Requests that arrive another way

A request is valid however it arrives. GDPR imposes no form. If one comes in
through the contact form (`src/inquiries`), a moderator DM, or in person:

1. Record it the same day. If the requester has an account and can sign in, ask
   them to file it through the form so it lands in the queue with a real `dueBy`.
2. If they cannot or will not, **the clock still runs from the day it arrived**,
   and the request has to be tracked outside the platform.
   `[OWNER: decide and record where an off-platform DSAR is tracked]`
3. A request from someone with **no account** (an invite applicant, a newsletter
   subscriber, someone named in a report) cannot be filed through the form at
   all, because `POST /account/dsar` requires a session. These are always
   off-platform. See §5.5.

---

## 4. Verifying identity without collecting more data

Article 12(6) allows asking for more information only where there is **reasonable
doubt** about who the requester is. Asking a member who is already signed in to
photograph an ID card is the classic mistake: it collects a new special-category
risk in order to answer a request about privacy.

### 4.1 A signed-in member: already verified, strongly

`POST /account/dsar` requires a **step-up re-authentication token**
(`reauthToken`, `src/account/dto/submit-dsar.dto.ts:37-40`;
`AccountService.submitDsar`, `src/account/account.service.ts:508`).

That token is not a formality:

- It is minted only by completing a **real Google OAuth round trip with
  `prompt=login`** as the same already-signed-in member
  (`src/account/account.controller.ts:55-63`).
- The stored copy is SHA-256 hashed, and the row is **consumed on use**, so one
  step-up authorises exactly one action
  (`src/account/account.service.ts:117-143`).
- It lives 5 minutes (`REAUTH_TTL_MS`, `src/account/account.constants.ts:6`).

So a filed DSAR proves: the requester held a valid session **and** re-proved
control of the Google account within the last five minutes. **That is stronger
evidence than any document check, and no further verification may be asked
for.**

### 4.2 An off-platform request from someone who has an account

Ask them to file it through the form. That is not bureaucracy, it is the
verification. If they genuinely cannot sign in, that is itself an access problem
worth solving first, and the answer is never "send us a photo of your passport".

Acceptable alternatives, in order of preference:

1. They sign in and send an in-app message from the account, then reference it.
2. They confirm a fact only the account holder would know that is already held
   (their join date, who invited them, the reference of an earlier request).
3. Only if neither works, and only where there is real doubt, ask for the minimum
   identifying detail. Document the reasoning. Delete whatever was collected as
   soon as the request is closed, and record that deletion in the case file.

### 4.3 Someone with no account

See §5.5. Verification is by whatever they used to reach the platform in the
first place, for example the email address on their invite application, and the
answer scope is limited accordingly.

### 4.4 A request from a third party on someone's behalf

Require written authority from the data subject **and** verification of the data
subject themselves through §4.1 or §4.2. Do not disclose to a representative on
their say-so. In a community where an abusive partner or family member is a
realistic requester, this is a safety control.

---

## 5. Working a request, right by right

Every path ends the same way: `PATCH /admin/dsar/:id`
(`src/admin-dsar/admin-dsar.controller.ts:87-94`) with a status and an
**outcome note**, which is mandatory on any closing move
(`src/admin-dsar/admin-dsar.service.ts:162-167`). Allowed transitions are
`received → in_review → resolved | rejected`, with `received` able to close
directly; terminal states accept nothing, "because re-opening it would restart a
statutory clock that has already stopped"
(`src/admin-dsar/admin-dsar.service.ts:30-47`).

### 5.1 Access (Article 15)

1. Read the `scopes` and `details` on the request to see what they actually want.
   A member asking "what do you have about my housing enquiries" does not want a
   200 MB zip.
2. **Point them at the self-service export first.** `POST /account/export`
   (`src/account/account.controller.ts:131-149`) builds the archive
   synchronously and it downloads from the page
   (`GET /account/export/:jobId/download`, `account.controller.ts:187-200`),
   in JSON or as a zip carrying CSVs plus the member's own media files.
3. **What the export contains**, from the registered contributors: `profile`,
   `messages`, `posts` (forum), `events`, `connections`, `activity`
   (`src/account/account-export.service.ts:72-104`), plus `subprofiles`,
   `listings`, `housing`, `saved`, `notifications`, `consent`, `membershipCards`,
   `magazine`, `communities`, `volunteering`, `governance`, `reviews` and `media`
   (`src/account/data-export-contributors.ts:44-662`). Media bytes are streamed
   into the zip at download time rather than stored in the job payload
   (`src/account/export-media.ts:6-26`), capped at 256 MiB with anything over the
   cap listed by storage key under `skippedOverCap` so the member can see exactly
   what was left behind (`export-media.ts:28-42`).
4. **What the export deliberately excludes, and why.**
   - **Messages other people sent.** `buildMessages` selects
     `where: { senderId: userId }` (`src/account/account-export.service.ts:224-238`),
     so a member gets their own messages and not their correspondents'. This is
     correct: another member's words are that member's personal data, and Article
     15(4) says the right of access must not adversely affect the rights of
     others. Say this plainly if a requester asks.
   - **Moderation records about the member.** `reports` and `mod_audit_logs` have
     no export contributor. A member does have a right of access to these, so a
     request that asks for them has to be answered **by hand**. See §5.6.
   - **Verification records, DSAR history and sessions.** No contributor. DSAR
     history and sessions are readable in-app (`GET /account/dsar`,
     `GET /account/sessions`, `src/account/account.controller.ts:489-507`);
     verification standing is on the member's own settings surface.
5. If the export answers the request, close it as `resolved` with an outcome note
   naming the job id and the categories covered.
6. If it does not, assemble the remainder by hand (§5.6) and say in the outcome
   note what was gathered outside the export.

### 5.2 Rectification (Article 16)

1. Check whether the member can fix it themselves. Profile fields, pronouns,
   handle, subprofiles and most listing content are all self-editable.
2. If not, make the correction and record exactly what changed in the outcome
   note.
3. **Cannot be rectified, and say so:** an append-only log. `consent_record` and
   `policy_acceptance` are historical records of what happened at a moment
   (`src/consent/entities/consent-record.entity.ts:21-25`,
   `src/consent/entities/policy-acceptance.entity.ts:26-27`). A moderator's
   decision note is that moderator's opinion, and Article 16 covers factual
   inaccuracy rather than disagreement. Where a member disputes a moderation
   record, the route is the appeals process
   (`src/moderation/appeals.controller.ts`), and an Article 16(2) supplementary
   statement can be recorded alongside.
4. **Notify recipients** where the corrected data was disclosed onward
   (Article 19). In practice that is other members who saw it. There is no
   mechanism for this beyond editing the visible content.

### 5.3 Erasure (Article 17)

1. **Whole account?** Point them at self-service deletion. `POST
   /account/deletion-request` (`src/account/account.controller.ts:101`) opens the
   30-day grace window (`src/account/account.constants.ts:7`), warns at 3 days
   (`:14`), and then hard-erases with a full cascade
   (`src/account/account-deletion-processor.service.ts:211-368`), including the
   member's bucket objects (`:358-367`). It is cancellable throughout.
2. **Part of their data?** Delete what is genuinely theirs and can be removed
   without breaking someone else's record.
3. **What survives erasure and why**, which the member is entitled to be told:
   - **Moderation records**, pseudonymised rather than deleted, so that "erasing
     your account is not a way to delete the evidence trail against everyone you
     ever reported" (`src/account/account-deletion-processor.service.ts:290-300`).
     Article 17(3)(e), establishment and defence of legal claims, plus the
     legitimate interests of the members those reports protect.
   - **A one-way hash of the email address**, so the account cannot be silently
     recreated (`account-deletion-processor.service.ts:276-288`). It cannot be
     turned back into the address.
   - **Ban-evasion signals**, which are HMAC hashes under a server-side pepper
     with no IP address and no device fingerprint, and which are designed to
     outlive the account precisely because the account is gone
     (`src/ban-evasion/entities/removed-account-signal.entity.ts:20-45`).
   - **Content other members depend on**: a gathering they were hosting, a
     listing, a job posting. Eleven FKs are `ON DELETE SET NULL`, so these survive
     with the byline removed, and `ContentOwnerErasureService` hands each future
     gathering to a co-host or cancels it with a notification to everyone holding
     an RSVP (`src/account/account-deletion-processor.service.ts:237-254`).
4. **Backups.** An erasure does not reach into an off-provider `pg_dump`.
   `docs/ops/backup-restore.md` §5 flags that "a backup of the bucket also
   re-materialises objects a user asked to be erased". The honest answer is that
   backups age out on their lifecycle schedule and that a restore is followed by
   re-applying pending erasures.
   `[OWNER: confirm the backup lifecycle, and add a post-restore erasure replay
   step to backup-restore.md]`
5. Close with an outcome note listing what was erased and what was kept, with the
   exemption relied on for each kept item.

### 5.4 Restriction (Article 18)

No dedicated intake exists (§2). Handle a restriction request as follows:

1. Record it, with the clock running from the day it arrived.
2. Restriction usually means "stop using this while we argue about it". The
   levers that exist:
   - **Account deactivation**, which reversibly hides the member
     (`POST /account/deactivate`, `src/account/account.controller.ts:85`).
   - **Profile visibility settings**, member-controlled.
   - **Content moderation hide**, which withholds a specific item without
     deleting it (`src/content-moderation`).
   - **Withdrawing consent** on the special-category flatmate fields, which
     clears them (`src/flatmate-profiles/entities/flatmate-profile.entity.ts:139-142`).
3. Where none of these fits, say so honestly and record what was done instead.
4. Note the standing gap in the outcome: the platform has no "flag this row as
   restricted" mechanism.

### 5.5 A requester with no account

An invite applicant, a newsletter subscriber, someone who used the contact form
(`src/inquiries/entities/inquiry.entity.ts:19-25`), or someone named in another
member's report.

1. They cannot file through the form and there is no email channel to answer them
   on (`docs/ops/no-mailer-at-launch.md`).
2. Verify against whatever identifier they gave when the data was collected.
3. Answer through the same channel the request arrived on. Record that channel in
   the case file, since it is the only evidence the answer was delivered.
4. **Someone named in a report they did not file** has a right of access to their
   own personal data inside it, and the reporter has a competing right. Redact
   the reporter's identity and anything that would reveal it. Escalate to
   `[OWNER: escalation contact]` before disclosing any report content.

### 5.6 Assembling data that has no export contributor

For an access request that reaches beyond the export, gather by hand from:

| What | Where | Notes |
|---|---|---|
| Reports the member filed | `reports.reporter_id` | Theirs. Disclosable. |
| Reports naming the member | `reports.subject_id` plus the `evidence` jsonb | Redact reporter identity. |
| Moderator actions against them | `mod_audit_logs.target_user_id` and `target_name` (`src/moderation/entities/mod-audit-log.entity.ts:55-80`) | Include the action and the reason code; consider whether the free-text `note` reveals a third party. |
| Appeals | `appeals` | Theirs. |
| Verification standing | `member_verifications`, `verification_requests` (`src/verification/entities`) | Level, method, opaque provider ref. No documents are held. |
| Sessions | `refresh_tokens` (`src/auth/entities/refresh-token.entity.ts`) | Device label, user agent, session timestamps. No IP address is stored. |
| DSAR history | `dsar_request` | Also readable by the member at `GET /account/dsar`. |
| Housing viewings and reviews | `housing_viewings`, `housing_reviews` | A two-sided review names the counterparty; redact. |
| Card scans | `membership_card_scans` | Only the last 90 days exist (`src/membership-cards/card-scan-retention.service.ts:19`). |

There is **no admin screen** that assembles any of this. It is a hand-written
query, which is the main reason the internal target in §1.3 sits nine days ahead
of the deadline.

---

## 6. Delivering the answer, given there is no email

QueerPulse sends no email (`src/account/account.constants.ts:29-35`, `src/migrations/1795740000000-DropEmailPreference.ts`,
`docs/ops/no-mailer-at-launch.md`). Delivery works like this:

1. **Close the request in the admin queue.** A terminal move to `resolved` or
   `rejected` stamps `respondedAt` and `resolvedByUserId` and fires an in-app
   notification to the member (`src/admin-dsar/admin-dsar.service.ts:174-182`).
2. **The notification is the dedicated `DsarResolved` type.** It used to borrow
   `ConcernUpdate`, which meant a member exercising a statutory right read "The
   concern you raised has been reviewed and resolved" in their bell
   (`src/admin-dsar/admin-dsar.service.ts:192-200`). It is also on the
   always-delivered list, because it "carries the member's own case reference and
   there is no other channel it arrives on, so it is not something a volume
   control may swallow" (`src/notifications/notification-preferences.ts:226-229`).
3. **The substance goes in the outcome note**, which is mandatory and which the
   member sees against their request in `GET /account/dsar`. Write it for the
   member rather than for the file: what was asked, what was done, what was not done and
   why.
4. **Files** are delivered by the member downloading them from
   `GET /account/export/:jobId/download` while signed in
   (`src/account/account.controller.ts:187-200`). Nothing is pushed to them.
5. **A requester with no account** gets the answer on whatever channel they used
   (§5.5).
6. **Do not tell anyone to watch their inbox**, anywhere: the outcome note, a DM,
   the UI copy. `dsar.rights.access.formSub` currently says "send it
   to you", which is item D11 in `docs/ops/retention-periods.md` §2.3.

**Consequence to accept and record.** A member who files a DSAR and never signs
in again has an answer waiting that they never see. The `respondedAt` stamp shows
the platform responded in time. It does not show the member read it. This is a
real limitation of having no out-of-band channel, and it belongs in the case file
rather than being glossed over.

---

## 7. The record

Every request leaves a durable record on the `dsar_request` row: reference,
article, scopes, details, `submittedAt`, `dueBy`, `respondedAt`, `outcomeNote`,
`resolvedByUserId` (`src/account/entities/dsar-request.entity.ts:20-76`).
`resolved_by_user_id` is `ON DELETE SET NULL`, so "losing the reviewer's account
must never delete the record of a statutory request being answered" (`:71-73`).

**No sweeper deletes a `dsar_request` row** (`docs/ops/retention-periods.md`
§1.9). That is correct: the record is the evidence of compliance.

Keep a separate case file, outside the platform, for anything that does not fit
the row: an off-platform request, a verification step and what was collected and
then deleted, a redaction decision, an extension notice, a refusal and its
reasoning. `[OWNER: decide and record where DSAR case files live, and who can
read them]`

---

## 8. Refusing or narrowing a request, lawfully

A refusal is still a response, it is still due inside the month, and it still has
to say why and mention the right to complain to the CNPD.

**Never refuse without the escalation sign-off in §0.**

### 8.1 Grounds that genuinely apply here

- **Article 12(5), manifestly unfounded or excessive, in particular repetitive.**
  A member filing the same access request weekly. Either charge a reasonable fee
  or refuse, with reasons. This is a narrow ground; annoyance is not
  excessiveness.
- **Article 15(4), the rights and freedoms of others.** The reason another
  member's messages are not in an access export
  (`src/account/account-export.service.ts:224-238`), and the reason a reporter's
  identity is redacted from a report disclosed to the person it names.
- **Article 17(3)(e), legal claims.** The reason moderation records survive
  erasure in pseudonymised form
  (`src/account/account-deletion-processor.service.ts:290-300`).
- **Article 11(2), the controller cannot identify the data subject.** Rare here,
  because the intake is authenticated (§4.1). It can apply to an off-platform
  request from someone who cannot be tied to any account.
- **Article 12(6), reasonable doubt about identity.** See §4.2. Ask for the
  minimum, and only where the doubt is real.

### 8.2 Grounds that do not apply, whatever the temptation

- **"It is technically inconvenient."** Not a ground. §5.6 is hand work, and hand
  work is still work that has to be done.
- **"They are banned."** A banned member keeps every data right. Note the
  practical problem: `ActiveMemberGuard` shuts them out of most in-app surfaces,
  so both the intake and the answer may need to be off-platform
  (`docs/ops/no-mailer-at-launch.md` §2c). Solve the channel; do not refuse the
  right.
- **"We would rather not."** Not a ground.

### 8.3 Narrowing instead of refusing

Usually better than a refusal. Answer the part that is clear, and ask the
requester to clarify the rest. Two rules:

1. **Asking for clarification does not pause the clock** unless the request is
   genuinely unclear about what is sought, and even then, ask inside the first
   few days rather than at week three.
2. **Say what was answered and what was not**, in the outcome note. A partial
   answer that pretends to be complete is worse than an honest partial one.

### 8.4 Extensions

Two extra months for complex or numerous requests, and the requester must be told
inside the first month with the reasons. The internal target is day 20 (§1.3).

`dsar_request` has **no field for an extension**: `dueBy` is written once at
submission (`src/account/account.service.ts:510`) and nothing updates it. So an
extension has to be recorded in the outcome note and in the case file, and the
queue will show the request as overdue against its original `dueBy` for the whole
extension. Live with the red flag; do not close the request early to clear it.

---

## 9. Quick reference

| Need | Where |
|---|---|
| Member-facing request form | `/policies/privacy/data-request` (`queerpulse/src/app/routeMap.ts:174`) |
| Member's own request history | `GET /account/dsar` (`src/account/account.controller.ts:489-492`) |
| Admin queue | `/admin/dsar` (`queerpulse/src/app/routeMap.ts:87`), `GET /admin/dsar` (`src/admin-dsar/admin-dsar.controller.ts:61-64`) |
| One request in full | `GET /admin/dsar/:id` (`admin-dsar.controller.ts:69-74`) |
| Close a request | `PATCH /admin/dsar/:id` (`admin-dsar.controller.ts:87-94`) |
| Self-service export | `POST /account/export` (`src/account/account.controller.ts:144-149`) |
| Export download | `GET /account/export/:jobId/download` (`src/account/account.controller.ts:187-200`) |
| Self-service deletion | `POST /account/deletion-request` (`src/account/account.controller.ts:101`) |
| Deactivate | `POST /account/deactivate` (`src/account/account.controller.ts:85`) |
| Sessions | `GET /account/sessions` (`src/account/account.controller.ts:507`) |
| What is held and for how long | `docs/ops/retention-periods.md` |
| Who else holds it | `docs/ops/sub-processors-and-processing.md` |
