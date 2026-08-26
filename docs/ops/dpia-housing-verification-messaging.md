# Data Protection Impact Assessment: housing, identity verification, messaging

**Status:** LG-03. A DPIA under GDPR Article 35 covering the three highest-risk
processing surfaces on QueerPulse.

**Why a DPIA is required here.** Article 35(3)(b) triggers on processing
special-category data on a large scale. QueerPulse holds sexual orientation and
gender identity for most of its membership, by design: it is a queer community
platform, so the fact of holding an account is itself a signal about the person.
On top of that baseline, three surfaces raise the stakes further: housing exposes
where a member lives, verification would expose identity documents, and private
messaging carries the most intimate content on the platform. In a community where
being outed carries real-world consequences at work, at home and with family, the
harm from a disclosure is not embarrassment. It is eviction, dismissal, loss of
family, and in some cases violence. That asymmetry is what this assessment is
built around.

**Assessment owner:** `[OWNER: name and contact to be filled in]`
**Reviewed by:** `[OWNER: reviewer, to be filled in]`
**Date of this version:** 2026-08-26
**Next scheduled review:** see §7.

---

## 1. Systematic description of the processing

### 1.1 The three surfaces in scope

| Surface | What is processed | Where the code lives |
|---|---|---|
| **Housing** | Full street addresses, precise coordinates, rent, listing photos, flatmate identity preferences, viewing arrangements | `src/housing-listings`, `src/housing-viewings`, `src/housing-reviews`, `src/housing-groups`, `src/housing-saved-searches`, `src/flatmate-profiles` |
| **Identity verification** | Today: a level, a method, an opaque provider reference, and a member's own free text. Nothing else. | `src/verification` |
| **Messaging** | Private message bodies, image and GIF attachments, reactions, read state, per-conversation preferences | `src/messaging`, `src/chat` (socket.io gateway), `src/push` |

### 1.2 Nature, scope, context and purposes

- **Nature:** collection, storage, retrieval, disclosure to selected other
  members, and (for housing addresses) resolution through an external geocoder.
- **Scope:** every member who lists or seeks housing; every member who requests a
  higher verification level; effectively every member, for messaging.
- **Context:** an invite-gated community platform for LGBTQ+ people, hosted in
  Portugal, with no legal entity behind it yet
  (`queerpulse/src/shared/i18n/catalogs/en/marketing.ts:1050-1051`).
- **Purposes:** helping members find affirming homes and flatmates; raising trust
  on the housing surfaces; letting members talk privately.

### 1.3 Data flows

**Housing.** A member creates a listing behind the mandatory LGBTQ+ affirming
pledge gate (`src/housing-listings/housing-listings.module.ts:42`) and a
verification step-up gate (`housing-listings.module.ts:40`). Every create lands
in `review` and a moderator has to move it out
(`src/housing-listings/entities/housing-listing.entity.ts:15-23`). A deterministic
0 to 100 risk score is computed at write time and drives a risk-sorted moderation
queue; it is never exposed on public browse
(`housing-listing.entity.ts:208-218`).

An enquirer sees the listing at `GET /housing-directory/:slug`. What they see
depends on one boolean:

```
const precise =
  (listerId !== null &&
    (listerId === viewerId ||
      (await this.connections.areConnected(viewerId, listerId)))) ||
  (await this.viewings.hasUnlockedViewing(listing.id, viewerId));
```
(`src/housing-listings/housing-directory.service.ts:260-265`)

**Verification.** A member submits a request with their own words and an optional
link to already-public corroboration
(`src/verification/dto/submit-verification-request.dto.ts:10-31`). A staff
reviewer approves or refuses it. Approval calls `grantLevel`; nothing else raises
a level (`src/verification/verification.service.ts:1602-1607`).

