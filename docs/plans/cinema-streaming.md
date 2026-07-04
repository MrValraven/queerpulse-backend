# Cinema Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Mux-based Cinema VOD feature per `docs/specs/cinema-streaming.md` — admin ingest via direct-to-Mux uploads, webhook-driven state machine, entitlement-gated signed HLS playback, watch progress + view counts.

**Architecture:** New `src/cinema/` module (control plane only — no video bytes through Node). `MuxService` wraps `@mux/mux-node`; `CinemaService` owns domain logic + state machine; three thin controllers (member, admin, webhook); one reconciliation cron. Two tables via one hand-written migration.

**Tech stack:** NestJS 11, TypeORM/Postgres, `@mux/mux-node` v14 (needs Node ≥ 20), Jest + repo's mock-repository test style.

## Global constraints

- **pnpm** only. **Never commit or branch** — the user commits. Working tree edits only.
- After each task: run `pnpm run build` and the task's test command; show output before moving on (owner's Phase 3 instruction — overrides the older "don't run tests" note).
- DB schema changes **only** via a migration file; never run DDL directly. `pnpm run migration:run` is executed **by the user**.
- Match repo style: snake_case DB via existing naming strategy, entities in `src/cinema/entities/`, colocated `*.spec.ts`, class-validator DTOs in `src/cinema/dto/`, thin controllers, `registerAs` config + `env.validation.ts`, `@CurrentUser()`/`@Roles()`/`@UseGuards(RolesGuard)`/`ActiveMemberGuard` reuse.
- `strictNullChecks` is on: nullable columns are `| null` types.
- Mux SDK API (verified v14): `new Mux({ tokenId, tokenSecret, webhookSecret })`, `mux.video.uploads.create/retrieve`, `mux.video.assets.retrieve/delete`, `mux.webhooks.unwrap(body, headers)`, `await mux.jwt.signPlaybackId(playbackId, { keyId, keySecret, expiration, type })` with `type: 'video' | 'thumbnail' | 'storyboard'`.
- **Infra the owner provisions (not in any task):** Mux account, API token pair, webhook config pointing at `POST /cinema/webhooks/mux` (public URL or tunnel in dev) + its signing secret, one playback signing key. Tasks are verifiable by unit tests without these; end-to-end verification against real Mux is a user step.

---

### Task 1: Mux config + SDK dependency

**Files:**
- Modify: `package.json` (via `pnpm add @mux/mux-node`)
- Create: `src/config/mux.config.ts`
- Modify: `src/config/env.validation.ts` (add 5 optional vars)
- Modify: `src/app.module.ts` (load `muxConfig`)
- Test: `src/config/env.validation.spec.ts` (extend existing)

**Interfaces produced:** config namespace `mux` with keys `tokenId`, `tokenSecret`, `webhookSecret`, `signingKeyId`, `signingPrivateKey` (all `string | undefined`).

- [ ] **Step 1:** `pnpm add @mux/mux-node`
- [ ] **Step 2:** Create `src/config/mux.config.ts` mirroring `storage.config.ts`:

```ts
import { registerAs } from '@nestjs/config';

export default registerAs('mux', () => ({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
  webhookSecret: process.env.MUX_WEBHOOK_SECRET,
  signingKeyId: process.env.MUX_SIGNING_KEY_ID,
  // base64-encoded PEM, as issued by Mux
  signingPrivateKey: process.env.MUX_SIGNING_PRIVATE_KEY,
}));
```

- [ ] **Step 3:** Add to `EnvironmentVariables` (all `@IsOptional() @IsString()`, one-line style like the `S3_*` block): `MUX_TOKEN_ID?`, `MUX_TOKEN_SECRET?`, `MUX_WEBHOOK_SECRET?`, `MUX_SIGNING_KEY_ID?`, `MUX_SIGNING_PRIVATE_KEY?`.
- [ ] **Step 4:** Register in `app.module.ts`: import `muxConfig` and append to the `load: [...]` array.
- [ ] **Step 5 (test first is impractical here — config only):** extend `env.validation.spec.ts` with two cases: a currently-valid env still validates without any `MUX_*` vars; adding all five as strings validates.
- [ ] **Step 6:** Run: `pnpm run test -- src/config/env.validation.spec.ts` → PASS; `pnpm run build` → clean.

