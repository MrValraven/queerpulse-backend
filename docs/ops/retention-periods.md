# Retention Periods

**Status:** LG-05. Every retention period QueerPulse actually enforces, traced to
the code that enforces it, plus the list of places where the published privacy
policy disagrees.

**How to read §1.** "Period" is what the code does. Intent does not appear here. A
row saying **none** means no automated process ever removes that data. That is a
fact about the system, and several of those rows are findings rather than
decisions.

**Configuration.** Five periods are environment-overridable through
`src/config/retention.config.ts:20-55`, validated as optional positive integers
so a typo fails at boot rather than silently disabling a job
(`src/config/env.validation.ts:168-195`). The defaults below are the shipped
production-safe values. All batched sweeps share `RETENTION_BATCH_SIZE` (default
1000) and `RETENTION_MAX_BATCHES_PER_RUN` (default 50)
(`src/config/retention.config.ts:48-54`).

**Scheduler caveat.** Every cron is a single-instance job. The app is
single-replica by design and enforces it at boot
(`src/config/env.validation.ts:221-247`), so the schedules below run once per
tick. Times are the server's local time as `@nestjs/schedule` interprets
`CronExpression`.

---

## 1. What the code enforces

### 1.1 Account lifecycle

| Data | Entity / table | Period the code enforces | Enforced by | Cadence |
|---|---|---|---|---|
| **Account erasure grace window** | `deletion_request` / `DeletionRequest` | **30 days** from the request, then the account is hard-erased | `DELETION_GRACE_DAYS = 30` (`src/account/account.constants.ts:7`); executed by `AccountDeletionProcessorService.eraseDueAccounts` (`src/account/account-deletion-processor.service.ts:150-192`) | Daily at midnight (`account-deletion-processor.service.ts:54`) |
| **Erasure final warning** | `deletion_request.final_warning_sent_at` | Sent **3 days** before the scheduled erasure, once per member | `DELETION_FINAL_WARNING_LEAD_DAYS = 3` (`src/account/account.constants.ts:14`); `warnUpcomingDeletions` (`src/account/account-deletion-processor.service.ts:99-148`) | Same daily tick |
| **What erasure removes** | `users` and 70+ cascading tables | Immediate on erasure | `manager.delete(User, { id: userId })` cascades every member-owned row (`src/account/account-deletion-processor.service.ts:310-334`) | n/a |
| **What erasure keeps** | `reports.reporter_id`, `mod_audit_logs.actor_id` set to NULL rather than deleted; eleven content FKs are `ON DELETE SET NULL` so gatherings, listings, jobs and volunteering survive with a NULL byline | Indefinite, pseudonymised | `src/account/account-deletion-processor.service.ts:290-329` | n/a |
| **Erased member's uploaded objects** | Object storage, keys `<kind>/<userId>/…` | Deleted after the erasure transaction commits, best effort | `StorageService.deleteUserObjects` (`src/storage/storage.service.ts:340`), called at `src/account/account-deletion-processor.service.ts:358-367` | n/a |
| **Email suppression fingerprint** | `email_suppression` / `EmailSuppression` | **Indefinite, by design.** A one-way hash of the erased address so the account cannot be silently recreated | `hashSuppressedEmail` inserted at erasure (`src/account/account-deletion-processor.service.ts:276-288`) | n/a |
| **Step-up reauth tokens** | `account_reauth_token` / `AccountReauthToken` | **5 minutes** TTL (`REAUTH_TTL_MS`, `src/account/account.constants.ts:6`); rows deleted once past `expires_at` | `AccountRetentionService.purgeExpiredReauthTokens` (`src/account/account-retention.service.ts:97-115`) | Every 6 hours (`account-retention.service.ts:97`) |

### 1.2 Data export

