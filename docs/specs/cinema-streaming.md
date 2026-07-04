# Cinema streaming — spec

Status: **draft, awaiting review**
Date: 2026-07-04
Decisions confirmed with the owner: provider = **Mux**, DRM = **out of scope**, entitlement = **all active members**, uploads = **admin/moderator only**.

## 1. Scope

Video-on-demand for the Cinema section: feature films and community shorts, uploaded by admins/moderators, watched by active members in the web app.

In scope:

- Title catalog (create/edit/publish/delete) managed by admin/moderator.
- Ingest: direct browser upload of a source file to Mux (bytes never pass through this backend).
- Transcoding to an HLS adaptive-bitrate ladder — performed by Mux, tracked by webhook.
- Entitlement-gated playback via short-TTL signed playback tokens.
- Resume-where-you-left-off progress and a per-title view count.

Out of scope (see §12 for reasoning): live streaming, DRM, member-submitted uploads, payments/tickets/rentals, geo-restriction, downloads/offline.

## 2. Provider decision: Mux

Researched July 2026 against official pricing/docs (Mux, Cloudflare Stream, Bunny Stream, self-managed R2/B2 + Bunny/Cloudflare CDN + ffmpeg, AWS S3 + CloudFront + MediaConvert).

| Option | Cost @ 20 h stored / 2,000 h delivered per month | Cost at realistic current scale | Build effort |
|---|---|---|---|
| **Mux** | ~$24/mo | **~$0–8/mo** (first 100k delivery min/mo free, free basic encoding, free analytics) | lowest |
| Bunny Stream | ~$14–28/mo | ~$1–6/mo | low, fiddlier token model |
| Cloudflare Stream | ~$120–130/mo | ~$10–15/mo | low |
| R2/B2 + CDN + own ffmpeg | ~$1–28/mo | ~$1–6/mo | high: transcode worker, job queue (none exists in repo), CDN cache rules, signing Worker |
| AWS S3 + CloudFront + MediaConvert | ~$16.50/mo + $54 one-time transcode | similar | highest plumbing |

Why Mux:

- **Least code for a complete pipeline.** Direct uploads, transcoding, ABR packaging, CDN delivery, signed playback, thumbnails/storyboards, and per-title analytics through one API with an official Node SDK (`@mux/mux-node`).
- **Effectively free at current scale.** Basic-quality encoding is free; the first 100,000 delivery minutes per month are free across all resolutions; storage is $0.0030/min/month at 1080p (≈$3.60/mo for a 20 h library). Free plan caps at 10 stored videos — moving past that requires pay-as-you-go with a card on file.
- **No proprietary lock-in at the player.** Playback is standard HLS (`https://stream.mux.com/{playbackId}.m3u8`), playable by hls.js/Video.js/native Safari.
- **No job queue needed.** The repo has no Redis/Bull; Mux's `video.asset.ready` webhook replaces one. A self-managed pipeline would force adding queue infrastructure now.
- **Analytics included.** Mux Data is free for Mux-hosted video, covering per-title engagement; our own view-count signal (§8) stays deliberately minimal.

Not chosen:

- **Cloudflare Stream** — same integration shape but strictly more expensive here ($10/mo storage minimum; delivery billed $1/1,000 min regardless of the resolution actually watched) with no offsetting advantage.
- **Bunny Stream** — cheapest managed option and a fine fallback, but two independent token layers (embed tokens vs CDN path tokens) that are easy to misconfigure, manual HMAC signing, and lighter analytics.
- **Self-managed (R2/B2 + CDN + ffmpeg)** — the long-term cost floor (R2 egress is $0), but it means building and operating transcoding (~4–8 h per 2-hour film on a small VPS), a queue, cache rules, and a token-validating Worker. This is the documented **exit path if delivery spend gets real** (Mux delivery beyond the free tier ≈ $0.06/h at 1080p; the crossover is roughly >100k delivered minutes/month sustained), not the starting point. Migration is uncomplicated because we keep source masters' metadata and our API contract is provider-agnostic (§7).
- **AWS S3 + CloudFront + MediaConvert** — newly cost-competitive (CloudFront $15 flat-rate plan, Nov 2025) but by far the most assembly (IAM, job templates, EventBridge, key groups, signed cookies) for zero product benefit at this scale.

## 3. Delivery format: HLS adaptive bitrate