### Task 2: Entities + migration + module skeleton

**Files:**
- Create: `src/cinema/entities/cinema-title.entity.ts`, `src/cinema/entities/watch-progress.entity.ts`
- Create: `src/migrations/1782692600000-AddCinema.ts` (timestamp > latest existing `1782692500000`)
- Create: `src/cinema/cinema.module.ts`
- Modify: `src/app.module.ts` (import `CinemaModule`)

**Interfaces produced:**
- `TitleKind` (`Film='film'`, `Short='short'`), `TitleStatus` (`Draft='draft'`, `AwaitingUpload='awaiting_upload'`, `Processing='processing'`, `Ready='ready'`, `Failed='failed'`)
- `CinemaTitle` fields: `id`, `kind`, `title`, `description|null`, `coverImageUrl|null`, `status`, `errorMessage|null`, `muxUploadId|null`, `muxAssetId|null`, `muxPlaybackId|null`, `pendingMuxUploadId|null`, `pendingMuxAssetId|null`, `durationSeconds|null`, `aspectRatio|null`, `publishedAt|null`, `viewCount`, `createdBy|null`, `createdAt`, `updatedAt`
- `WatchProgress` fields: `id`, `userId`, `titleId`, `positionSeconds`, `viewCountedAt|null`, `updatedAt`; unique `(userId, titleId)`

- [ ] **Step 1:** Write `cinema-title.entity.ts` (follows `user.entity.ts` style — enum columns with `enumName`, `timestamptz`, `@ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' }) @JoinColumn({ name: 'created_by' })` for `createdBy`).
- [ ] **Step 2:** Write `watch-progress.entity.ts` with explicit FK columns for upsert ergonomics:

```ts
@Entity('cinema_watch_progress')
@Unique('UQ_cinema_watch_progress_user_title', ['userId', 'titleId'])
export class WatchProgress {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) userId: string;
  @Column({ type: 'uuid' }) titleId: string;
  @Column({ type: 'integer' }) positionSeconds: number;
  @Column({ type: 'timestamptz', nullable: true }) viewCountedAt: Date | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
```

(plus `@ManyToOne` relations to `User`/`CinemaTitle` with `onDelete: 'CASCADE'` and `@JoinColumn` on the same columns, matching repo relation style)

- [ ] **Step 3:** Write the migration — hand-written SQL in the repo's style (`AddProfileRichDetail` as the model). `up`: create both enum types; create `cinema_titles` (all columns snake_case, `uuid_generate_v4()` defaults, FK `created_by → users ON DELETE SET NULL`); indexes `IDX_cinema_titles_status`, `IDX_cinema_titles_published_at`, partial unique indexes on `mux_upload_id`, `mux_asset_id`, `pending_mux_upload_id`, `pending_mux_asset_id` (`WHERE … IS NOT NULL`); create `cinema_watch_progress` with unique `(user_id, title_id)`, FKs `ON DELETE CASCADE`, index on `title_id`. `down`: drop tables then both enum types, reverse order.
- [ ] **Step 4:** `cinema.module.ts`: `TypeOrmModule.forFeature([CinemaTitle, WatchProgress])`, empty controllers/providers for now; import into `AppModule` after `StorageModule`.
- [ ] **Step 5:** Run: `pnpm run build` → clean. **User step (flagged):** `pnpm run migration:run` against the dev DB.

### Task 3: MuxService (provider wrapper — the only file that touches the SDK)

**Files:**
- Create: `src/cinema/mux.service.ts`
- Test: `src/cinema/mux.service.spec.ts`
- Modify: `src/cinema/cinema.module.ts` (provider + export)

**Interfaces produced (consumed by Tasks 4, 8, 9, 10):**