**Messaging.** A cold contact cannot simply arrive in someone's inbox: an
unconnected sender's message becomes the seed of a connection request instead of
a delivered message (`src/messaging/message-requests.service.ts:89-100`), and a
block in either direction refuses the send outright
(`message-requests.service.ts:69-73`). Delivered messages are stored as plain
`text` in `messages.body` (`src/messaging/entities/message.entity.ts:104-105`).
A notification is written, and a Web Push is sent if the recipient has a
subscription and is not currently online.

---

## 2. Necessity and proportionality

### 2.1 Housing

**Is the processing necessary?** A housing listing that cannot say where the home
is does not work. The necessity question is therefore not whether to hold the
address, it is **when to reveal it**.

**Is it proportionate?** The design answers this by holding two locations and
disclosing only the coarse one by default:

- The approximate pin is always the neighbourhood centroid, resolved from
  `area`/`city` through a fixed table
  (`src/housing-listings/housing-geo.ts:31-92`). It is described as "coarse by
  design, a neighbourhood centre, never a street" (`housing-geo.ts:31-32`).
- The response mapper computes the approximate pin from the centroid and never
  from the stored precise point, "so a public read can never be
  reverse-engineered into the address"
  (`src/housing-listings/housing-listing-response.ts:168-170`).
- `addressLine` is attached only when `precise` is true
  (`housing-listing-response.ts:223`), and `precise` defaults to false
  (`housing-listing-response.ts:166`).

**Data minimisation on the flatmate board.** The special-category identity block
is optional, framed as compatibility rather than intrusion, stored only while
consent is on the record, and cleared when consent is withdrawn
(`src/flatmate-profiles/entities/flatmate-profile.entity.ts:139-152`). The
visibility setting defaults to `matches`, "the most private still-useful
audience" (`:145-147`). Critically, none of it drives an exclusion filter: the
enum docstring records that the setting "only ever *widens* what an affirming
match can see, it never drives an exclusion filter (fair-housing)"
(`flatmate-profile.entity.ts:17-23`), and affirming values are "values, not
exclusions, no 'trans-only' style filter is ever built from these" (`:129-133`).
That is proportionality and non-discrimination in the same decision.

### 2.2 Identity verification

**Is the processing necessary?** Housing fraud against queer people is real, and
an assurance signal reduces it. So a verification level is necessary.

**Is processing an identity document necessary?** Today the platform's answer is
no, and it holds none. The entity docstring is explicit: "this platform
deliberately never stores the document image or any biometric. This row keeps
only a LEVEL, the METHOD/PROVIDER that granted it, and an OPAQUE `provider_ref`"
(`src/verification/entities/member-verification.entity.ts:21-28`). The request
DTO says the same of the evidence path: "the member's own words plus a link to
already-public corroboration, never a document upload, so nothing
special-category is ever stored here"
(`src/verification/dto/submit-verification-request.dto.ts:10-13`).

**Proportionality is therefore currently maximal**: the least intrusive means
that achieves the purpose is being used, because the intrusive means is not
implemented at all. §3 records what changes if that stops being true.

### 2.3 Messaging

**Is the processing necessary?** Storing message bodies is necessary to deliver
and re-display a conversation. Nothing else about a message is stored beyond what
the product renders.

**Is it proportionate?** Partly. The genuinely proportionate choices:

- Typing indicators and presence are live-only and never persisted (stated in the
  published policy, `queerpulse/src/shared/i18n/catalogs/en/marketing.ts:1075-1076`).
- Push previews are suppressed per recipient at the composer, because on iOS the
  service worker never runs and a client-side toggle silently fails
  (`src/push/push-preview-privacy.service.ts:8-45`). The default with no
  preference row is hidden (`:42-45`).
- There is **no moderator route that reads a conversation.** A moderator sees a
  message only as a snapshot captured at the moment a member reported it
  (`src/reports/reports.service.ts:413-422`).

The disproportionate part is retention: see §4.3.

---

## 3. Verification: the current state, stated honestly

**No identity documents are processed today, and no identity-verification vendor
is bound.**