- **HLS with an ABR ladder, not a single MP4.** A 2-hour film as one MP4 forces every viewer to fetch full-bitrate bytes regardless of connection, stalls on slow networks, and makes seeking expensive. HLS serves 4–6 s segments at multiple renditions and the player adapts per segment.
- **Ladder:** Mux basic quality generates the ladder automatically from the source (up to 1080p), typically covering ~270p → 1080p. We do not hand-tune rendition lists; that is exactly the undifferentiated work we are buying. Sources should be uploaded at the highest master quality available (1080p+ H.264/ProRes etc.).
- **Codecs:** H.264 video + AAC audio — the universal compatibility baseline (every browser, iOS/Android, smart TVs). HEVC/AV1 are a later cost optimization via Mux quality settings ("plus"/"premium"), not a launch requirement.
- **Segments/manifests are Mux's output**; we never generate or rewrite manifests.

## 4. Architecture and data flow

The backend is a **control plane only**. Video bytes flow browser ↔ Mux in both directions; NestJS mints URLs/tokens and tracks state.

```
INGEST
admin browser ──(1) POST /cinema/titles ────────────────▶ NestJS: create draft title
admin browser ──(2) POST /cinema/titles/:id/upload ─────▶ NestJS ──▶ Mux: create direct upload
admin browser ◀─────────── one-time upload URL ──────────┘
admin browser ──(3) PUT file bytes (resumable) ─────────▶ Mux storage
Mux ──(4) webhook video.upload.asset_created ───────────▶ NestJS: store assetId, status=processing
Mux ──(5) webhook video.asset.ready ────────────────────▶ NestJS: store playbackId+duration, status=ready
admin ──(6) PATCH /cinema/titles/:id {publish} ─────────▶ NestJS: publishedAt=now

PLAYBACK
member browser ──(1) POST /cinema/titles/:id/playback ──▶ NestJS: entitlement check → sign JWT
member browser ◀── { hlsUrl+token, posterUrl+token, resumePosition } ──┘
member browser ──(2) GET stream.mux.com/….m3u8?token=… ─▶ Mux CDN (manifests, segments, 206s)
member browser ──(3) PUT /cinema/titles/:id/progress ───▶ NestJS: upsert progress, maybe count view
```

### Title state machine

`draft → awaiting_upload → processing → ready | failed`

- `draft` — metadata exists, no upload requested yet.
- `awaiting_upload` — a Mux direct-upload URL was minted (uploadId stored). Re-requesting an upload URL is allowed and replaces the previous uploadId (covers abandoned uploads; Mux expires unused upload URLs).
- `processing` — `video.upload.asset_created` received; assetId stored.
- `ready` — `video.asset.ready` received; playbackId + duration stored. Only now can the title be published.
- `failed` — `video.asset.errored` / `video.upload.errored` / `video.upload.cancelled`; error message stored. Admin can re-request an upload URL, which returns the title to `awaiting_upload` (and deletes the failed Mux asset if one exists).

Re-uploading on a `ready` title (replacing the film) creates a new Mux upload tracked in the `pending_*` columns; the title stays published and playable on the *old* asset until the new one reaches `ready`, then the ids swap atomically and the old Mux asset is deleted. Viewers never hit a dead title mid-replacement.

### Webhook handling