```ts
type UploadState = { status: string; assetId: string | null };
type AssetState = {
  status: 'preparing' | 'ready' | 'errored';
  playbackId: string | null;      // playback_ids[0] with policy 'signed'
  durationSeconds: number | null; // Math.round(asset.duration)
  aspectRatio: string | null;
  errorMessage: string | null;
};
type PlaybackTokens = {
  hlsUrl: string; posterUrl: string; storyboardUrl: string; expiresAt: Date;
};

class MuxService {
  createDirectUpload(passthrough: string): Promise<{ uploadId: string; uploadUrl: string }>;
  getUpload(uploadId: string): Promise<UploadState>;
  getAsset(assetId: string): Promise<AssetState>;
  deleteAsset(assetId: string): Promise<void>;               // 404 → no-op
  signPlaybackTokens(playbackId: string, durationSeconds: number | null): Promise<PlaybackTokens>;
  verifyWebhook(rawBody: string, headers: Record<string, unknown>): unknown; // parsed event; throws ForbiddenException on bad signature
}
```

Key behavior:
- Lazy client init + `requireConfig` throwing `InternalServerErrorException('Mux is not configured (missing …)')` — exact `StorageService` precedent.
- `createDirectUpload`: `mux.video.uploads.create({ cors_origin: <app.frontendUrl config, default http://localhost:5173>, new_asset_settings: { playback_policy: ['signed'], video_quality: 'basic', passthrough } })`.
- **TTL rule (spec §7):** `ttlSeconds = min(max((durationSeconds ?? 0) + 1800, 3600), 43200)`; `expiration: `${ttlSeconds}s``; token types `video`/`thumbnail`/`storyboard`; URLs `https://stream.mux.com/{id}.m3u8?token=…`, `https://image.mux.com/{id}/thumbnail.webp?token=…`, `https://image.mux.com/{id}/storyboard.vtt?token=…`.
- `verifyWebhook`: `mux.webhooks.unwrap(rawBody, headers)` with `webhookSecret` from config; any SDK error → `ForbiddenException('Invalid webhook signature')`.

- [ ] **Step 1 (failing tests first):** `mux.service.spec.ts` — generate a real RSA keypair once (`node:crypto generateKeyPairSync('rsa', { modulusLength: 2048 })`), base64-encode the PEM into a mocked `ConfigService`. Cases:
  - `signPlaybackTokens` for a 7,200 s title → decode each JWT payload (`Buffer.from(token.split('.')[1], 'base64url')`): `sub` = playbackId; `aud` = `v`/`t`/`s` respectively; `exp - iat ≈ 9000` (duration + 30 min).
  - TTL clamps: `durationSeconds = 600` → 3,600 s floor; `durationSeconds = 86_400` → 43,200 s cap; `null` → 3,600 s.
  - `expiresAt` matches the video token's `exp` (±2 s).
  - Missing `mux.signingKeyId` → `InternalServerErrorException`.
  - `deleteAsset` swallows a 404-shaped SDK error, rethrows a 500-shaped one (inject a mock client via a test seam: `(service as any).client = fakeMux`).