| Data | Entity / table | Period | Enforced by | Cadence |
|---|---|---|---|---|
| **Export archive payload** | `data_export_job.data` (jsonb) / `DataExportJob` | **30 days** from generation, then the payload is nulled and the status flips to `expired` | `retention.dataExportArchiveDays`, default 30 (`src/config/retention.config.ts:26-29`); `AccountRetentionService.expireOldDataExportArchives` (`src/account/account-retention.service.ts:46-89`) | Daily at 03:00 (`account-retention.service.ts:46`) |
| **Export job row itself** | `data_export_job` | **none.** The row survives with a null payload | `src/account/account-retention.service.ts:71` sets `data: null` and never deletes | n/a |
| **Download link** | Advertised `expiresAt` on the API response, enforced at the download route | **7 days** from `generatedAt`. `EXPORT_LINK_EXPIRY_DAYS = 7` (`src/account/account.constants.ts:19`); the instant is computed once by `exportLinkExpiresAt` (`src/account/account-response.ts:64-69`), advertised by `toExportJobResponse` (`src/account/account-response.ts:71-73`) and **enforced** by `AccountService.getExportDownload`, which refuses a request past it with a 404 (`src/account/account.service.ts:517-522`). | `AccountService.getExportDownload` | On every download request |
| **Export reuse window** | `data_export_job` | **1 hour**: an identical repeat request inside the window returns the existing job rather than persisting a second full copy (`EXPORT_REUSE_WINDOW_MS`, `src/account/account.constants.ts:21-27`) | `AccountService.requestExport` (`src/account/account.service.ts:412-440`) | n/a |

### 1.3 Sessions and authentication

| Data | Entity / table | Period | Enforced by | Cadence |
|---|---|---|---|---|
| **Refresh-token rows (a session family)** | `refresh_tokens` / `RefreshToken` | **One refresh lifetime past expiry or revocation.** Derived from `JWT_REFRESH_TTL`, default `30d` (`src/config/auth.config.ts:7,31`), so the default effective retention is 30 days past the event. Deliberately derived rather than a hardcoded constant, because a hardcoded 30 days broke a `JWT_REFRESH_TTL=90d` deployment (`src/auth/auth-maintenance.service.ts:18-30`) | `AuthMaintenanceService.purgeExpiredRefreshTokens` (`src/auth/auth-maintenance.service.ts:43-67`) | Daily at midnight (`auth-maintenance.service.ts:43`) |
| **Access token** | Cookie only, no row | **15 minutes** default (`src/config/auth.config.ts:6`) | Signature expiry | n/a |
| **Session metadata** | `refresh_tokens`: coarse device label, user agent, `last_seen_at`, `session_started_at` | Same as the row | `src/auth/entities/refresh-token.entity.ts:44-98` | n/a |
| **IP addresses** | **not stored.** No IP column exists on `refresh_tokens`; the throttler keys on `req.ip` in process memory only (`src/app.module.ts:207-215`); request logs carry method, URL and status only (`src/app.module.ts:174-186`) | n/a | n/a | n/a |

### 1.4 Notifications and push

| Data | Entity / table | Period | Enforced by | Cadence |
|---|---|---|---|---|
| **Read notifications** | `notifications` / `Notification` | **90 days** from `created_at`, `read = true` only | `retention.notificationReadDays`, default 90 (`src/config/retention.config.ts:34-37`); `NotificationRetentionService.purgeOldReadNotifications` (`src/notifications/notification-retention.service.ts:37-57`) | Daily at 01:00 (`notification-retention.service.ts:37`) |
| **Unread notifications** | `notifications` | **none, deliberately.** "A member who hasn't seen it still needs it in their bell" (`src/notifications/notification-retention.service.ts:17-18`) | n/a | n/a |
| **Push subscriptions** | `push_subscriptions` / `PushSubscription` | **90 days** since the later of `last_used_at` and `created_at` | `retention.pushSubscriptionStaleDays`, default 90 (`src/config/retention.config.ts:44-47`); `PushSubscriptionRetentionService.purgeStaleSubscriptions` (`src/push/push-subscription-retention.service.ts:53-71`) | Daily at 02:00 (`push-subscription-retention.service.ts:53`) |
| **Dead push endpoints** | `push_subscriptions` | Deleted **inline at send time** on a 404 or 410 from the push service (`src/push/push-subscription-retention.service.ts:12-15`) | `PushService.sendToUser` | On send |

**Why there is no email-preference row in this table.** There was an
`email_preference` table storing per-category email-notification toggles. Nothing
ever read it, because QueerPulse delivers no email and never will, and it was
never in the Article 20 export either, so it held personal data with no purpose
and no reader. It was removed on 2026-08-26 together with its
`GET|PATCH /account/email-preferences` routes; the table is dropped by
`src/migrations/1795740000000-DropEmailPreference.ts`. Recorded here so the
absence reads as a decision rather than an omission. Do not reintroduce an email
category anywhere: there is no channel behind it.

### 1.5 Gatherings