- `VerificationModule` binds `StubIdentityVerificationProvider`
  (`src/verification/verification.module.ts:49-77`). Its own docstring says it
  "does NOT talk to any real KYC vendor" and that `parseCallback` "trusts an
  unsigned dev payload"
  (`src/verification/providers/stub-identity-verification.provider.ts:10-19`).
- The provider factory **refuses to boot** if `VERIFICATION_AUTOMATED_ELEVATION=true`
  while the stub is bound, because that combination "lets any caller forge
  /verification/identity/callback and self-grant id_verified"
  (`src/verification/verification.module.ts:69-72`).
- `handleIdentityCallback` refuses to act at all when the stub is bound in
  production, returning a 404 and logging an error
  (`src/verification/verification.service.ts:259-265`).
- Even with the flag set, `automatedElevationEnabled()` returns false behind the
  stub (`src/verification/verification.service.ts:1607-1620`), so the only route
  to `id_verified` is an approved human review.

### 3.1 What must be reassessed before a real vendor is bound

Binding Stripe Identity, Didit, Veriff or any equivalent turns this into
**Article 9 special-category processing of biometric and identity-document data**,
which is a different assessment from the one above. This DPIA must be reopened
and the following settled before the binding lands:

1. **A signed sub-processor agreement** with the vendor, added to
   `docs/ops/sub-processors-and-processing.md` §1.2 with its actual region and
   transfer mechanism.
2. **Signature verification.** `parseCallback` must verify an HMAC signature over
   the raw request body before returning `verified: true`
   (`src/verification/providers/identity-verification.provider.ts:33-38`). The
   `@Public()` + `@SkipCsrf()` callback route is only safe on that premise
   (`src/verification/verification.service.ts:251-257`).
3. **Confirmation that no document image reaches QueerPulse.** The seam is
   designed so only an opaque `provider_ref` comes back. A vendor integration
   that returns an image, a document number, or a date of birth breaks the
   premise every line of §2.2 rests on.
4. **A retention period for the vendor's own copy**, and a documented deletion
   instruction.
5. **A legal basis for Article 9.** Explicit consent under Article 9(2)(a) is the
   realistic route, which means verification must remain genuinely optional and
   refusing it must not lock a member out of housing entirely.
6. **A re-run of §5's risk register** with the two document-specific risks that do
   not exist today: vendor breach, and a QueerPulse-side leak of the correlation
   between a legal identity and a queer account.

Until all six are answered, the honest statement is the one at the top of this
section.

---

## 4. Risks to the rights and freedoms of data subjects

Severity uses the real-world consequence rather than the record count. In this
community, one member outed to the wrong person is a high-severity event.

### 4.1 Housing

| # | Risk | Who is harmed | Likelihood | Severity |
|---|---|---|---|---|
| H1 | A member's home address is disclosed to someone they have not let in | The lister, and anyone living with them | Low | **High** |
| H2 | A listing's precise coordinates leak through a public read, letting the address be reverse-engineered | The lister | Low | **High** |
| H3 | Special-category flatmate fields (out-at-home status, medication discretion, chosen-name post) are seen by someone outside the consented audience | The flatmate-board member | Low | **High** |
| H4 | A listing photo carries GPS EXIF and reveals the address the listing withholds | The lister | Low | **High** |
| H5 | A fraudulent listing extracts money, or an in-person viewing puts a member in a room with someone dangerous | The enquirer | Medium | **High** |
| H6 | A moderator's free-text decision note about a listing reaches someone who is not the owner or a moderator | The lister | Low | Medium |
| H7 | An address is disclosed to an external geocoder | The lister | Certain, by design | Low |

### 4.2 Verification

| # | Risk | Who is harmed | Likelihood | Severity |
|---|---|---|---|---|
| V1 | A member self-grants `id_verified` and uses the badge to make a fraudulent housing listing credible | Every enquirer who trusts the badge | Low today | **High** |
| V2 | A member's free-text verification `context` contains more than they intended, and sits in a staff queue | The requester | Medium | Medium |
| V3 | *Future, on binding a vendor:* identity documents are processed, creating a link between a legal identity and a queer account | The member | n/a today | **Very high** |

