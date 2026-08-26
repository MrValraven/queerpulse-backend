import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UnauthorizedException,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
// A ban is a permanent suspension (`AccountEnforcementService` sets
// `status = Suspended`, `suspendedUntil = null` for both `suspend` and `ban`),
// so gating on `Suspended` covers both — there is no separate `Banned` status.
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { PRESIGN_EXPIRY_SECONDS, StorageService } from './storage.service';
import { parseStorageKey, storageKeyOwnerId } from './storage-key';
import { UPLOAD_KIND_SPECS } from './upload-kinds';
import { Message } from '../messaging/entities/message.entity';
import {
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// `max-age` is deliberately SHORTER than `PRESIGN_EXPIRY_SECONDS`. At equal
// values a cached 302 replayed just before expiry hands the browser a
// presigned URL with a second of life left, and clock skew turns that into
// intermittently broken images. The 60s margin is the safety buffer against
// that skew, derived from the real TTL so the two can never drift apart —
// previously this was a bare literal (240) with only a comment tying it to
// the TTL, so changing the TTL would silently break the invariant.
const PUBLIC_IMAGE_MAX_AGE_SECONDS = PRESIGN_EXPIRY_SECONDS - 60;

// Railway Buckets are private and expose no public URL, so every uploaded image
// is reached through here. This route does NOT proxy bytes: it authorizes, then
// 302s to a short-lived presigned GET, and the browser fetches from the bucket
// directly. No service egress, one signature per image load.
//
// It works with a plain `<img src>` because the session is an httpOnly cookie
// (`jwt.strategy.ts`), not a Bearer header — browsers attach cookies to image
// requests. The cookie is SameSite=Lax, so this depends on the frontend and API
// being same-site, which the session already requires.
//
// Images are inert (never executed), already authorized per-kind below, and a
// lockdown that blanks the admin console's own avatars/photos would prevent
// the person lifting the lockdown from confirming who they are looking at —
// so this route stays reachable while `PlatformLockdownGuard` is active.
@LockdownExempt()
@ApiTags('Files')
// Version-neutral: the URLs that reach this route are built as bare
// `${API_URL}/files/<key>` (see `common/image-url.ts` `toImageUrl`) and rendered
// as raw `<img src>`, which never pass through the `/v1`-injecting API client.
// Without this opt-out, global URI versioning (`main.ts`) would only expose the
// route at `/v1/files/*` and every image would 404.
@Controller({ path: 'files', version: VERSION_NEUTRAL })
export class FilesController {
  constructor(
    private readonly storage: StorageService,
    @InjectRepository(User) private readonly users: Repository<User>,
    // Registered via `StorageModule`'s own `forFeature([Message])` (mirroring
    // the `User` copy above) purely so this route can answer "is the requester a
    // participant of a conversation that references this `message-image` key?"
    // — a direct repository query, NOT an import of `MessagingModule`, so no
    // module cycle is introduced.
    @InjectRepository(Message) private readonly messages: Repository<Message>,
  ) {}

  // Per-process memo of keys that have already passed the magic-byte check
  // (security review M2). Validation reads the object's first bytes once; every
  // later serve of the same key skips the read. Only PASSES are cached: a
  // `mismatch` re-checks (cheap, and it will keep failing) and a transient
  // `indeterminate` never poisons the cache. Bounded so a long-lived process
  // that serves many distinct keys can't grow it without limit — at the cap the
  // whole set is cleared (a simple, allocation-free eviction; the worst case is
  // that recently-validated keys pay one more read).
  private static readonly VALIDATED_KEY_CACHE_LIMIT = 5000;
  private static readonly validatedKeys = new Set<string>();

  // True when a message referencing this `message-image` key lives in a
  // conversation the requester participates in. A left member keeps a
  // participant row (see `ConversationParticipant.leftAt`) and retains read
  // access to history, so mere row existence is the correct grant; a
  // soft-deleted message is excluded (its image is gone from the timeline). The
  // stored `attachment.url` is the BARE key (the send path normalises it via
  // `storageKeyFromImageUrl`); the `/files/<key>` form is matched too as a
  // defensive belt against any legacy row that stored the resolved URL.
  private async isMessageImageParticipant(
    storageKey: string,
    userId: string,
  ): Promise<boolean> {
    const attachmentForms = [storageKey, `/files/${storageKey}`];
    // `message.<property>` uses entity property names so TypeORM maps them to
    // the snake_case columns; `participant.*` references the raw joined table's
    // real column names (that alias is a table name, not a registered entity).
    return this.messages
      .createQueryBuilder('message')
      .innerJoin(
        'conversation_participants',
        'participant',
        'participant.conversation_id = message.conversationId AND participant.user_id = :userId',
        { userId },
      )
      .where("message.attachment ->> 'url' IN (:...attachmentForms)", {
        attachmentForms,
      })
      .andWhere('message.deletedAt IS NULL')
      .getExists();
  }

  // Verify the object's real bytes match the image type its key declares before
  // it is ever served (security review M2), memoising passes. On a definite
  // `mismatch` the object is refused with the same 404 as any other unresolvable
  // key (no existence leak). On `indeterminate` (a transient storage/read error)
  // this FAILS OPEN and serves: the bytes are inert, the presigned GET already
  // forces the correct `image/*` content type, and blanking every image on a
  // blip of the bucket is a worse failure than deferring one validation.
  private async assertServableBytes(storageKey: string): Promise<void> {
    if (FilesController.validatedKeys.has(storageKey)) {
      return;
    }
    const verdict = await this.storage.validateImageMagicBytes(storageKey);
    if (verdict === 'mismatch') {
      throw new NotFoundException();
    }
    if (verdict === 'valid') {
      if (
        FilesController.validatedKeys.size >=
        FilesController.VALIDATED_KEY_CACHE_LIMIT
      ) {
        FilesController.validatedKeys.clear();
      }
      FilesController.validatedKeys.add(storageKey);
    }
  }

  // The owner status whose media is withheld from ordinary viewers — the
  // moderation-imposed suspend/ban state (both set `Suspended`). A member the
  // platform has acted against should not keep an avatar/photo serving to
  // everyone. Deactivation (a member's own "pause my account") is deliberately
  // NOT withheld here: it is member-initiated and fully reversible on their own
  // next login, and the profile surfaces that read it already gate on
  // `status = active` elsewhere.
  private static isStaffViewer(user: CurrentUserData | null): boolean {
    return user?.role === UserRole.Admin || user?.role === UserRole.Moderator;
  }

  // `@Public()` bypasses the global JwtAuthGuard; OptionalJwtAuthGuard then
  // populates the user when a valid cookie is present without rejecting when it
  // is not. CsrfGuard exempts GET, so no token is needed.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get('*key')
  @ApiOperation({
    summary: 'Resolve a storage key to a short-lived presigned download (302)',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a short-lived presigned GET URL for the object.',
  })
  @ApiUnauthorizedResponse({
    description: 'A session-gated kind was requested without a valid session.',
  })
  @ApiNotFoundResponse({
    description:
      'Malformed key, unknown prefix, or a session-gated object owned by another member (never discloses which keys exist).',
  })
  async serve(
    // Under Express 5 / path-to-regexp 8, a named wildcard (`*key`) makes Nest
    // hand back an ARRAY of decoded path segments, not a joined string — for
    // `/files/avatars/<uuid>/<uuid>.jpg` this is
    // `["avatars", "<uuid>", "<uuid>.jpg"]`. Do not annotate this as `string`;
    // that lie is exactly what let this route 404 on every real request.
    @Param('key') rawKey: string | string[],
    @CurrentUser() user: CurrentUserData | null,
    @Res() response: Response,
  ): Promise<void> {
    // Re-join the segments path-to-regexp split apart. This is safe: the
    // anchored UUID regex in `parseStorageKey` still rejects a `%2F`-smuggled
    // segment, so no extra sanitising or re-decoding belongs here.
    const storageKey = Array.isArray(rawKey) ? rawKey.join('/') : rawKey;
    const kindSpec = parseStorageKey(storageKey);
    // A malformed key, an unknown prefix, and a probe all 404 identically —
    // never 401 — so the route never discloses which keys exist.
    if (!kindSpec) {
      throw new NotFoundException();
    }
    if (kindSpec.requiresSession) {
      if (!user) {
        throw new UnauthorizedException();
      }
      if (kindSpec === UPLOAD_KIND_SPECS['message-image']) {
        // A DM image attachment (security review M7). Unlike the uploader-only
        // kinds below, its whole point is that the RECIPIENT must load it too,
        // so it is scoped to conversation PARTICIPANTS: serve only when the
        // requester participates in a conversation holding a (non-deleted)
        // message that references this key. A caller who merely holds the URL
        // (leaked via referrer, proxy log, forwarded link) is not a participant
        // and gets the same 404 as any unresolvable key.
        if (!(await this.isMessageImageParticipant(storageKey, user.userId))) {
          throw new NotFoundException();
        }
      } else if (storageKeyOwnerId(storageKey) !== user.userId) {
        // A session alone is NOT enough for the uploader-only session-gated
        // kinds. The key embeds the id of the member who uploaded it
        // (`storageKeyOwnerId`), and there is no photo↔event table yet that
        // could scope a gathering photo to an event's participants — so without
        // an ownership check any logged-in member could walk
        // `gathering-photos/<anyUserId>/<uuid>.<ext>` and pull identifiable
        // photos of people at events they never attended (IDOR). Restrict such a
        // photo to its uploader; 404 (not 403) so the route still never reveals
        // which keys exist. Widen this to event participants once gathering
        // photos are linked to an event.
        throw new NotFoundException();
      }
    }
    // Suspension media safety: a suspended/banned member's media must not keep
    // serving to ordinary viewers. Every key embeds its owner's userId
    // (`<prefix>/<ownerId>/<uuid>.<ext>`), so we resolve that owner's status and
    // 404 (never a distinct code — same don't-leak posture as the checks above)
    // when they are withheld. Skipped — no lookup at all — when the viewer is
    // the owner (they may always see their own media) or platform staff
    // (admins/mods must still review it), so this only costs a single indexed
    // status read on the cross-member view of a possibly-actioned member.
    const ownerUserId = storageKeyOwnerId(storageKey);
    if (
      ownerUserId &&
      ownerUserId !== user?.userId &&
      !FilesController.isStaffViewer(user)
    ) {
      const owner = await this.users.findOne({
        where: { id: ownerUserId },
        select: ['id', 'status'],
      });
      if (owner && owner.status === UserStatus.Suspended) {
        throw new NotFoundException();
      }
    }
    // Content-type backstop (M2): verify the object's real bytes match the
    // image type its key declares before handing back a download URL. Runs after
    // authorization so an unauthorized caller never triggers a bucket read, and
    // memoises passes so a hot avatar is validated once per process.
    await this.assertServableBytes(storageKey);
    const downloadUrl = await this.storage.createPresignedDownload(storageKey);
    // Railway's edge cache once served authenticated responses to the wrong
    // users (incident 2026-03-30), so shared/CDN caches are refused on every
    // kind via `private` — that half is non-negotiable. Browser-local caching
    // is safe to allow for kinds that never require a session (avatars, work
    // images, story covers): the response is the same for every viewer, and
    // caching stops a page of avatars from burning a quarter of the per-IP
    // rate-limit budget on every view. Session-gated kinds (gathering photos)
    // keep `no-store` since the response is specific to who is asking.
    response.setHeader(
      'Cache-Control',
      kindSpec.requiresSession
        ? 'private, no-store'
        : `private, max-age=${PUBLIC_IMAGE_MAX_AGE_SECONDS}`,
    );
    // Best-effort `nosniff` on the 302 (security review L12). The bytes are
    // fetched from the bucket by the browser following this redirect, so the
    // bucket's own response headers are what ultimately govern sniffing; S3
    // exposes no way to sign `X-Content-Type-Options` into a presigned GET. The
    // authoritative defense is therefore the forced `ResponseContentType` on the
    // presigned URL (see `createPresignedDownload`) plus the magic-byte check
    // above; this header hardens the redirect response itself as defense in
    // depth for any client that honours it on the 302.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.redirect(302, downloadUrl);
  }
}