| Data | Entity / table | Period | Enforced by | Cadence |
|---|---|---|---|---|
| **Gathering attendance detail**: the host's check-in record (`checked_in_at`) plus the free-text `access_needs` and `dietary_needs` a member supplied | `event_rsvps` / `EventRsvp` | **30 days after the gathering ends.** The clock is `COALESCE(events.end_at, events.start_at)`, so it runs from the gathering rather than from when the RSVP was placed, and a multi-day gathering is measured from its last day. `retention.eventAttendanceDays`, default 30 (`src/config/retention.config.ts:49-60`) | `EventAttendanceRetentionService.clearPastEventAttendance` (`src/events/event-attendance-retention.service.ts:125-176`) | Daily at 05:00 (`event-attendance-retention.service.ts:125`) |
| **The RSVP row itself** | `event_rsvps` | **Kept**, cleared rather than deleted | Same sweep. The row survives for three reasons: **three of the four** roster numbers (`goingCount`, `seatsTaken`, `waitlistCount`) are aggregated from these rows at read time by `EventsService.rosterCounts` and stored nowhere else; `removed_by_host_at` is a safety record that outlives the gathering; and "which gatherings did I go to" is the member's own data and is in their Article 20 export. Same shape as `expireOldDataExportArchives`: keep the row, null the payload. | n/a |
| **The fourth roster number, `checkedInCount`** | derived, not stored | **Stops being reported** on the same clock | `EventsService.rosterCounts` returns `null` past the window (`src/events/events.service.ts:1586-1597`). See the correction note below. | On every read |
| **Recording a NEW arrival** | `event_rsvps.checked_in_at` | **Refused** on the same clock | `EventCheckInService.checkIn` throws a 403 carrying `code: EVENT_ATTENDANCE_WINDOW_CLOSED` once the gathering is past the window (`src/events/event-check-in.service.ts:180-213`, called at `:105`), so a door screen opened on an old gathering cannot write back the data the sweep just erased. Undoing an arrival stays allowed forever, because it removes data rather than creating it. | On every check-in |

Edge cases the sweep handles, each documented at
`src/events/event-attendance-retention.service.ts:63-100`: a gathering with no
end time is measured from `start_at`; a gathering with no date at all is
impossible (`events.start_at` is `NOT NULL`); a rescheduled gathering is
re-measured from its current date on every tick, so one moved into the future
stops being eligible; a **cancelled** gathering is swept on the same clock and
deliberately not excluded; a deleted gathering leaves nothing behind, because
`FK_event_rsvps_event_id` is `ON DELETE CASCADE`.

The sweep is backed by a partial index on the rows that still have something to
clear (`IDX_event_rsvps_attendance_retention`,
`src/migrations/1795730000000-AddEventRsvpsAttendanceRetentionIndex.ts`), which
shrinks as the sweep runs.

**A correction, because an earlier version of this document got it wrong.** This
table used to say the row is kept because "every attendee count on a past
gathering is aggregated from these rows at read time". That is true of three of
the four numbers `rosterCounts` returns and **false of the fourth**.
`checkedInCount` is `COUNT(*) FILTER (WHERE r.status = 'going' AND
r.checked_in_at IS NOT NULL)`, so once the sweep nulls `checked_in_at` it counts
the cleared rows as zero arrivals: an organiser opening a gathering 31 days
later would have read "0 arrived of 40 going", indistinguishable from nobody
turning up, presented as a fact.

The fix is that a check-in count stops being knowable once the check-in records
are gone, and the API now says so. `rosterCounts` returns `checkedInCount: null`
past the window, meaning **no longer recorded**, and `0` keeps its literal
meaning of nobody arrived. Both halves read the window through one shared module
(`src/events/event-attendance-window.ts`) off the same
`retention.eventAttendanceDays` key, so the window that erases the records and
the window that stops reporting them cannot drift apart. The date decides rather
than the state of the rows, so the answer never flickers with cron timing and can
never be a half-swept mixture.

**A denormalised count was considered and rejected.** Storing an aggregate on the
event row before clearing would preserve more for the organiser, and it would
also defeat the sweep: the RSVP roster survives with each member's `user_id` and
`status`, so a stored total equal to `goingCount` says every named person on that
roster attended, and a stored `0` says none of them did. In a community where
"attended this gathering on this date" is the linkage that outs somebody, an
aggregate that reconstructs the per-person record in the common small-gathering
cases is not an acceptable trade for a nicer dashboard.

**The limit, stated plainly:** a cleared row still records that this member said
they were going. The published sentence covers the check-in record and the
details a member supplied. See §2.1 D1 for the wording that makes that precise.