### 4.3 Messaging

| # | Risk | Who is harmed | Likelihood | Severity |
|---|---|---|---|---|
| M1 | A database compromise exposes plaintext message bodies going back to a member's first day | Every member in every conversation | Low | **Very high** |
| M2 | A bug or a bad query shows one member another member's conversation | Two members at a time | Low | **High** |
| M3 | A push notification prints a sender's name and message on a lock screen someone else can see | The recipient, and whoever they are hiding from | Medium | **High** |
| M4 | Harassment, grooming or abuse in a private conversation is not detected until someone reports it | The recipient | Medium | **High** |
| M5 | A shared device retains a signed-in session and the whole message history is readable by whoever holds the device | The member | Medium | **High** |
| M6 | A member's own data export contains messages that quote other people | Third parties in the conversation | Medium | Medium |

---

## 5. Measures to address the risks

These are implemented today. They are listed with their code so a reviewer can
check the claim rather than take it.

### 5.1 Address disclosure (H1, H2, H6)

- **Two-location model.** Public reads receive a neighbourhood centroid only, and
  the approximate pin is computed from the centroid rather than degraded from the
  precise point (`src/housing-listings/housing-listing-response.ts:168-170`,
  `src/housing-listings/housing-geo.ts:77-92`).
- **Three-way unlock, all of them affirmative.** The address is revealed to the
  owner, to a mutually-connected member, or to an enquirer whose viewing request
  the lister **accepted**
  (`src/housing-listings/housing-directory.service.ts:252-265`,
  `src/housing-viewings/housing-viewings.service.ts:296-308`). The comment states
  the design intent plainly: "A cold enquiry still deliberately creates no
  connection, so an unanswered enquiry never unlocks the address"
  (`housing-directory.service.ts:256-257`).
- **The `locationPrecision` field tells the client which pin it holds**, so the
  UI can show an honest "approximate, exact address shared after you connect"
  note (`housing-listing-response.ts:118-121`).
- **Moderator notes are gated separately from the address.** `includeDecision` is
  deliberately not the same flag as `precise`, because "`precise` is also granted
  to a connected member and to an enquirer with an accepted viewing, and neither
  of them may read a moderator's note about somebody else's listing"
  (`housing-listing-response.ts:155-161`).
- **Withheld listings 404 for everyone but the owner**, so an old link or a stale
  search hit cannot resurface an address
  (`housing-directory.service.ts:228-240`).

### 5.2 Special-category flatmate data (H3)

- **Explicit consent gate.** Nothing is served unless
  `special_category_consent_at` is set; null "= no consent = the special-category
  fields are served to no one"
  (`src/flatmate-profiles/entities/flatmate-profile.entity.ts:150-152`).
- **Withdrawal actually deletes.** The fields are "cleared when consent is
  withdrawn" (`flatmate-profile.entity.ts:139-142`).
- **Private-by-default audience** (`:145-147`).
- **No exclusion filters** built from any of it (`:17-23`, `:129-133`).
- The riskiest single field, out-at-home status, was **moved** out of the
  ordinary preferences block into the consent-gated block once it was recognised
  that it "can reveal sexual orientation (CJEU C-184/20), which is Art.9
  special-category" (`flatmate-profile.entity.ts:36-38`).

### 5.3 Photo metadata (H4)

- **Client-side EXIF and GPS strip on every image path**, described as
  SAFETY-CRITICAL (`queerpulse/src/features/members/api/uploads.api.ts:54-60`).
  Uploads go straight to presigned storage, so the client is the only strip
  point; a strip failure surfaces an error rather than uploading the original
  (`queerpulse/src/features/economy/ListSpacePhotoField.tsx:19`).