- Endpoint: `POST /cinema/webhooks/mux` — `@Public()` (no JWT) and CSRF-exempt (§10), authenticated instead by verifying the `mux-signature` header (HMAC-SHA256 over the raw body with `MUX_WEBHOOK_SECRET`, via the SDK's `mux.webhooks.verifySignature`). Requires `rawBody: true` in `NestFactory.create` (small `main.ts` change; `RawBodyRequest` is standard Nest).
- Handlers are **idempotent** (Mux retries; events can arrive out of order). Each handler matches on `data.id`/upload id against stored ids and ignores events for unknown or superseded uploads/assets. Returns 2xx quickly; no heavy work inline.
- **Reconciliation for missed webhooks:** an hourly `@nestjs/schedule` cron lists titles stuck in `awaiting_upload`/`processing` older than 15 minutes and polls the Mux API for their upload/asset status, applying the same idempotent transition logic. This removes the webhook as a single point of failure without adding queue infrastructure. An admin `POST /cinema/titles/:id/refresh` triggers the same check on demand.

## 5. Efficiency requirements (explicit)

| Requirement | Where it is satisfied |
|---|---|
| HTTP range / 206 Partial Content | Mux CDN serves all media (segments, MP4 renditions if ever enabled) with full range support. The NestJS origin serves **zero** media bytes, so there is no byte-serving code path to get wrong. |
| Signed, short-TTL URLs; no permanent public links | Every Mux asset is created with `playback_policy: ["signed"]` — the playback ID is unusable without a valid token. Tokens are RS256 JWTs minted per playback request (§7) with TTL = title duration + 30 min (min 1 h, max 12 h). Thumbnail/storyboard requests need their own signed tokens (`aud: "t"` / `"s"`), also minted server-side. |
| Segment/manifest caching + CDN strategy | Mux's CDN handles manifest/segment cache headers; we never proxy or cache manifests. Our JSON API responses that embed tokens are sent `Cache-Control: no-store`. |
| Stream, don't load; no whole-file buffering in Node | Uploads go browser → Mux directly (resumable PUT against a one-time upload URL); playback goes Mux CDN → browser. The Node process only ever handles small JSON payloads. |
| Backend efficiency | Playback-token minting is pure local JWT signing (no Mux API call per view — the signing key is fetched once at startup/config). Progress writes are a single upsert on a `(user_id, title_id)` unique key. |

## 6. Access control / entitlement

- **Model:** every user with `status = active` may watch every published, ready title. This reuses the existing meaning of membership in this invite-only community (`ActiveMemberGuard`); there is no per-title ACL, tier, ticket, or rental window in v1.
- **Where the check happens:** at playback-session creation (`POST /cinema/titles/:id/playback`). Guard chain: global JWT auth → `ActiveMemberGuard` → service check `title.publishedAt != null AND title.status = ready` (admins/moderators may also preview unpublished `ready` titles).
- **How it binds to the URL:** the response embeds a signed JWT whose `sub` is that title's Mux playback ID and whose `exp` enforces the TTL. The token *is* the entitlement artifact — Mux's CDN rejects any manifest/segment/thumbnail request without a valid one. There are no unsigned playback IDs anywhere in the system, so no permanent shareable link exists. A leaked URL dies at `exp`.
- **No `entitlements` table.** Entitlement is fully derived from `user.status` + title publish state, so a table would be dead weight. If ticketed or tiered access arrives later, the check in `CinemaService.authorizePlayback()` is the single seam where an entitlement lookup slots in.

## 7. Playback session

`POST /cinema/titles/:id/playback` (active member) returns:

```json
{
  "hlsUrl": "https://stream.mux.com/{playbackId}.m3u8?token=…",
  "posterUrl": "https://image.mux.com/{playbackId}/thumbnail.webp?token=…",
  "storyboardUrl": "https://image.mux.com/{playbackId}/storyboard.vtt?token=…",
  "expiresAt": "2026-07-04T21:12:00Z",
  "resumePositionSeconds": 1284,
  "durationSeconds": 7200
}
```

- Tokens are minted locally with the Mux signing key (`RS256`; claims `sub` = playbackId, `aud` = `v`/`t`/`s`, `exp`). No per-view Mux API call, no rate-limit exposure.
- TTL = duration + 30 min (clamped to [1 h, 12 h]) so one token covers a full uninterrupted viewing but a shared link expires the same day. If a token expires mid-session (long pause), the player re-requests a playback session — same endpoint, idempotent, returns the saved resume position.
- **No `playback_sessions` table.** The signed token is the session; persisting one row per play adds writes with no consumer (view counting lives on watch progress §8, engagement analytics live in Mux Data). If per-session audit is ever needed, this endpoint is the single place to add it.
- Frontend contract (not part of this backend): hls.js (or native HLS on Safari) pointed at `hlsUrl`; no Mux player required.

## 8. Watch progress & view count

- `PUT /cinema/titles/:id/progress` body `{ "positionSeconds": 1284 }` — client sends every ~10 s during playback and on pause/unload. Upserts `cinema_watch_progress` on `(user_id, title_id)`.
- Resume: `resumePositionSeconds` is returned by the playback endpoint (and by title detail for UI badges). Positions within the final 3% of duration are treated as "finished" and resume from 0.
- **View count:** a view is counted once per user per title, when a progress report first crosses `min(60 s, 50% of duration)` (the 50% arm covers very short films). Implementation: `viewCountedAt` timestamp on the progress row set transactionally with an increment of `cinema_titles.view_count`; the timestamp makes the increment idempotent under repeated/racing progress calls. Rewatches do not re-count in v1 — richer engagement data comes free from Mux Data.
- Progress reports are validated against the title's duration (reject positions > duration + 5 s) and throttled by the existing global throttler.

## 9. Data model

Two tables (module-local entities in `src/cinema/entities/`, hand-written SQL migration like every other feature):

**`cinema_titles`**

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| kind | enum `cinema_titles_kind_enum` (`film`, `short`) | |
| title | varchar | |
| description | text nullable | |
| cover_image_url | varchar nullable | reuses the existing image-upload flow (S3 presign), not Mux |
| status | enum `cinema_titles_status_enum` (`draft`, `awaiting_upload`, `processing`, `ready`, `failed`) | state machine §4 |
| error_message | text nullable | set on `failed` |
| mux_upload_id | varchar nullable | current/last direct upload |
| mux_asset_id | varchar nullable | |
| mux_playback_id | varchar nullable | signed-policy playback ID |
| pending_mux_asset_id / pending_mux_upload_id | varchar nullable | in-flight replacement of a ready title (§4) |
| duration_seconds | integer nullable | from `video.asset.ready` |
| aspect_ratio | varchar nullable | from Mux, for player sizing |
| published_at | timestamptz nullable | null = unpublished |
| view_count | integer not null default 0 | denormalized counter (§8) |
| created_by | uuid FK → users, `ON DELETE SET NULL` nullable | |
| created_at / updated_at | timestamptz | repo convention |

Indexes: `(status)`, `(published_at)`, unique partial on `mux_asset_id` / `mux_upload_id` where not null (webhook lookups).

**`cinema_watch_progress`**

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users, `ON DELETE CASCADE` | |
| title_id | uuid FK → cinema_titles, `ON DELETE CASCADE` | |
| position_seconds | integer not null | |
| view_counted_at | timestamptz nullable | idempotency marker for view counting |
| updated_at | timestamptz | |

Unique `(user_id, title_id)`; index `(title_id)`.

**Deliberately omitted entities** (vs the generic Title/Rendition/PlaybackSession/Entitlement blueprint): renditions/assets are Mux-owned (we store only the three Mux IDs — a rendition table would model data we never query); playback sessions are stateless tokens (§7); entitlements are derived (§6).

## 10. API surface

All routes sit behind the existing global guard stack (CSRF → JWT → Throttler). `AM` = `ActiveMemberGuard`, `Mod` = `@Roles(Moderator, Admin)`.

**Member-facing**

| Route | Guard | Purpose |
|---|---|---|
| `GET /cinema/titles` | AM | published+ready titles; includes my `resumePositionSeconds`/finished flag |
| `GET /cinema/titles/:id` | AM | detail (published+ready; admins also see drafts) |
| `POST /cinema/titles/:id/playback` | AM | entitlement check → signed playback session (§7) |
| `PUT /cinema/titles/:id/progress` | AM | upsert progress, maybe count view (§8) |

**Admin/moderator**

| Route | Guard | Purpose |
|---|---|---|
| `POST /cinema/titles` | Mod | create draft (kind, title, description, coverImageUrl) |
| `PATCH /cinema/titles/:id` | Mod | edit metadata; `published: true/false` flips `published_at` (publish requires `ready`) |
| `DELETE /cinema/titles/:id` | Mod | delete row + delete Mux asset(s) |
| `POST /cinema/titles/:id/upload` | Mod | mint Mux direct-upload URL (initial or replacement) |
| `POST /cinema/titles/:id/refresh` | Mod | reconcile state against Mux API on demand |
| `GET /cinema/titles?all=true` | Mod | admin listing incl. drafts/processing/failed |

**Webhook**

| Route | Auth | Purpose |
|---|---|---|
| `POST /cinema/webhooks/mux` | `@Public()` + `@SkipCsrf()` + `mux-signature` HMAC verification | asset lifecycle events (§4) |

**Required cross-cutting change:** `CsrfGuard` currently rejects every cookie-less mutating request, which would 403 the webhook. Add a `@SkipCsrf()` decorator honored by `CsrfGuard` via `Reflector` — scoped to routes that carry their own request authentication (the webhook's HMAC). `main.ts` gains `{ rawBody: true }` for signature verification.

## 11. Configuration

New `registerAs('mux', …)` config + optional entries in `env.validation.ts` (mirrors how `S3_*` is optional — the module loads but upload/playback endpoints 500 with a clear "not configured" error, per `StorageService.requireConfig` precedent):

- `MUX_TOKEN_ID` / `MUX_TOKEN_SECRET` — API credentials (uploads, asset management, reconciliation).
- `MUX_WEBHOOK_SECRET` — webhook signature verification.
- `MUX_SIGNING_KEY_ID` / `MUX_SIGNING_PRIVATE_KEY` — playback-token signing (private key base64-encoded PEM, generated once via Mux dashboard/API).

New dependency: `@mux/mux-node` (official SDK: direct uploads, webhook verification, JWT helpers). All Mux access goes through a thin injectable `MuxService` so the rest of the module depends on our interface, not the SDK — this is also the provider-migration seam.

Infra the owner must provision (flagged now, needed before Phase 3 verification against real Mux): a Mux account, an API token, a webhook endpoint configuration pointing at `/cinema/webhooks/mux`, and one signing key. Everything else is code.

## 12. Non-goals & risks

Non-goals (v1): live streaming; DRM (below); member-submitted shorts (admin/mod ingest only); payments/tickets/rentals; geo-restriction; MP4 downloads/offline; in-house analytics beyond the view counter.

- **DRM (Widevine/FairPlay): out of scope, deliberately.** The content is the owner's own filmography shown to an invite-only membership; signed short-TTL URLs stop link-sharing, which is the realistic leak vector. DRM would not stop screen capture anyway and adds licensing cost and player complexity. If it's ever needed, Mux offers DRM as an add-on on the same assets — a config change plus player license setup, not a re-architecture.
- **Signed-URL-only tradeoff:** an entitled member can rip the stream during the token window (as with any non-DRM platform). Accepted.
- **Mux free-plan cap:** 10 stored videos; beyond that requires pay-as-you-go billing. Expected cost at current scale ~$0–8/mo; worst-case researched scenario ~$24/mo.
- **Webhook fragility:** mitigated by idempotent handlers + hourly reconciliation cron + manual refresh endpoint (§4).
- **Vendor lock-in / delivery-cost growth:** exit path documented in §2 (R2/B2 + CDN + ffmpeg); keep source masters offline. `MuxService` isolation keeps the API contract provider-agnostic.
- **Token TTL vs very long films:** TTL formula (§7) plus player-side re-request on 403 covers pauses/overnight tabs.

## 13. Repo alignment

- Module `src/cinema/` mirrors existing features: `cinema.module.ts`, thin controllers (`titles.controller.ts`, `admin-titles.controller.ts`, `webhooks.controller.ts`), services (`cinema.service.ts` for domain logic, `mux.service.ts` for the provider client), `entities/`, `dto/` with class-validator DTOs, colocated `*.spec.ts` unit tests.
- Registered in `AppModule`; entities registered via `TypeOrmModule.forFeature`; snake_case naming via the existing naming strategy; migration added under `src/migrations/` following the hand-written SQL style.
- Reuses: `@CurrentUser()`, `@Public()`, `@Roles()` + `RolesGuard`, `ActiveMemberGuard`, `registerAs` config pattern, env validation class, Bruno collection gets a `Cinema` folder.
- Only two cross-cutting touches: `@SkipCsrf()` in `CsrfGuard` and `rawBody: true` in `main.ts` (justified in §10).

## 14. Testing (written in Phase 3, per step)

- **Entitlement:** playback authorization matrix — active/pending/suspended user × draft/unpublished/published/failed title × member/moderator role.
- **Signed tokens:** JWT claims (`sub`, `aud`, `exp`), TTL clamping rules, distinct video/thumbnail/storyboard audiences, behavior when signing config is missing.
- **Webhook:** signature rejection (bad/missing/stale), idempotent replay of `asset.ready`, out-of-order events, unknown asset ids, replacement-swap flow, `failed` transitions.
- **Progress/view count:** upsert semantics, view counted exactly once across racing/repeated reports, 50%-of-duration arm for shorts, finished-threshold resume-to-zero, position validation.
- **State machine:** allowed/blocked transitions (e.g. publish requires `ready`).
- E2e (supertest, existing `test/` config): guard wiring on the four member routes + webhook CSRF exemption.