### 1.6 Membership cards

| Data | Entity / table | Period | Enforced by | Cadence |
|---|---|---|---|---|
| **Card verification scans** | `membership_card_scans` / `MembershipCardScan` | **90 days**, hard-coded and deliberately **not** configurable: "a deployment that could quietly widen the window to years would turn an operational record into the behavioural history the design forbids, so the ceiling is in the code" (`src/membership-cards/card-scan-retention.service.ts:11-19`) | `CardScanRetentionService.purgeOldCardScans` (`src/membership-cards/card-scan-retention.service.ts:40-56`) | Daily at 03:00 (`card-scan-retention.service.ts:40`) |
| **Card expiry warning** | `membership_cards` | Sent **30 days** before expiry | `src/membership-cards/card-expiry-warning.service.ts:82` | Daily at 03:00 |

### 1.7 Object storage

| Data | Store | Period | Enforced by | Cadence |
|---|---|---|---|---|
| **Orphaned objects** (presigned but never persisted, or replaced media) | The bucket | **Off by default.** Requires `STORAGE_ORPHAN_SWEEP_ENABLED=true`, and even then only logs candidates unless `STORAGE_ORPHAN_SWEEP_DRY_RUN=false` (`src/storage/storage-maintenance.service.ts:42-45, 63-71`). Grace window default **48 hours** (`:73-79`); at most 1000 deletions per run (`:81-86`) | `StorageMaintenanceService.sweepOrphanedObjects` (`src/storage/storage-maintenance.service.ts:88-100`) | `STORAGE_ORPHAN_SWEEP_CRON`, default daily at 04:00 (`storage-maintenance.service.ts:20-21`) |
| **Referenced objects** | The bucket | **none.** Objects referenced by any image column, or by a message attachment, are never swept (`src/storage/storage-maintenance.service.ts:36-41`); a degraded reference resolver skips the whole batch rather than risk a wrong delete (`:38-41`) | n/a | n/a |
| **Bucket lifecycle rules** | The bucket | **none.** "Railway Buckets have no lifecycle rules, so the sweep lives here" (`src/storage/storage-maintenance.service.ts:28-30`) | n/a | n/a |

### 1.8 Visibility sweepers (these expire content, they do not delete it)

| Data | Entity / table | Behaviour | Enforced by | Cadence |
|---|---|---|---|---|
| **Housing listings** | `housing_listings` | Default lifetime **60 days** (`src/housing-listings/housing-listings.service.ts:175`); past `expires_at` the listing is marked `filled_at` and drops out of public browse. **Never a hard delete** (`src/housing-listings/entities/housing-listing.entity.ts:268-277`) | `HousingListingExpirySweeperService.sweepExpiredListings` (`src/housing-listings/housing-listing-expiry-sweeper.service.ts:46-70`) | Daily at midnight |
| **Invites** | `invites` | TTL **7 days** (`INVITE_TTL_MS`, `src/membership/invites.service.ts:39`); pending invites past `expires_at` flip to `expired` | `InviteExpirySweeperService.sweepExpiredInvites` (`src/membership/invite-expiry-sweeper.service.ts:42-70`) | Hourly |
| **Governance motions** | `governance_motions` | Swept on schedule | `src/governance/governance-motion-sweeper.service.ts:44` | Daily at midnight |
| **Safe-space reviews** | `safe_space_nominations` | Swept on schedule | `src/safe-space-nominations/safe-space-review-sweeper.service.ts:48` | Daily at 09:00 |
| **Community owner inactivity** | `communities` | Swept on schedule | `src/communities/community-owner-inactivity.service.ts:117` | Daily at midnight |

### 1.9 Data with no retention period at all

Everything in this table persists until the member's account is erased, or
forever if the row does not hang off the member.