- [ ] **Step 2:** Run `pnpm run test -- src/cinema/mux.service.spec.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `mux.service.ts`.
- [ ] **Step 4:** Run same command → PASS. `pnpm run build` → clean.

### Task 4: Member read side + entitlement + playback session

**Files:**
- Create: `src/cinema/cinema.service.ts`, `src/cinema/title-response.ts`, `src/cinema/titles.controller.ts`
- Test: `src/cinema/cinema.service.spec.ts`
- Modify: `src/cinema/cinema.module.ts`

**Interfaces produced:**

```ts
class CinemaService {
  listTitles(user: CurrentUserData, includeAll: boolean): Promise<TitleListItem[]>;
  getTitle(user: CurrentUserData, id: string): Promise<TitleDetail>;
  createPlaybackSession(user: CurrentUserData, id: string): Promise<PlaybackSession>;
}
type PlaybackSession = {
  hlsUrl: string; posterUrl: string; storyboardUrl: string; expiresAt: Date;
  resumePositionSeconds: number; durationSeconds: number | null;
};
```

Entitlement rules (spec §6 — all enforced in `CinemaService`, guards handle authn/active-status):
- Member sees/plays only `status = ready AND publishedAt IS NOT NULL`; moderators/admins also see drafts and play unpublished `ready` titles.
- `listTitles(user, includeAll=true)` throws `ForbiddenException` unless moderator/admin; otherwise returns all statuses.
- Resume: latest `WatchProgress.positionSeconds`, but `>= 97%` of duration → `0`. No progress row → `0`.
- Playback responses include `Cache-Control: no-store` (set via `@Header` on the controller method).

Controller (`@Controller('cinema/titles')`, follows `join-requests.controller.ts` style):
- `GET /` `@UseGuards(ActiveMemberGuard)` — query `?all=true` via a small `ListTitlesQuery` DTO (`@IsOptional() @IsBooleanString()`)
- `GET /:id` `@UseGuards(ActiveMemberGuard)` + `ParseUUIDPipe`
- `POST /:id/playback` `@UseGuards(ActiveMemberGuard)` `@Header('Cache-Control', 'no-store')`

`title-response.ts` maps entities → API shapes (repo's `*-response.ts` pattern): list item exposes `id, kind, title, description, coverImageUrl, durationSeconds, publishedAt, viewCount, myProgress: { positionSeconds, finished } | null`; detail adds `status/errorMessage` for mod callers only.

- [ ] **Step 1 (failing tests):** `cinema.service.spec.ts` with mocked repositories (vouch spec pattern). Entitlement matrix:
  - member + published ready → playback session returned (assert MuxService mock called with playbackId + duration, resume merged in)
  - member + unpublished ready → `NotFoundException` (don't leak existence)
  - member + published-but-not-ready (processing) → `NotFoundException`
  - moderator + unpublished ready → session returned
  - title without `muxPlaybackId` → `ConflictException` (defensive)
  - resume: progress at 7,000/7,200 s (>97%) → `resumePositionSeconds: 0`; at 1,284 s → `1284`
  - `listTitles(member, includeAll=true)` → `ForbiddenException`; `(moderator, true)` → repo queried without publish filter
- [ ] **Step 2:** Run `pnpm run test -- src/cinema/cinema.service.spec.ts` → FAIL.
- [ ] **Step 3:** Implement service + response mapper + controller; wire module.
- [ ] **Step 4:** Tests PASS; `pnpm run build` clean.
- [ ] **User verification step (flagged):** after Mux account exists, manually `INSERT INTO cinema_titles (kind, title, status, mux_asset_id, mux_playback_id, duration_seconds, published_at) VALUES ('film', 'Test', 'ready', '<asset>', '<signed playback id>', <dur>, now());` then `POST /cinema/titles/<id>/playback` with a member cookie and confirm the `hlsUrl` plays in hls.js. This validates the whole playback path before any ingest code exists.

### Task 5: Watch progress + view count

**Files:**
- Create: `src/cinema/dto/report-progress.dto.ts`
- Modify: `src/cinema/cinema.service.ts`, `src/cinema/titles.controller.ts`
- Test: extend `src/cinema/cinema.service.spec.ts`

**Interfaces produced:** `reportProgress(user: CurrentUserData, titleId: string, positionSeconds: number): Promise<{ positionSeconds: number; viewCounted: boolean }>`; route `PUT /cinema/titles/:id/progress` (ActiveMemberGuard). DTO: `positionSeconds` `@IsInt() @Min(0) @Max(1_000_000)`.

Rules (spec §8):
- Title must be visible to the caller (same entitlement as playback).
- Reject `positionSeconds > durationSeconds + 5` with `BadRequestException` (skip check when duration null).
- Upsert on `(userId, titleId)` via query-builder `insert().orUpdate(['position_seconds', 'updated_at'], 'UQ_cinema_watch_progress_user_title')` (or repository `upsert`).
- View threshold `min(60, ceil(duration * 0.5))` (duration null → 60). When crossed, inside `dataSource.transaction`: `UPDATE cinema_watch_progress SET view_counted_at = now() WHERE user_id=… AND title_id=… AND view_counted_at IS NULL`; **only if** `affected === 1`, `manager.increment(CinemaTitle, { id }, 'viewCount', 1)` — the null-guarded UPDATE makes racing reports count exactly once.

- [ ] **Step 1 (failing tests):** crossing threshold first time → increments + `viewCounted: true`; second report past threshold (`affected: 0`) → no increment; below threshold → no transaction; 30 s short film → threshold 15 s; position 7,300 s on 7,200 s film → `BadRequestException`; suspended-from-view title (unpublished, member) → `NotFoundException`.
- [ ] **Step 2:** FAIL run → implement → PASS run → `pnpm run build`.

### Task 6: Admin CRUD (create/edit/publish/delete)

**Files:**
- Create: `src/cinema/dto/create-title.dto.ts`, `src/cinema/dto/update-title.dto.ts`, `src/cinema/admin-titles.controller.ts`
- Modify: `src/cinema/cinema.service.ts`, `src/cinema/cinema.module.ts`
- Test: extend `src/cinema/cinema.service.spec.ts`

**Interfaces produced:**

```ts
createTitle(user: CurrentUserData, dto: CreateTitleDto): Promise<TitleDetail>;   // status Draft
updateTitle(user: CurrentUserData, id: string, dto: UpdateTitleDto): Promise<TitleDetail>;
deleteTitle(id: string): Promise<void>;
```

- DTOs: `CreateTitleDto` — `kind` `@IsEnum(TitleKind)`; `title` `@IsString() @IsNotEmpty() @MaxLength(200)`; `description?` `@IsOptional() @IsString() @MaxLength(5000)`; `coverImageUrl?` `@IsOptional() @IsString() @MaxLength(2048)`. `UpdateTitleDto extends PartialType(CreateTitleDto)` (repo already uses `@nestjs/mapped-types`) plus `published?: boolean` `@IsOptional() @IsBoolean()`.
- Publish rule: `published: true` requires `status === Ready` else `BadRequestException('Title is not ready to publish')`; sets `publishedAt = new Date()` (no-op if already published). `published: false` → `publishedAt = null`.
- Delete: best-effort `MuxService.deleteAsset` for `muxAssetId` **and** `pendingMuxAssetId`, then remove row (progress rows cascade).
- Controller `@Controller('cinema/titles')` methods with `@UseGuards(RolesGuard) @Roles(UserRole.Moderator, UserRole.Admin)` per route (`POST /`, `PATCH /:id`, `DELETE /:id`) — same file pattern as `join-requests.controller.ts`; keep it a separate `AdminTitlesController` class for clarity.

- [ ] **Step 1 (failing tests):** publish on `processing` → BadRequest; publish on `ready` → `publishedAt` set; unpublish clears it; delete calls `deleteAsset` for both asset columns and removes the row; create returns `Draft` with `createdBy` set.
- [ ] **Step 2:** FAIL → implement → PASS → build.

### Task 7: `@SkipCsrf()` + rawBody (webhook prerequisites)

**Files:**
- Create: `src/security/skip-csrf.decorator.ts`
- Modify: `src/security/csrf.guard.ts`, `src/main.ts`
- Test: `src/security/csrf.guard.spec.ts` (new)

**Interfaces produced:** `@SkipCsrf()` route decorator; `NestFactory.create(AppModule, { rawBody: true })` making `req.rawBody` available.

- [ ] **Step 1:** Decorator (exact `public.decorator.ts` shape):

```ts
import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_KEY = 'skipCsrf';
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
```

- [ ] **Step 2 (failing tests):** `csrf.guard.spec.ts` — construct the guard with a stubbed `Reflector` and a fake `ExecutionContext`; cases: GET passes; POST without tokens throws `ForbiddenException` (locks in existing behavior); POST with matching cookie+header passes; POST without tokens on a `@SkipCsrf()` route (reflector returns `true`) passes.
- [ ] **Step 3:** Modify `CsrfGuard`: inject `Reflector`; before the token check, `if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [context.getHandler(), context.getClass()])) return true;`. Add `{ rawBody: true }` to `NestFactory.create` in `main.ts`.
- [ ] **Step 4:** `pnpm run test -- src/security/csrf.guard.spec.ts` PASS; `pnpm run build` clean; also run the full suite once (`pnpm run test`) since this touches a global guard.

### Task 8: Ingest — upload-URL minting + state machine core

**Files:**
- Modify: `src/cinema/cinema.service.ts`, `src/cinema/admin-titles.controller.ts`
- Test: extend `src/cinema/cinema.service.spec.ts`

**Interfaces produced:**

```ts
requestUpload(id: string): Promise<{ uploadUrl: string; uploadId: string }>;  // POST /cinema/titles/:id/upload (Mod)
// state-transition methods shared by webhook (Task 9) and reconciliation (Task 10):
onUploadAssetCreated(uploadId: string, assetId: string): Promise<void>;
onAssetReady(assetId: string, meta: { playbackId: string | null; durationSeconds: number | null; aspectRatio: string | null }): Promise<void>;
onAssetErrored(assetId: string, message: string): Promise<void>;
onUploadFailed(uploadId: string, message: string): Promise<void>;
```

Transition rules (spec §4 — all idempotent, unknown ids silently ignored):
- `requestUpload`: `draft`/`awaiting_upload`/`failed` → mint upload (`passthrough = title.id`), store `muxUploadId`, status → `awaiting_upload`, clear `errorMessage`, best-effort delete an orphaned failed `muxAssetId`. `ready` → replacement: store `pendingMuxUploadId` (title stays published/playable). `processing` → `ConflictException('Upload already processing')`.
- `onUploadAssetCreated`: match `muxUploadId` → set `muxAssetId`, status → `processing`; match `pendingMuxUploadId` → set `pendingMuxAssetId`. Already-set same value → no-op.
- `onAssetReady`: match `muxAssetId` → set `muxPlaybackId`/`durationSeconds`/`aspectRatio`, status → `ready`. Match `pendingMuxAssetId` → **swap**: best-effort delete old `muxAssetId` via MuxService, promote pending ids into the main columns, update playback metadata, clear both `pending_*`, keep `publishedAt` untouched. Replay after swap (ids already promoted) → no-op.
- `onAssetErrored`: main asset → status `failed` + `errorMessage`. Pending asset → clear `pending_*`, append error to `errorMessage`, **status/publish state of the live asset unchanged**.
- `onUploadFailed`: same shape, matching by upload id (covers `video.upload.errored` / `cancelled`).

- [ ] **Step 1 (failing tests):** one test per rule above, incl. the swap (old asset deleted, ids promoted, `publishedAt` preserved), idempotent replay, unknown-id no-op, `processing` conflict.
- [ ] **Step 2:** FAIL → implement → PASS → build.

### Task 9: Mux webhook endpoint

**Files:**
- Create: `src/cinema/webhooks.controller.ts`
- Test: `src/cinema/webhooks.controller.spec.ts`
- Modify: `src/cinema/cinema.module.ts`

**Consumes:** `MuxService.verifyWebhook`, Task 8 transition methods, Task 7 decorators.

```ts
@Controller('cinema/webhooks')
export class CinemaWebhooksController {
  @Public()
  @SkipCsrf()
  @Post('mux')
  @HttpCode(200)
  async handleMux(@Req() req: RawBodyRequest<Request>) { … }
}
```

Behavior: `rawBody` missing → `BadRequestException`; `verifyWebhook(req.rawBody.toString('utf8'), req.headers)` (throws 403 on bad signature); dispatch on `event.type`:
`video.upload.asset_created` → `onUploadAssetCreated(event.data.id, event.data.asset_id)`; `video.asset.ready` → `onAssetReady(event.data.id, { playbackId: event.data.playback_ids?.[0]?.id ?? null, durationSeconds: event.data.duration != null ? Math.round(event.data.duration) : null, aspectRatio: event.data.aspect_ratio ?? null })`; `video.asset.errored` → `onAssetErrored(event.data.id, <joined error messages>)`; `video.upload.errored` / `video.upload.cancelled` → `onUploadFailed(event.data.id, event.type)`; anything else → acknowledged no-op. Always returns `{ received: true }`.

- [ ] **Step 1 (failing tests):** controller unit test with mocked `MuxService`/`CinemaService`: bad signature → `ForbiddenException` propagates and **no transition method is called**; each of the five event types dispatches with exactly the mapped arguments; unknown type → `{ received: true }`, nothing called; missing `rawBody` → `BadRequestException`.
- [ ] **Step 2:** FAIL → implement → PASS → build.
- [ ] **User verification step (flagged):** with the tunnel + Mux webhook configured, upload a real short file end-to-end (Task 8 endpoint → browser PUT → webhooks arrive → title becomes `ready`).

### Task 10: Reconciliation cron + admin refresh + Bruno collection

**Files:**
- Create: `src/cinema/cinema-reconciliation.service.ts`
- Modify: `src/cinema/admin-titles.controller.ts` (`POST /:id/refresh`), `src/cinema/cinema.module.ts`
- Create: `bruno/Cinema/*.bru` (one request per endpoint, mirroring existing folders)
- Test: `src/cinema/cinema-reconciliation.service.spec.ts`

**Interfaces produced:** `refreshTitle(id: string): Promise<TitleDetail>`; `@Cron(CronExpression.EVERY_HOUR) reconcile(): Promise<void>`.

Behavior: `reconcile()` selects titles where (`status IN ('awaiting_upload','processing')` OR `pending_mux_upload_id IS NOT NULL` OR `pending_mux_asset_id IS NOT NULL`) AND `updated_at < now() − 15 min`; for each, `refreshTitle` polls Mux (`getUpload` for upload-stage ids, `getAsset` once an asset id exists) and feeds results through the **same Task 8 transition methods** — no second state machine. Errors per title are caught and logged (`Logger`, repo convention), never abort the loop. Skips entirely when Mux config is absent.

- [ ] **Step 1 (failing tests):** stuck `awaiting_upload` whose upload now has an asset → `onUploadAssetCreated` invoked; stuck `processing` whose asset is `ready` → `onAssetReady` invoked with mapped meta; asset `errored` → `onAssetErrored`; Mux error on one title doesn't prevent processing the next; fresh titles (< 15 min) untouched.
- [ ] **Step 2:** FAIL → implement (service + controller route) → PASS → build.
- [ ] **Step 3:** Write Bruno requests (`Cinema/List Titles.bru`, `Get Title.bru`, `Create Playback Session.bru`, `Report Progress.bru`, `Create Title.bru`, `Update Title.bru`, `Delete Title.bru`, `Request Upload.bru`, `Refresh Title.bru`) copying auth/header conventions from `bruno/Events`.

### Task 11: E2e — guard wiring + webhook CSRF exemption

**Files:**
- Create: `test/cinema.e2e-spec.ts`

**Consumes:** full app; runs against a real Postgres (`DATABASE_URL`), like `auth-invite-gate.e2e-spec.ts`.

Cases: `GET /cinema/titles` without auth cookie → 401; `POST /cinema/titles/:id/playback` without CSRF header → 403 (CSRF fires before JWT); `POST /cinema/webhooks/mux` with garbage body and no CSRF/cookies → **403 from signature check, not CSRF** (assert error message is the webhook one — proves `@SkipCsrf` works); as an active member (seeded via DataSource like the existing e2e) `GET /cinema/titles` → 200 with published-only list.

- [ ] **Step 1:** Write the spec file.
- [ ] **Step 2:** `pnpm run build` clean. **User-run (flagged):** `pnpm run test:e2e -- cinema` needs a live DB; unit suites in Tasks 1–10 don't.

---

## Self-review notes

- Spec coverage: §2/§3 need no code; §4 → Tasks 8–10; §5 → Tasks 3–4 (tokens, no-store) with the rest inherent to the architecture; §6 → Task 4; §7 → Tasks 3–4; §8 → Task 5; §9 → Task 2; §10 → Tasks 4, 6, 7, 8, 9; §11 → Task 1; §13 → all; §14 → tests within each task + Task 11.
- Sequencing honors the owner's requirement: Tasks 2–5 deliver entitlement + signed playback end-to-end on a manually seeded asset (Task 4 user step) before any ingest machinery (Tasks 8–10).
- Names used across tasks were cross-checked: `TitleStatus.AwaitingUpload`, transition method names, `UQ_cinema_watch_progress_user_title`, `PlaybackTokens`/`PlaybackSession` shapes.