- **Server-side magic-byte validation** as the backstop against a file that is
  not the image type it claims (`src/storage/served-object.ts:20-55`,
  `src/storage/storage.service.ts:207-240`).
- **Storage-key ownership interception** so a member cannot claim a storage key
  they did not upload (`src/storage/storage-key-ownership.interceptor.ts`,
  `src/storage/assert-no-foreign-upload.ts`).

### 5.4 Housing fraud and viewing safety (H5, V1)

- **Pre-publish moderation.** Every create lands in `review`; a member never
  self-transitions (`src/housing-listings/entities/housing-listing.entity.ts:15-23`).
- **Deterministic risk scoring** feeding a risk-sorted queue, never exposed
  publicly (`housing-listing.entity.ts:208-218`).
- **Video-call-first viewings** as the anti-scam default, described as "the
  research-backed anti-scam default ('see it live before you pay')"
  (`src/housing-viewings/entities/housing-viewing.entity.ts:10-15`).
- **Broker disclosure** as a visible badge rather than a ban
  (`housing-listing.entity.ts:50-60`).
- **Mandatory affirming pledge** on both create and enquiry
  (`src/housing-listings/housing-listings.module.ts:42`).
- **Verification cannot be self-granted** (§3).

### 5.5 Geocoding disclosure (H7)

- The address goes to Nominatim **from the server**, with a bot user agent and no
  cookies (`src/geocode/geocode.service.ts:121-124`), so the member's IP address
  is never disclosed.
- The same SSRF guard every other outbound fetch uses is applied even though the
  host is fixed and trusted (`src/geocode/geocode.service.ts:74-83`), with
  `redirect: 'error'` so a surprise redirect cannot carry the address elsewhere.
- Only the **approximate** centroid is used for the public map; the precise
  coordinates today "stay null unless set out-of-band"
  (`src/housing-listings/entities/housing-listing.entity.ts:136-143`).

### 5.6 Message confidentiality (M1, M2, M5)

- **Refresh-token families.** A session is the chain of rows descended from one
  sign-in, so "sign out this device" addresses the session a member recognises
  (`src/auth/entities/refresh-token.entity.ts:18-29`). Reuse of a rotated token
  is detectable, and dead rows are kept one refresh lifetime for exactly that
  reason (`src/auth/auth-maintenance.service.ts:18-30`).
- **No IP address on a session row** (`src/auth/entities/refresh-token.entity.ts`
  has no such column), and request logs carry only method, URL and status, with
  cookies and authorization redacted (`src/app.module.ts:157-186`).
- **httpOnly cookie session with double-submit CSRF**, guard chain Throttler then
  CSRF then JWT (`CLAUDE.md`, `src/main.ts:76-104`, `src/security/csrf.guard.ts`).
  The CSRF cookie carries the `__Host-` prefix, which forbids a Domain attribute
  (`src/config/env.validation.ts:371-378`).
- **Quick exit** on high-stakes safety pages: `location.replace` to a neutral
  site plus 30 sentinel history entries so Back cannot step into the app
  (`queerpulse/src/features/safety/QuickExit.tsx:6-30`).
- **Blocks and mutes.** A block refuses a send in either direction
  (`src/messaging/message-requests.service.ts:69-73`, `src/social/entities/block.entity.ts`),
  and per-conversation mute is a participant preference
  (`src/messaging/entities/conversation-participant.entity.ts:66`).
- **Cold contact becomes a connection request rather than a delivered message**
  (`src/messaging/message-requests.service.ts:89-100`).
- **No moderator conversation-read route exists.** Verified by inspection of
  `src/moderation/*.controller.ts` and `src/admin-reports`: neither references a
  conversation or a message repository.
- **Storage-key ownership** and **magic-byte validation** on message image
  attachments, on exactly the same path as every other upload
  (`src/messaging/entities/message.entity.ts:20-23`).
- **SSRF protection** on link previews and every server-initiated fetch, with
  connection pinning against DNS rebinding
  (`src/link-preview/ssrf.ts:9-35`).