| Data | Entity / table | Why it matters |
|---|---|---|
| **Direct messages** | `messages` / `Message` | Plain `text` bodies (`src/messaging/entities/message.entity.ts:104-105`). No sweeper exists. Removed only by the account-erasure cascade. This is residual risk R1 in `docs/ops/dpia-housing-verification-messaging.md` §6. |
| **Reports** | `reports` / `Report` | Includes a verbatim `message-snapshot` of any reported message (`src/reports/reports.service.ts:413-422`). Survives the reporter's erasure with a NULL `reporter_id`. |
| **Moderator audit log** | `mod_audit_logs` / `ModAuditLog` | Immutable by design; survives the moderator's erasure with a NULL `actor_id` (`src/moderation/entities/mod-audit-log.entity.ts:43-50`). |
| **Ban ratifications, appeals, content moderation** | `ban_ratifications`, `appeals`, `content_moderation` | No sweeper. |
| **Ban-evasion signals** | `removed_account_signals` / `RemovedAccountSignal` | Deliberately survives account erasure, because the whole point is that the account is gone. Holds only HMAC-SHA256 hashes under a server-side pepper never stored in the database, and no IP address or device fingerprint (`src/ban-evasion/entities/removed-account-signal.entity.ts:20-45`). |
| **Consent log** | `consent_record` / `ConsentRecord` | Append-only on purpose, so the exact policy version consented to at each moment is auditable (`src/consent/entities/consent-record.entity.ts:21-25`). No sweeper. |
| **Policy acceptances** | `policy_acceptance` / `PolicyAcceptance` | Append-only, "history is the product" (`src/consent/entities/policy-acceptance.entity.ts:26-27`). No sweeper. |
| **DSAR requests** | `dsar_request` / `DsarRequest` | No sweeper. Retained as evidence that a statutory request was answered; `resolved_by_user_id` is `ON DELETE SET NULL` so the record outlives the reviewer (`src/account/entities/dsar-request.entity.ts:71-75`). |
| **Event RSVPs, minus their attendance detail** | `event_rsvps` / `EventRsvp` | The row persists so past headcounts survive; its attendance detail is cleared on the 30-day sweep in §1.5. |
| **Status incidents** | `status_incidents` / `StatusIncident` | No sweeper. The public page bounds by recency at read time, the rows stay. |
| **Newsletter subscribers** | `src/newsletter` | No sweeper, and nothing can ever be sent to them (`docs/ops/no-mailer-at-launch.md`). |
| **Marketing inquiries** | `inquiries` / `Inquiry` | Written by anonymous visitors with a name and email typed into a public form (`src/inquiries/entities/inquiry.entity.ts:19-25`). No sweeper, and no member account to erase them with. |
| **Verification records** | `member_verifications`, `verification_requests` | No sweeper. Holds a level, a method, an opaque provider reference, and the member's own free text; never a document (`src/verification/entities/member-verification.entity.ts:21-28`). |
| **Magazine contributor fees** | `magazine_payment` | No sweeper. **UNVERIFIED, needs a human answer:** what statutory accounting retention applies. |
| **Backups** | Off-provider `pg_dump` archives | Retention here is a bucket lifecycle rule rather than anything in this repository. `docs/ops/backup-restore.md` §2 recommends 14 daily, 8 weekly, 6 monthly, and warns that a bucket backup "also re-materialises objects a user asked to be erased" (§5). **UNVERIFIED, needs a human answer:** whether those lifecycle rules are actually configured. |

---

## 2. Discrepancies with the published privacy policy

This section is the **work order for the frontend agent**. Every item names the
exact i18n key, quotes the current published English text, and gives the correct
value. Portuguese line numbers are given alongside so both catalogs move in
lockstep.

The published policy content is assembled in
`queerpulse/src/features/marketing/privacy.data.tsx` and rendered by
`queerpulse/src/features/marketing/PrivacyPage.tsx`. The current privacy policy
version is `3.4` (`src/consent/policy-versions.ts:72`), and the backend is
authoritative for it.

### 2.1 Retention claims that are wrong

**D1. RESOLVED IN CODE. Gathering attendance now clears, and the sentence should
be made precise rather than deleted.**

- Key: `privacy.retention.p3`
  (EN `queerpulse/src/shared/i18n/catalogs/en/marketing.ts:1121-1122`,
  PT `queerpulse/src/shared/i18n/catalogs/pt/marketing.ts:1154-1155`)
- Currently published: *"Some things clear on their own, gathering attendance 30
  days after the event, read notifications after 90 days, and unused
  push-notification registrations after 90 days."*
- **Was:** no sweeper touched `event_rsvps`, so the promise was a sentence with
  no code behind it.
- **Now:** `EventAttendanceRetentionService` clears the check-in record and the
  free-text access and dietary needs 30 days after the gathering ends
  (`src/events/event-attendance-retention.service.ts:125-176`, daily at 05:00),
  with the period alongside the others in `retention.config`
  (`src/config/retention.config.ts:49-60`). The three claims in the sentence are
  now all true.
