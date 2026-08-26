# Sub-processors and Record of Processing Activities

**Status:** LG-02. First written source of truth for who processes QueerPulse
personal data and why. Every row below is derived from code that exists in
`queerpulse-backend` or `queerpulse`, with the file and line that proves it. A
row marked **UNVERIFIED** is a question for a human, never a guess.

**Scope:** the production NestJS API (Railway), the production SPA (Vercel), the
object-storage bucket, and every outbound third-party call either side makes.

**Controller:** the published policy states that QueerPulse "is run by a group of
volunteers who build and look after queerpulse.com. There's no company or
registered organisation behind it yet"
(`queerpulse/src/shared/i18n/catalogs/en/marketing.ts:1050-1051`). No legal
entity name, company registration or registered address is asserted anywhere in
either repository.

- `[OWNER: controller legal identity, or the named natural persons acting as
  joint controllers, to be filled in]`
- `[OWNER: data protection contact, name and reachable address, to be filled in]`
  (the privacy page currently points at `hello@queerpulse.com`,
  `queerpulse/src/features/marketing/privacy.data.tsx:364`)
- **UNVERIFIED, needs a human answer:** whether an Article 27 representative or a
  DPO is required or appointed.

---

## 0. The standing fact: there is no email processor

QueerPulse delivers no email and never will. There is no mail transport in the
backend, no provider dependency, and no sender.
`docs/ops/no-mailer-at-launch.md` is the decision record.

Consequences that run through every document in this set:

- **No email sub-processor exists.** Nothing in §1 is a mail provider.
- **No email-preference data is stored either.** The `email_preference` matrix
  and its `GET|PATCH /account/email-preferences` routes were removed on
  2026-08-26. They stored per-category toggles that no sender ever read, for a
  channel that does not exist, which left personal data with no purpose, no
  reader and no retention rule. The table is dropped by
  `src/migrations/1795740000000-DropEmailPreference.ts` (that migration carries
  the full reasoning). The preferences that genuinely gate delivery are in-app
  and push, in `src/notifications/notification-preferences.ts`.
- Every notification path a procedure can rely on is one of: in-app notification
  (`src/notifications`), Web Push to an existing subscription (`src/push`), the
  public status page (`src/status`, `GET /status`), or the sitewide announcement
  banner (`src/platform-settings/platform-status.controller.ts:80-124`, public,
  so it reaches signed-out visitors too).
- The currently published privacy policy still names an "Email delivery"
  provider. That is a correction the frontend has to make. See
  `docs/ops/retention-periods.md` §2 for the full work order.

---

## 1. Sub-processor register

"Processes where" is the deployment region. In several rows the region is a
dashboard setting this repository cannot observe, so it is marked UNVERIFIED
rather than assumed.

**No Data Processing Agreement is recorded anywhere in either repository.** Every
DPA cell below is therefore UNVERIFIED. Confirming or signing them is
`[OWNER: DPA owner to be filled in]`.

### 1.1 Infrastructure

| Sub-processor | What it is used for | Personal data reaching it | Processes where | DPA |
|---|---|---|---|---|
| **Railway** (app hosting, managed PostgreSQL, Buckets) | Runs the API container and hosts the primary database. `railway.json:1-14` builds from `Dockerfile` and runs `migration:preflight && migration:run:prod && storage:cors` before each deploy; the healthcheck is `/health/live`. `docs/ops/backup-restore.md` names it as the Postgres and bucket host. | Everything in the database: identity, profiles, direct messages, housing intros, consent logs, moderation records. | UNVERIFIED, needs a human answer (Railway region is a dashboard setting) | UNVERIFIED |
| **Tigris** (object storage behind Railway Buckets) | The S3-compatible store every upload lands in. `src/config/storage.config.ts:3-9` records that a Railway Bucket "is backed by Tigris under the hood (endpoint `*.t3.storageapi.dev`, keys prefixed `tid_`/`tsec_`)". Credentials are `AWS_ENDPOINT_URL` / `AWS_DEFAULT_REGION` / `AWS_S3_BUCKET_NAME` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (`src/config/env.validation.ts:134-138`), all mandatory in production (`src/config/env.validation.ts:292-309`). | Member-uploaded images: avatars, work images, gathering and listing photos, community covers, direct-message image attachments (`src/storage/upload-kinds.ts:41-162`). Object keys are `<kind>/<userId>/…`, so the key itself links a file to a member (`src/account/account-deletion-processor.service.ts:353-354`). | UNVERIFIED, needs a human answer | UNVERIFIED |
| **Vercel** (SPA hosting and CDN) | Serves the React app. `queerpulse/vercel.json:3-29` sets the SPA rewrite plus HSTS, CSP, `X-Frame-Options: DENY` and `Permissions-Policy: camera=(), microphone=(), geolocation=()`. | Request metadata for every page load: IP address, user agent, requested path. No application data passes through it (the SPA calls the API directly). | UNVERIFIED, needs a human answer | UNVERIFIED |