### 5.7 Push preview exposure (M3)

- Split at the composer, per recipient, because iOS renders the payload itself
  and never runs the service worker's push handler
  (`src/push/push-preview-privacy.service.ts:8-28`).
- **Fail closed**: an absent preference row means hidden
  (`push-preview-privacy.service.ts:42-45`).
- Every caller in `src/push` routes through this service "so a new notification
  type is private by construction instead of by remembering to add a branch"
  (`push-preview-privacy.service.ts:38-41`).

### 5.8 Abuse in private conversations (M4)

- **Reporting captures a server-authoritative snapshot** at filing time, so an
  edit inside the 15-minute window
  (`src/messaging/messaging.constants.ts:5`) or a later soft delete cannot rewrite
  what a moderator judges (`src/reports/reports.service.ts:391-422`).
- **A member cannot report their own message**, checked against the real sender
  including soft-deleted rows (`src/reports/reports.service.ts:92-110`).
- **A permanent ban needs a second, independent moderator.** One moderator alone
  can no longer permanently remove a member; the pending state is an interim
  suspension whose expiry lapses the ban rather than escalating it
  (`src/moderation/ban-ratification.service.ts:40-62`). This is also "the one
  control that would contain a compromised moderator account"
  (`ban-ratification.service.ts:46-49`).
- **Immutable moderator audit trail** that survives the moderator erasing their
  own account (`src/moderation/entities/mod-audit-log.entity.ts:43-50`).
- **Ban-evasion signals hold hashes only**, under a pepper never stored in the
  database, with no IP address and no device fingerprint
  (`src/ban-evasion/entities/removed-account-signal.entity.ts:20-45`).

### 5.9 Consent-gated monitoring

Frontend error monitoring transmits nothing until the member grants `monitoring`
consent; `beforeSend` returns null otherwise, and the attached user id is an
opaque hash (`queerpulse/src/shared/observability/sentry.ts:91-97, 121-125,
146-150`). Every consent decision is appended to `consent_record` with the exact
policy version it was made against
(`src/consent/entities/consent-record.entity.ts:21-25`).

### 5.10 Retention sweepers that reduce standing exposure

Read notifications are deleted after 90 days while unread ones are never touched
(`src/notifications/notification-retention.service.ts:11-18, 37-57`). Stale push
subscriptions are pruned after 90 days
(`src/push/push-subscription-retention.service.ts:53-71`). Card verification
records are deleted after a hard-coded 90 days
(`src/membership-cards/card-scan-retention.service.ts:11-19, 40-56`). Data-export
archives have their payload nulled after 30 days
(`src/account/account-retention.service.ts:46-89`), and the download link they
were issued with is refused after 7
(`src/account/account.service.ts:517-522`). Gathering attendance detail, the
check-in record and the free-text access and dietary needs a member supplied, is
cleared 30 days after the gathering ends
(`src/events/event-attendance-retention.service.ts:125-176`). Step-up reauth
tokens are purged on expiry, every six hours
(`src/account/account-retention.service.ts:97-115`). Full table in
`docs/ops/retention-periods.md`.

---

## 6. Residual risk register

After the measures in §5.