- **The one refinement still needed.** The RSVP row survives, so a member's
  record that they said they were going remains (see §1.5 for why deleting it
  would zero every past gathering's headcount and drop a safety record). The
  sentence should name what clears rather than implying the whole RSVP goes.
  Suggested replacement: *"Some things clear on their own: what you told a host
  about access or dietary needs and the record that you checked in, 30 days
  after the gathering; read notifications after 90 days (unread ones are kept
  until you see them); unused push-notification registrations after 90 days;
  card verification records after 90 days; and a data export you requested after
  30 days."*
- Do not delete the gathering clause. It is now the one part of the sentence
  with a sweeper, a config key and a test behind it.

**D2. Erasure timing is described loosely, and cites a category that does not
exist.**

- Key: `privacy.retention.p2`
  (EN `:1119-1120`, PT `:1152-1153`)
- Currently published: *"If you delete your account, most personal data is
  removed within 30 days, except where we're legally required to retain it (e.g.
  billing records)."*
- The code: erasure runs **at** 30 days rather than somewhere inside them. The
  request opens a
  30-day grace window (`DELETION_GRACE_DAYS = 30`,
  `src/account/account.constants.ts:7`), the member can cancel throughout it, and
  the hard erase happens on the first daily tick after the window closes
  (`src/account/account-deletion-processor.service.ts:54, 150-192`). "Most"
  understates it: the cascade removes 70+ tables of member-owned rows
  (`account-deletion-processor.service.ts:310-334`).
- "billing records" has no referent. There is no member billing or payment
  history anywhere in the backend. The only `payment` entity is
  `magazine_payment`, an internal editorial ledger of commissioned writer fees
  (`src/magazine/entities/magazine-payment.entity.ts:17-33`).
- **Correct text:** *"Deleting your account opens a 30-day grace period, and you
  can cancel any time inside it by signing back in. We warn you 3 days before the
  deadline. After that your account and the data attached to it are permanently
  erased, including your uploaded files. Three things are deliberately kept:
  moderation records with your name removed from them, a one-way fingerprint of
  your email address, and content other members depend on (a gathering you were
  hosting, a listing you posted) which stays with your name removed."*

**D3. The policy is silent on periods the code does enforce.**

Nothing in `privacy.retention.*` mentions any of these, and each is a member-facing fact:

| Missing from the policy | The enforced period | Authority |
|---|---|---|
| Data-export archive contents | 30 days | `src/config/retention.config.ts:26-29` |
| Export download link | 7 days, now enforced (D4) | `src/account/account.constants.ts:19` |
| Card verification records | 90 days | `src/membership-cards/card-scan-retention.service.ts:19` |
| Sessions after sign-out or expiry | 30 days at the default `JWT_REFRESH_TTL` | `src/auth/auth-maintenance.service.ts:28-30` |
| Housing listings | hidden from browse after 60 days, never deleted | `src/housing-listings/housing-listings.service.ts:175` |
| Invites | 7 days | `src/membership/invites.service.ts:39` |
| Direct messages, reports, moderation records, consent logs | kept for the life of the account, with moderation records kept beyond it in pseudonymised form | §1.9 |

**Correct action:** add a short list. The last row matters most: a member reading
"most personal data is removed within 30 days" reasonably concludes their
messages and moderation history go too, and the moderation history does not.

**D4. RESOLVED IN CODE. The advertised 7-day export download expiry is now
enforced.**

- Not a policy string. It reaches members through the API's `expiresAt` field
  and the settings UI that renders it
  (`queerpulse/src/features/settings/DataExportSections.tsx:186-215`).
- **Was:** the download endpoint checked only `status === Ready` and a non-null
  payload, so a link the member was told lasts 7 days kept serving until the
  30-day archive sweeper nulled the payload.
- **Now:** the instant is computed in one place, `exportLinkExpiresAt`
  (`src/account/account-response.ts:64-69`), advertised by `toExportJobResponse`
  (`:71-73`) and enforced by `AccountService.getExportDownload`, which refuses a
  request past it (`src/account/account.service.ts:517-522`).
- **The two windows are complementary and must stay that way**: 7 days of link
  access (`EXPORT_LINK_EXPIRY_DAYS`, `src/account/account.constants.ts:19`), 30
  days until the bytes are destroyed (`retention.dataExportArchiveDays`). The
  gap is deliberate slack for a cron that batches and can miss a tick.
- **Nothing for the frontend to publish here.** "7 days" is now true, so the
  existing `settings:dataExport.status.ready.bodyWithExpiry` copy is accurate.