### 1.2 Identity

| Sub-processor | What it is used for | Personal data reaching it | Processes where | DPA |
|---|---|---|---|---|
| **Google** (Sign in with Google, OAuth 2.0) | The only sign-in method. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_CALLBACK_URL` are mandatory, non-optional environment variables (`src/config/env.validation.ts:58-65`), surfaced as `auth.google*` in `src/config/auth.config.ts:32-34`. `users.google_id` and `users.email` are both `select: false` columns (`src/users/entities/user.entity.ts:65-69`). | Google is the identity provider, so the authentication event itself, plus whatever Google already holds. Google returns name, email address and profile photo. | Google global infrastructure | UNVERIFIED |
| **Identity-document verification vendor** | **None bound.** `VerificationModule` binds `StubIdentityVerificationProvider`, a development stub (`src/verification/verification.module.ts:49-77`), and the factory throws at boot if `VERIFICATION_AUTOMATED_ELEVATION=true` while the stub is the bound provider (`src/verification/verification.module.ts:69-72`). | None. No identity document or biometric is processed today. See `docs/ops/dpia-housing-verification-messaging.md` §3 for what must be reassessed before a real vendor is bound. | n/a | n/a |

### 1.3 Product features

| Sub-processor | What it is used for | Personal data reaching it | Processes where | DPA |
|---|---|---|---|---|
| **KLIPY** (GIF search) | Powers the GIF picker in messages. `queerpulse/src/shared/api/gifs.ts:1-4` records the switch from Tenor; the client calls `https://api.klipy.com/api/v1` (`gifs.ts:42`) with a fixed `g` safe rating (`gifs.ts:44-46`). Live search is off unless `VITE_KLIPY_KEY` is set (`gifs.ts:34-40`). | The member's browser makes the call, so KLIPY receives the search term, the member's IP address and user agent. It never receives message content. | UNVERIFIED, needs a human answer | UNVERIFIED |
| **OpenStreetMap Nominatim** (forward geocoding) | The housing wizard's "Locate this address" button. `src/geocode/geocode.service.ts:43-48` names `https://nominatim.openstreetmap.org/search` as "a keyless public forward-geocoder". The call is made **server side** with a `QueerPulseBot/1.0` user agent and no cookies (`src/geocode/geocode.service.ts:121-124`), rate-limited process-wide to 1 request per second (`src/geocode/nominatim-rate-limiter.ts:3-30`). | The address text a member typed. The server's IP address, never the member's. | Nominatim is operated by the OpenStreetMap Foundation | UNVERIFIED |
| **Google Maps** (link resolution) | `GeocodeService.resolveLink` (`src/geocode/geocode.service.ts:187-195`) follows a member-supplied Google Maps link, host-allowlisted to `maps.app.goo.gl`, `goo.gl`, `google.com`, `maps.google.com` and `google.<tld>` (`src/geocode/google-maps-link.ts:4-13`), re-checking the host on every redirect hop (`geocode.service.ts:227,277`). | The URL the member pasted. Server-side, so the server's IP address. | Google global infrastructure | UNVERIFIED |
| **OpenFreeMap** (vector map tiles and glyphs) | The map surfaces. `queerpulse/src/shared/components/map/siteMapStyle.ts:11-13` sets `MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron"` and notes it is a "public vector style, no API key, no signup"; label glyphs are served from the same host (`siteMapStyle.ts:51-54`). | The member's browser fetches tiles, so OpenFreeMap receives the member's IP address, user agent and the tile coordinates, which reveal the map area being viewed. | UNVERIFIED, needs a human answer | UNVERIFIED |
| **Browser push services** (Google FCM, Mozilla autopush, Apple, Microsoft, depending on the member's browser) | Web Push delivery. `src/push/push.service.ts:11` uses the `web-push` library against the endpoint the browser issued (`src/push/entities/push-subscription.entity.ts:20-21`). VAPID keys are all-or-nothing in production (`src/config/env.validation.ts:146-148, 334-349`). Outbound sends are pinned through the shared SSRF guard (`src/push/push.service.ts:12-16`). | The encrypted push payload plus the subscription endpoint. Push previews are split per recipient so a member with previews off never has a name put in the payload (`src/push/push-preview-privacy.service.ts:8-45`), and the default when no preference row exists is hidden (`push-preview-privacy.service.ts:42-45`). | The push vendor's global infrastructure | UNVERIFIED |
| **Mux** (video) | **Pending. Nothing is live.** `src/launchedFeatures.ts:54-60` ships `cinema` with `launched: false` and declares `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_WEBHOOK_SECRET` as the environment it would require. `src/config/mux.config.ts:3-10` holds the config factory. `LaunchedFeaturesGuard` 404s every route the feature owns while the flag is false (`src/launchedFeatures.ts:8-14`). | None today. Record as a pending sub-processor: launching `cinema` makes Mux a processor of member-uploaded video and therefore of anyone appearing in it. | n/a today | n/a today |

### 1.4 Monitoring

| Sub-processor | What it is used for | Personal data reaching it | Processes where | DPA |
|---|---|---|---|---|
| **Sentry** (backend error monitoring) | `src/instrument.ts:22-31`. No-op unless `SENTRY_DSN` is set; initialised before express and pg are imported so request context is attached; `tracesSampleRate: 0`, so errors only, no performance traces. `sendDefaultPii` is not set. Buffered events are flushed on SIGTERM/SIGINT (`src/main.ts:157-163`). | Stack traces and request context for failing requests. Request logs themselves carry only method, URL and status code, with cookies and authorization headers redacted (`src/app.module.ts:157-186`). | UNVERIFIED, needs a human answer (Sentry region is set on the DSN) | UNVERIFIED |
| **Sentry** (frontend error monitoring, consent-gated) | `queerpulse/src/shared/observability/sentry.ts:105-129`. The SDK is only fetched in a production build with a DSN, `sendDefaultPii: false`, `tracesSampleRate: 0`, and `beforeSend` drops every event until the member grants `monitoring` consent (`sentry.ts:121-125`, flipped by `setMonitoringConsent`, `sentry.ts:91-97`). The attached user id is an opaque hash, never email or handle (`sentry.ts:146-150`). | Client-side stack traces, only from members who consented. | UNVERIFIED | UNVERIFIED |

### 1.5 Deliberately not sub-processors

- **Google Fonts.** Not used. Fraunces and DM Sans are self-hosted through
  Fontsource specifically so that "Google Fonts hands the visitor's IP to a third
  party on first paint. For a queer community platform that is a real
  disclosure" (`queerpulse/src/styles/fonts.css:4-29`). The CSP has no
  `fonts.googleapis.com` or `fonts.gstatic.com` entry
  (`queerpulse/vercel.json:14`).
- **Any advertising, analytics or attribution network.** None is present in
  either repository. `queerpulse/vercel.json:14` pins `script-src 'self'` and
  `default-src 'self'`, so a third-party script could not load even if one were
  added by accident.
- **Any email or SMS provider.** See §0.

### 1.6 Hosts the CSP admits that are not processors

`queerpulse/vercel.json:14` sets `frame-src https://www.youtube.com
https://*.matterport.com`. These exist because a housing listing may carry a
member-supplied virtual-tour link (`src/housing-listings/entities/housing-listing.entity.ts:262-266`
names "Matterport, a YouTube walkthrough"). When a viewer opens such a listing
their browser contacts that host directly and it receives their IP address. This
is a third-party embed the member chose to add. QueerPulse instructs no
processing there. It still belongs in the public privacy policy as a disclosure.

`img-src 'self' data: blob: https:` and `connect-src 'self' https: wss:` are both
broad. Narrowing them is a separate hardening item, recorded here because a
broad `img-src` means a member-supplied external image URL can leak a viewer's IP
to an arbitrary host.

---

## 2. Record of processing activities (GDPR Article 30)

Retention values are the ones the code enforces. The authority for every one of
them is `docs/ops/retention-periods.md`, which cites the sweeper and its cron.

Recipients are, in every row, the infrastructure processors in §1.1 (Railway,
Tigris, Vercel). Rows list only the recipients **beyond** that floor.

### 2.1 Account and identity

- **Data subjects:** members, pending members, invite applicants.
- **Personal data:** `users` (`src/users/entities/user.entity.ts`): `google_id`
  and `email`, both `select: false` (`:65-69`); `status`, `role`
  (`:71-85`); `suspended_until`, `restricted`, `restricted_until` (`:108-133`);
  `age_attested_at`, `terms_version`, `guidelines_version`,
  `affirming_pledge_accepted_at` (`:143-214`).
  `profiles` (`src/users/entities/profile.entity.ts`): name, pronouns,
  pronunciation, tagline, bio, location, avatar, visibility flags (`:31-195`).
  `refresh_tokens` (`src/auth/entities/refresh-token.entity.ts`): token hash,
  family id, coarse device label, user agent, session timestamps (`:31-98`). No
  IP address is stored on a session row.
- **Purpose:** creating and running an account, authenticating, session
  management, presenting a member to the community.
- **Legal basis:** Article 6(1)(b), performance of the contract with the member
  (the Terms of Service). Age attestation and the guidelines acceptance are
  Article 6(1)(c)/(f) as evidence of the eligibility rule.
- **Retention:** for the life of the account. Erasure runs 30 days after a
  deletion request (`src/account/account.constants.ts:7`). Refresh-token rows are
  purged one refresh lifetime past expiry or revocation
  (`src/auth/auth-maintenance.service.ts:28-30, 43-57`).
- **Recipients:** Google, as the identity provider (§1.2).

### 2.2 Messaging

- **Data subjects:** members in a conversation.
- **Personal data:** `messages` (`src/messaging/entities/message.entity.ts`):
  `body` as plain `text` (`:104-105`), sender id, conversation id, `attachment`
  jsonb for GIF and image messages (`:127-133`), `edited_at`, `deleted_at`
  (`:172-179`). `conversations`, `conversation_participants` (including the
  per-participant `muted` flag, `src/messaging/entities/conversation-participant.entity.ts:66`),
  `message_reactions`, `message_stars`, `conversation_pinned_messages`.
- **Purpose:** delivering private messages between members.
- **Legal basis:** Article 6(1)(b).
- **Special-category risk:** message content in this community routinely reveals
  sexual orientation, gender identity and health information. See
  `docs/ops/dpia-housing-verification-messaging.md` §4.
- **Retention:** **no message retention sweeper exists.** Messages persist for
  the life of the account and are removed by the account-erasure cascade
  (`src/account/account-deletion-processor.service.ts:310-334`).
- **Recipients:** KLIPY, when a member searches for a GIF (search term only, from
  the member's own browser). Browser push services, for the encrypted push
  payload.

### 2.3 Communities and forum

- **Data subjects:** members.
- **Personal data:** `communities`, `community_posts`, `community_post_replies`,
  `community_governance_log`, community membership and ban rows; `forum_threads`,
  `forum_posts`.
- **Purpose:** running member-created communities and the public forum.
- **Legal basis:** Article 6(1)(b) for participation, Article 6(1)(f) for the
  governance and ban records that keep a community usable.
- **Retention:** for the life of the account. Content whose author is erased
  survives with a NULL byline where an FK is `ON DELETE SET NULL`
  (`src/account/account-deletion-processor.service.ts:322-329`).
- **Recipients:** none beyond the infrastructure floor.

### 2.4 Gatherings and RSVPs

- **Data subjects:** members who host, co-host, RSVP, or are invited.
- **Personal data:** `events`, `event_rsvps` (including `checked_in_at`,
  `src/events/entities/event-rsvp.entity.ts:88`), `event_invites`,
  `event_cohosts`, `event_bans`, `event_photos`,
  `member_event_reminder_preferences`.
- **Purpose:** publishing gatherings, managing attendance and headcount,
  reminding attendees (`src/events/event-reminders.service.ts:50`, every five
  minutes).
- **Legal basis:** Article 6(1)(b).
- **Retention:** attendance detail (the `checked_in_at` record and the free-text
  `access_needs` / `dietary_needs` a member supplied) is cleared **30 days after
  the gathering ends** by `EventAttendanceRetentionService`
  (`src/events/event-attendance-retention.service.ts:125-176`, daily at 05:00),
  which is the period the published policy promises. The RSVP row itself is kept
  so the three headcounts a host looks back on (how many were going, how many
  seats that took, how many waited) survive, since those are aggregated from
  these rows at read time and stored nowhere else. The fourth number, how many
  physically arrived, stops being reported on the same clock: it is no longer
  knowable once the check-in records are gone, so the API returns `null` for it
  rather than a zero that would read as "nobody came". Detail and reasoning in
  `docs/ops/retention-periods.md` §1.5.
- **Recipients:** none beyond the infrastructure floor.

### 2.5 Housing and flatmate matching

- **Data subjects:** listers (members and disclosed agents), enquirers,
  flatmate-board members.
- **Personal data:**
  `housing_listings` (`src/housing-listings/entities/housing-listing.entity.ts`):
  `address_line` (`:164-165`), precise `latitude`/`longitude` (`:144-160`), rent,
  gallery, `virtual_tour_url`, plus the moderation trail `risk_score`,
  `risk_reasons`, `decision_reason` (`:208-240`).
  `housing_viewings` (`src/housing-viewings/entities/housing-viewing.entity.ts`),
  `housing_reviews`, `housing_saved_searches`, `housing_groups`.
  `flatmate_profiles` (`src/flatmate-profiles/entities/flatmate-profile.entity.ts`):
  budget, move date, area, bio, and the **Article 9 special-category block**:
  self-described gender identity (`:124-127`), affirming values (`:129-133`), and
  `identityHousehold` covering out-at-home status, bathroom comfort, chosen-name
  post, and discretion about medication (`:52-68`).
- **Purpose:** letting members find affirming housing and flatmates.
- **Legal basis:** Article 6(1)(b) for the listing and matching service.
  **Article 9(2)(a), explicit consent,** for the special-category identity
  fields: they are served to nobody unless `special_category_consent_at` is set
  (`src/flatmate-profiles/entities/flatmate-profile.entity.ts:150-152`) and the
  visibility setting admits the viewer (`:145-147`).
- **Retention:** for the life of the account. A listing past `expires_at` is
  hidden rather than deleted (`src/housing-listings/housing-listing-expiry-sweeper.service.ts:46-70`,
  daily at midnight; the default lifetime is 60 days,
  `src/housing-listings/housing-listings.service.ts:175`).
- **Recipients:** Nominatim and Google Maps for address resolution (§1.3);
  OpenFreeMap for the tiles a viewer's browser fetches; YouTube or Matterport
  when a listing carries a virtual-tour link.

### 2.6 Identity verification

- **Data subjects:** members requesting a higher verification level.
- **Personal data:** `member_verifications`
  (`src/verification/entities/member-verification.entity.ts`): level, method,
  provider, an opaque `provider_ref`, `verified_at`, `granted_by`,
  `reviewed_by_user_id` (`:36-91`).
  `verification_requests`
  (`src/verification/entities/verification-request.entity.ts`): free-text
  `context`, a reference-only `evidence_ref`, `decision_reason`, `signals` jsonb
  (`:67-84`).
- **What is deliberately not held:** the entity docstring states "this platform
  deliberately never stores the document image or any biometric"
  (`src/verification/entities/member-verification.entity.ts:21-28`), and the
  request DTO records that `context`/`evidence_ref` are "the member's own words
  plus a link to already-public corroboration, never a document upload"
  (`src/verification/dto/submit-verification-request.dto.ts:10-13`).
- **Purpose:** raising assurance on the housing and landlord surfaces.
- **Legal basis:** Article 6(1)(f), legitimate interest in reducing housing scams
  and impersonation, balanced by the fact that verification is voluntary and no
  document is stored.
- **Retention:** for the life of the account.
- **Recipients:** none. No verification vendor is bound (§1.2).

### 2.7 Moderation and reports

- **Data subjects:** reporters, reported members, moderators.
- **Personal data:** `reports` (`src/reports/entities/report.entity.ts`), whose
  `evidence` jsonb carries a server-captured `message-snapshot` when the subject
  is a message: message id, body, sender id, timestamps
  (`src/reports/reports.service.ts:413-422`). `mod_audit_logs`
  (`src/moderation/entities/mod-audit-log.entity.ts`) with actor, action,
  `reason_code`, `target_user_id` and a `target_name` snapshot (`:25-80`).
  `ban_ratifications`, `appeals`, `content_moderation`.
  `removed_account_signals` (`src/ban-evasion/entities/removed-account-signal.entity.ts`),
  which holds only HMAC-SHA256 hashes of normalised sign-in identifiers under a
  server-side pepper that is never stored in the database (`:26-45`), and records
  "no IP address, no device fingerprint, no page view" (`:20-24`).
- **Purpose:** enforcing the Community Guidelines, handling appeals, detecting
  ban evasion.
- **Legal basis:** Article 6(1)(f), legitimate interest in community safety. For
  the special-category content that appears inside a report, Article 9(2)(f)
  where a legal claim is in play, otherwise Article 9(2)(e) where the member made
  the content available themselves.
- **Retention:** **indefinite.** No sweeper touches any moderation table. On
  account erasure, `reports.reporter_id` and `mod_audit_logs.actor_id` are set to
  NULL rather than deleted, explicitly so that "erasing your account is not a way
  to delete the evidence trail against everyone you ever reported"
  (`src/account/account-deletion-processor.service.ts:290-308`).
- **Recipients:** none beyond the infrastructure floor.

### 2.8 Magazine

- **Data subjects:** writers, editors, contributors, commenters.
- **Personal data:** `magazine_articles`, `magazine_authors`, `magazine_pieces`,
  `magazine_story_submissions`, `magazine_reader_comment`, and
  `magazine_payment` (`src/magazine/entities/magazine-payment.entity.ts`), which
  records a commissioned writer's agreed fee and expenses in `numeric(12,2)`
  (`:33-50`).
- **Purpose:** running the magazine desk and paying contributors.
- **Legal basis:** Article 6(1)(b) for the commission, Article 6(1)(c) for
  whatever accounting record a fee payment attracts.
- **Retention:** for the life of the account, with the accounting caveat above.
  **UNVERIFIED, needs a human answer:** what statutory retention period applies
  to contributor fee records under Portuguese law, and whether any of this is
  handled outside the platform.
- **Recipients:** none in-platform. Actual payment happens outside QueerPulse.

### 2.9 Membership cards

- **Data subjects:** cardholders, and the members or venues who scan a card.
- **Personal data:** `membership_cards`, `community_cards`, and
  `membership_card_scans` (`src/migrations/1793650000000-AddMembershipCards.ts:96-100`):
  card id, scanning user id, result, `scanned_at`.
- **Purpose:** proving membership at a door, and detecting a shared or leaked
  card.
- **Legal basis:** Article 6(1)(f).
- **Retention:** scan records are deleted after **90 days**, a ceiling
  deliberately hard-coded rather than configurable so "a deployment that could
  quietly widen the window to years would turn an operational record into the
  behavioural history the design forbids"
  (`src/membership-cards/card-scan-retention.service.ts:11-19`), swept daily at
  03:00 (`:40-56`).
- **Recipients:** none beyond the infrastructure floor.

### 2.10 Newsletter

- **Data subjects:** subscribers, including non-members.
- **Personal data:** the `src/newsletter` module's subscriber rows.
- **Purpose:** a mailing list.
- **Legal basis:** Article 6(1)(a), consent.
- **Reality check:** **nothing can be sent.** There is no mailer (§0), so a
  subscription is stored and never acted on. `docs/ops/no-mailer-at-launch.md` §0
  records the newsletter double-opt-in copy as an open item precisely because a
  confirmation link cannot be delivered.
- **Retention:** **no sweeper.** Rows persist until deleted by hand.
- **Recipients:** none. There is no email service processor.

### 2.11 Analytics and monitoring

- **Data subjects:** members and visitors.
- **Personal data:** `consent_record`
  (`src/consent/entities/consent-record.entity.ts`), an append-only log carrying
  `analytics`, `monitoring`, `policy_version`, `source`, `action` and an optional
  pre-auth `anon_id` (`:21-64`). `policy_acceptance`
  (`src/consent/entities/policy-acceptance.entity.ts:29-65`), the append-only
  evidence of which Terms and Guidelines revision a member agreed to.
- **Product analytics:** none. There is no analytics SDK, no behavioural
  tracking, and no advertising network in either repository.
- **Error monitoring:** Sentry, gated on `monitoring` consent on the frontend
  (`queerpulse/src/shared/observability/sentry.ts:91-125`).
- **Operational metrics:** `GET /metrics` and the database-pinging health probes
  are behind a shared bearer token (`src/health/health.controller.ts:24-30,
  54-58, 90-94`; `src/metrics/metrics.controller.ts:27-31`). Nothing scrapes them
  today, which is finding LB-05 and a dependency in
  `docs/ops/incident-response.md`.
- **Legal basis:** Article 6(1)(a) for monitoring; Article 6(1)(c)/(f) for
  keeping the consent and policy-acceptance evidence itself.
- **Retention:** **no sweeper on either log.** Both are append-only by design,
  because "history is the product"
  (`src/consent/entities/policy-acceptance.entity.ts:26-27`).
- **Recipients:** Sentry.

---

## 3. Cross-border transfers

**UNVERIFIED, needs a human answer** for every processor in §1. Nothing in either
repository pins a region: `AWS_DEFAULT_REGION` carries Railway's `auto`
(`src/config/storage.config.ts:6-9`), and the remaining regions are dashboard or
DSN settings. Before this document can be published as a compliance record,
someone has to open each provider console and record the actual region, plus the
transfer mechanism (adequacy decision, standard contractual clauses, or the EU
Data Privacy Framework) for any processor outside the EEA.

Google, Sentry and the browser push vendors are the ones most likely to need a
transfer mechanism written down.

---

## 4. Keeping this document true

Add a row here in the same change that adds an outbound call, a new environment
variable naming a vendor, or a new entity holding personal data. The three places
that betray a missed sub-processor are:

1. `src/config/env.validation.ts`, where a new vendor credential has to be
   declared;
2. `queerpulse/vercel.json`'s CSP, where a new host has to be admitted;
3. `src/launchedFeatures.ts`, where a feature's `requiredEnv` names the
   credentials it needs.

Related: `docs/ops/retention-periods.md`, `docs/ops/dsar-runbook.md`,
`docs/ops/dpia-housing-verification-messaging.md`,
`docs/ops/breach-notification.md`, `docs/ops/no-mailer-at-launch.md`.