| # | Residual risk | Residual level | Accepted by | Position |
|---|---|---|---|---|
| R1 | **Message bodies are stored in plaintext with no retention limit.** `messages.body` is a plain `text` column (`src/messaging/entities/message.entity.ts:104-105`), there is no application-layer encryption, and no sweeper deletes old messages. Database-level encryption at rest is a provider setting this repository cannot observe. | **High** | `[OWNER: to be filled in]` | Accepted for now. Two mitigations are available and neither is implemented: a member-settable disappearing-messages window, and encryption at rest verified at the provider. **UNVERIFIED, needs a human answer:** whether Railway's managed Postgres encrypts at rest, and whether the Tigris bucket does. |
| R2 | **No automated content scanning exists.** Confirmed by inspection: there is no classifier, no moderation vendor, and no toxicity or CSAM detection anywhere in `src`. This is open finding TS-01. | **Medium** | `[OWNER: to be filled in]` | **Accepted, with reactive reporting as the compensating control.** A member reports; the report captures a snapshot (`src/reports/reports.service.ts:413-422`); a moderator acts and the action is logged; a permanent ban needs a second moderator. The residual is the window between harm and report, and the harm nobody reports. |
| R3 | **A moderator account is the widest read in the system.** Moderators can read report evidence including message snapshots, and moderator role changes are logged but not two-person-approved. | **Medium** | `[OWNER: to be filled in]` | Partly mitigated: the permanent-ban path needs two moderators, and every action is in an immutable trail. Not mitigated: reading. |
| R4 | **No identity-verification vendor is bound, so `id_verified` rests entirely on human review.** | **Low** | `[OWNER: to be filled in]` | Accepted. This is the safer end state of the two, and the boot-time guards make the unsafe alternative unreachable (§3). |
| R5 | **Precise housing coordinates are not populated by any write path today** (`src/housing-listings/entities/housing-listing.entity.ts:141-143`). When a production geocoder starts populating them, the volume of precise-location data jumps and H2 becomes materially more likely. | **Low today** | `[OWNER: to be filled in]` | Trigger for review (§7). |
| R6 | **A member's data export contains messages that quote other people.** The export includes only messages the member sent (`senderId: userId`, `src/account/account-export.service.ts:224-238`), which is the right minimisation, but a sent message can still quote or describe a third party. | **Low** | `[OWNER: to be filled in]` | Accepted. Any narrower rule would break the member's own Article 20 right. |
| R7 | **Moderation records are retained indefinitely** with no defined period (`docs/ops/retention-periods.md` §1). Pseudonymisation on erasure is real, but "forever" is not a retention period. | **Medium** | `[OWNER: to be filled in]` | Open. A defined period, even a long one, has to be set and published. |
| R8 | **The published privacy policy does not match the code** on several points and names an email processor that does not exist. Members are currently making decisions against inaccurate information, which is itself an Article 13 transparency problem. | **Medium** | `[OWNER: to be filled in]` | Partly closed. The two items where the code was wrong have been fixed in code (gathering attendance now clears, the export link expiry is now enforced), so the remaining set is copy the frontend has to correct. See `docs/ops/retention-periods.md` §2. |
| R9 | **Single-replica constraint** means there is no shared throttler store and no socket Redis adapter (`src/app.module.ts:207-215`). This is an availability concern. | **Low** | `[OWNER: to be filled in]` | Accepted and enforced at boot (`src/config/env.validation.ts:221-247`). |

---

## 7. Review triggers

Reopen this DPIA when any of the following happens, without waiting for the
scheduled date:

1. **A real identity-verification provider is bound** in
   `src/verification/verification.module.ts`, or `VERIFICATION_AUTOMATED_ELEVATION`
   is set anywhere. Work through §3.1 first.
2. **A write path starts populating `housing_listings.latitude`/`longitude`**
   (R5).
3. **`launchedFeatures.cinema` flips to `launched: true`**
   (`src/launchedFeatures.ts:57-60`), which makes Mux a processor of member video.
4. **Any automated content scanning or classifier is introduced** (this would
   close R2 and open a new profiling assessment).
5. **A new sub-processor appears** in
   `docs/ops/sub-processors-and-processing.md` §1.
6. **A personal data breach is declared** on any of these three surfaces
   (`docs/ops/breach-notification.md`).
7. **Message retention changes**, in either direction.
8. **A legal entity is incorporated**, changing the controller.

Otherwise: **annually**, by `[OWNER: to be filled in]`.

---

Related: `docs/ops/sub-processors-and-processing.md`,
`docs/ops/retention-periods.md`, `docs/ops/breach-notification.md`,
`docs/ops/dsar-runbook.md`, `docs/ops/incident-response.md`.