### 2.2 Email claims that describe a service that does not exist

**D5. The policy names an email-delivery sub-processor.**

- Key: `privacy.thirdParties.item3`
  (EN `:1157-1158`, PT `:1190-1191`)
- Currently published: *"**Email delivery**: for account emails and the
  notifications you've turned on."*
- The code: there is no mailer, no provider, and no sender
  (`src/account/account.constants.ts:29-35`, `src/migrations/1795740000000-DropEmailPreference.ts`,
  `docs/ops/no-mailer-at-launch.md`).
- **Correct action:** **delete the bullet.** Replace the list with the verified
  sub-processors in `docs/ops/sub-processors-and-processing.md` §1 (see the
  publishable form in the handover file).

**D6. Service providers are said to "deliver our email".**

- Key: `privacy.whoSees.p3` (EN `:1112-1114`, PT `:1145-1146`)
- Currently published: *"**Service providers**, the companies that host the
  platform, store your uploads, deliver our email, and (with your consent)
  monitor for errors, see only what's needed for their specific job, under
  contract."*
- **Correct text:** *"**Service providers**, the companies that host the
  platform, store your uploads, place addresses on a map and (with your consent)
  monitor for errors, see only what's needed for their specific job."*
- Note the second correction inside the same string: **"under contract" is
  currently unverifiable.** No Data Processing Agreement is recorded anywhere in
  either repository (`docs/ops/sub-processors-and-processing.md` §1). Either
  confirm the DPAs and keep the phrase, or drop it. Do not publish a contractual
  claim nobody has checked.

**D7. The email address is said to be used for sending notifications.**

- Key: `privacy.whatWeCollect.account.item2` (EN `:1058-1059`, PT `:1091-1092`)
- Currently published: *"**Contact information**: your email address, used to
  sign you in and send the notifications you've turned on."*
- The code: the address is the Google OAuth identity
  (`src/users/entities/user.entity.ts:65-69`) and is never used to send anything.
- **Correct text:** *"**Contact information**: your email address, which comes
  from your Google account and is used to sign you in. QueerPulse does not send
  email."*

**D8. The third-parties intro claims every provider is contractually bound.**

- Key: `privacy.thirdParties.intro` (EN `:1151-1152`)
- Currently published: *"We work with a small number of service providers, each
  bound by contract to use your data only for the service they provide:"*
- Same problem as D6: **UNVERIFIED.** Adjust or verify.

**D9. The third-parties list omits verified sub-processors.**

Missing from `privacy.thirdParties.*` and confirmed present in the code:

- **Web push services** (Google, Mozilla, Apple or Microsoft, depending on the
  member's browser), which receive the encrypted payload and the subscription
  endpoint (`src/push/push.service.ts:11`,
  `src/push/entities/push-subscription.entity.ts:20-21`).
- **Embedded virtual tours.** A housing listing may carry a YouTube or Matterport
  link (`src/housing-listings/entities/housing-listing.entity.ts:262-266`), which
  the CSP admits (`queerpulse/vercel.json:14`). Opening such a listing hands the
  viewer's IP address to that host.
- The hosting and storage bullet (`privacy.thirdParties.item2`, EN `:1155-1156`) is honest but
  vague. `docs/ops/sub-processors-and-processing.md` §1.1 names Railway, Tigris
  and Vercel; naming them is better practice and costs nothing.

### 2.3 Rights claims that outrun the intake

**D10. The privacy page lists six rights; the request form supports four.**

- Keys: `privacy.yourRights.item1` through `item6`
  (EN `:1127-1138`), listing access, rectification, erasure, objection,
  portability, restriction.
- The DSAR form and the backend accept **Articles 15, 16, 17 and 21 only**
  (`src/account/dto/submit-dsar.dto.ts:11-15`,
  `src/account/entities/dsar-request.entity.ts:3-6`,
  `queerpulse/src/features/marketing/DsarPage.tsx:37-74`).
- Article 20 portability is genuinely served, by the self-service export
  (`POST /account/export`, `src/account/account.controller.ts:144-149`). Article
  18 restriction has **no intake path at all**.
- **Correct action:** keep all six rights listed, because they exist in law
  whatever the form supports, and add one sentence saying how to exercise the two
  the form does not cover. Suggested: *"Portability is built in: you can download
  a full copy of your data from Settings at any time. For restriction, use the
  data request form and describe what you want restricted."* The runbook handles
  a restriction request filed as free text
  (`docs/ops/dsar-runbook.md` §3).

**D11. The DSAR access form promises to send the copy.**

- Key: `dsar.rights.access.formSub`
  (EN `queerpulse/src/shared/i18n/catalogs/en/marketing.ts:630-631`,
  PT `:646-647`)
- Currently published: *"We'll compile everything tied to your account and send
  it to you."*
- There is no channel to send it on. The archive downloads from the page
  (`src/account/account.controller.ts:187-200`), and a DSAR outcome arrives as an
  in-app notification (`src/admin-dsar/admin-dsar.service.ts:180-200`).
- **Correct text:** *"We'll compile everything tied to your account and make it
  available to download here."*

**D12. The DSAR scope selector offers a Billing category that has no data behind
it.**

- Keys: `dsar.scopes.billing.b` / `dsar.scopes.billing.s`
  (EN `:666-667`, PT `:682-683`), currently *"Billing"* and *"Membership tier,
  payment history"*.
- There is no member payment history anywhere in the backend (see D2). Membership
  tier does exist (`src/membership`).
- **Correct action:** either remove the Billing scope, or relabel it *"Membership"*
  with the sub-line *"Your tier, join date, and who invited you"*, which is what
  the data actually is.

### 2.4 Claims that are correct and should be left alone

Confirmed accurate against the code. Listing them so nobody "fixes" them:

- *"we don't run product analytics or behavioural tracking"*
  (`privacy.whatWeCollect.notCollectedBody`, EN `:1082-1083`). Verified: no
  analytics SDK in either repository, and the CSP pins `script-src 'self'`
  (`queerpulse/vercel.json:14`).
- *"Your IP address, used only in the moment ... It isn't stored against your
  account"* (`privacy.whatWeCollect.device.item3`, EN `:1070-1071`). Verified:
  no IP column on `refresh_tokens`; the throttler holds counters in process
  memory (`src/app.module.ts:207-215`); request logs carry only method, URL and
  status (`src/app.module.ts:174-186`).
- *"Typing and who's online aren't stored. They're live-only."*
  (`privacy.whatWeCollect.activity.item2`, EN `:1075-1076`). Verified: presence
  is an in-memory map (`src/app.module.ts:207-215`).
- *"Photos are cleaned before they're uploaded"*
  (`privacy.sensitive.p4`, EN `:1091-1092`). Verified:
  `queerpulse/src/features/members/api/uploads.api.ts:54-60`.
- *"a **one-way fingerprint** of the email"* (`privacy.retention.p4`,
  EN `:1123-1124`). Verified:
  `src/account/account-deletion-processor.service.ts:276-288`.
- *"We'll post material changes as an in-app notice before they take effect."*
  (`privacy.changes.p1`, EN `:1170-1171`). Correct, and correctly channel-neutral.
- *"map tiles from OpenFreeMap and address lookups via OpenStreetMap"*
  (`privacy.thirdParties.item4`, EN `:1159-1160`). Verified:
  `queerpulse/src/shared/components/map/siteMapStyle.ts:11-13`,
  `src/geocode/geocode.service.ts:43-48`. One refinement: address lookups are
  made server-side, so OpenStreetMap sees the server's IP address rather than the
  member's. Worth saying, since it is better than the policy currently claims.
- *"**Klipy**: ... your search term reaches Klipy; your messages never do."*
  (`privacy.thirdParties.item5`, EN `:1161-1162`). Verified:
  `queerpulse/src/shared/api/gifs.ts:42-46`.
- *"you can also lodge a complaint with the ... CNPD"*
  (`privacy.yourRights.p2`, EN `:1141-1142`). Correct.
- *"It's free and we respond within 30 days."* (`privacy.yourRights.p1`,
  EN `:1139-1140`, PT `:1172-1173`). Matches `DSAR_DUE_DAYS = 30`
  (`src/account/account.constants.ts:15`). Note that GDPR's period is one month
  rather than 30 days, so 30 days is the stricter promise and is safe to keep.

---

## 3. Keeping this document true

Add a row to §1 in the same change that adds a `@Cron`, a retention constant, or
an entity that accretes rows. The complete current inventory of scheduled jobs is
17 `@Cron` declarations across `src`; a new one that removes or expires personal
data belongs here.

Related: `docs/ops/sub-processors-and-processing.md`,
`docs/ops/dsar-runbook.md`, `docs/ops/dpia-housing-verification-messaging.md`,
`docs/ops/backup-restore.md`.
