import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { buildDocumentDownloadHeaders } from './document-download-headers';
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
// The one exception is a `message-document` (PRD-369): it is streamed through
// this service with download-only, sandboxed headers, because a presigned GET
// cannot carry `Content-Security-Policy` or `nosniff`. See
// `streamMessageDocument`.
//
// It works with a plain `<img src>` because the session travels as an httpOnly
// cookie (`jwt.strategy.ts`) rather than a Bearer header, and browsers attach
// cookies to image requests. The cookie is SameSite=Lax, so it only rides along
// when the app and this API share a site. Nothing here asserts that topology
// from memory: `security/csrf.guard.ts` derives it by comparing the configured
// `FRONTEND_URL` origins against `API_URL`, and uses the same verdict to decide
// whether it may enforce `Sec-Fetch-Site`. Serving the app from another site
// would break these images and the session in one stroke, so the two questions
// have one answer and one place that computes it.
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

  // True when a message referencing this `message-image` OR `message-document`
  // key lives in a conversation the requester participates in. Shared by both
  // kinds (see the `message-document` branch in `serve()`) since both store
  // their attachment key under the SAME `message.attachment ->> 'url'` jsonb
  // path — a document is not merely as protected as an image here, it goes
  // through the IDENTICAL query. A left member keeps a participant row (see
  // `ConversationParticipant.leftAt`) and retains read access to history, so
  // mere row existence is the correct grant; a soft-deleted message is
  // excluded (its attachment is gone from the timeline). The stored
  // `attachment.url` is the BARE key (the send path normalises it via
  // `storageKeyFromImageUrl`); the `/files/<key>` form is matched too as a
  // defensive belt against any legacy row that stored the resolved URL.
  private async isMessageAttachmentParticipant(
    storageKey: string,
    userId: string,
  ): Promise<boolean> {
    const attachmentForms = [storageKey, `/files/${storageKey}`];
    // `message.<property>` uses entity property names so TypeORM maps them to
    // the snake_case columns; `participant.*` references the raw joined table's
    // real column names (that alias is a table name, not a registered entity).
    //
    // The `attachment IS NOT NULL` clause is redundant on its own (a NULL
    // `attachment` can never match the `->>` test), but it is what lets the
    // planner use the PARTIAL index `IDX_messages_attachment_url`, declared
    // `WHERE attachment IS NOT NULL` so it stays tiny on a table where almost
    // no row carries an attachment. Postgres does not infer that implication
    // by itself.
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
      .andWhere('message.attachment IS NOT NULL')
      .getExists();
  }

  // Verify the object's real bytes match the content type its key declares
  // before it is ever served (security review M2; covers both an image and a
  // `message-document` key — see `magicBytesMatchContentType`), memoising
  // passes. On a definite `mismatch` the object is refused with the same 404 as
  // any other unresolvable key (no existence leak). On `indeterminate` (a
  // transient storage/read error) this FAILS OPEN and serves: the bytes are
  // inert either way (an image is never executed; a document is streamed as a
  // sandboxed attachment download, see `streamMessageDocument`), the served
  // content type is forced from the key's extension, and blanking every object
  // on a blip of the bucket is a worse failure than deferring one validation.
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

  private readonly logger = new Logger(FilesController.name);

  // A missing object surfaces as `NoSuchKey` from GetObject and `NotFound` from
  // HeadObject; the SDK's `$metadata.httpStatusCode` covers both shapes.
  private static isMissingObjectError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const candidate = error as {
      name?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    return (
      candidate.name === 'NoSuchKey' ||
      candidate.name === 'NotFound' ||
      candidate.$metadata?.httpStatusCode === 404
    );
  }

  // The member-supplied display name of a document (`attachment.fileName`),
  // used only to name the download. Runs after authorization, so the caller is
  // already entitled to the bytes and sees this name in the bubble anyway. The
  // name is cosmetic: any failure falls back to the server-minted `<uuid>.<ext>`
  // rather than failing the download.
  private async documentDisplayFileName(
    storageKey: string,
  ): Promise<string | null> {
    const attachmentForms = [storageKey, `/files/${storageKey}`];
    try {
      const row = await this.messages
        .createQueryBuilder('message')
        .select("message.attachment ->> 'fileName'", 'fileName')
        .where("message.attachment ->> 'url' IN (:...attachmentForms)", {
          attachmentForms,
        })
        .andWhere('message.deletedAt IS NULL')
        // Same partial-index predicate as `isMessageAttachmentParticipant`,
        // for the same reason: see that method's note.
        .andWhere('message.attachment IS NOT NULL')
        .orderBy('message.createdAt', 'ASC')
        .limit(1)
        .getRawOne<{ fileName: string | null }>();
      return row?.fileName ?? null;
    } catch (error) {
      this.logger.warn(
        `Document name lookup failed for ${storageKey}: ${String(error)}`,
      );
      return null;
    }
  }

  // PRD-369 decision record. A document comes from another member, so it is
  // treated as hostile active content and must never render inline in the
  // QueerPulse origin or the bucket origin. It is streamed through the backend
  // (a presigned GET cannot carry CSP or nosniff) with the headers built in
  // `document-download-headers.ts`: attachment disposition, a `sandbox` CSP,
  // nosniff, same-origin CORP, no-store, and text types served as opaque bytes.
  //
  // Deliberately out of scope by product decision: no malware scanner, no PDF
  // content stripping or flattening, and no new infrastructure. A scanner later
  // would need: a quarantine state on the object (for example a `pending-scan`
  // prefix or a tag the upload path sets), an async scan worker (ClamAV or a
  // hosted API) triggered on upload, a verdict persisted next to the message
  // attachment, and this branch refusing to stream anything not marked clean.
  //
  // HEAD is answered from `HeadObject` without opening the body. A missing
  // object is a 404. After headers are committed a stream failure cannot change
  // the status, so `pipeline` destroys both streams and the client sees a broken
  // transfer; a client abort destroys the bucket stream the same way.
  private async streamMessageDocument(
    storageKey: string,
    response: Response,
  ): Promise<void> {
    const originalFileName = await this.documentDisplayFileName(storageKey);
    const headers = buildDocumentDownloadHeaders({
      storageKey,
      originalFileName,
    });

    if (response.req.method === 'HEAD') {
      let contentLength: number | null;
      try {
        ({ contentLength } = await this.storage.headObject(storageKey));
      } catch (error) {
        if (FilesController.isMissingObjectError(error)) {
          throw new NotFoundException();
        }
        throw error;
      }
      for (const [headerName, headerValue] of Object.entries(headers)) {
        response.setHeader(headerName, headerValue);
      }
      if (contentLength !== null) {
        response.setHeader('Content-Length', String(contentLength));
      }
      response.status(200).end();
      return;
    }

    let body: Readable;
    try {
      body = await this.storage.openObjectStream(storageKey);
    } catch (error) {
      if (FilesController.isMissingObjectError(error)) {
        throw new NotFoundException();
      }
      throw error;
    }
    // Set last so these replace the global helmet CSP and CORP for this
    // response only.
    for (const [headerName, headerValue] of Object.entries(headers)) {
      response.setHeader(headerName, headerValue);
    }
    response.status(200);
    try {
      await pipeline(body, response);
    } catch (error) {
      const isClientAbort =
        (error as { code?: unknown } | null)?.code ===
        'ERR_STREAM_PREMATURE_CLOSE';
      if (!isClientAbort) {
        this.logger.warn(
          `Document stream failed for ${storageKey}: ${String(error)}`,
        );
      }
    }
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
  @ApiResponse({
    status: 200,
    description:
      'A message document, streamed as a sandboxed attachment download (never redirected).',
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
    // `?download=1` signs an `attachment` disposition so a top-level navigation
    // saves the image instead of rendering it (the chat viewer's Save button).
    // It changes nothing about who may read the object.
    @Query('download') download?: string,
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
      if (
        kindSpec === UPLOAD_KIND_SPECS['message-image'] ||
        kindSpec === UPLOAD_KIND_SPECS['message-document']
      ) {
        // A DM image OR document attachment (security review M7; documents
        // get the IDENTICAL treatment — see `isMessageAttachmentParticipant`'s
        // own doc for why a document is never treated as less sensitive).
        // Unlike the uploader-only kinds below, the whole point is that the
        // RECIPIENT must load it too, so it is scoped to conversation
        // PARTICIPANTS: serve only when the requester participates in a
        // conversation holding a (non-deleted) message that references this
        // key. A caller who merely holds the URL (leaked via referrer, proxy
        // log, forwarded link) is not a participant and gets the same 404 as
        // any unresolvable key.
        //
        // The UPLOADER is admitted first, and separately. Every other kind
        // reaches the `storageKeyOwnerId(...) === user.userId` fallback below,
        // but this branch `return`s before it, so a member could not load their
        // OWN upload here — and the participant query requires a NON-deleted
        // message, so the moment the message was deleted for everyone the
        // object 404'd for its own uploader. It still appeared in Settings →
        // My uploads (which lists bucket objects, not messages), rendering as a
        // blank tile they could not identify. `MessagesService.deleteMessage`
        // now purges the object on that delete so the tile normally goes away
        // entirely; this keeps any object that outlives its message (a purge
        // that failed, or one orphaned before that fix shipped) visible and
        // therefore deletable by the one person entitled to it. It widens
        // nothing: the key embeds the uploader's own id, so this grants a
        // member access only to bytes they themselves uploaded.
        if (
          storageKeyOwnerId(storageKey) !== user.userId &&
          !(await this.isMessageAttachmentParticipant(storageKey, user.userId))
        ) {
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
    // PRD-369: a document is streamed with download-only headers instead of
    // redirected. Every authorization check above has already run unchanged.
    if (kindSpec === UPLOAD_KIND_SPECS['message-document']) {
      await this.streamMessageDocument(storageKey, response);
      return;
    }
    const downloadUrl = await this.storage.createPresignedDownload(storageKey, {
      asAttachment: download === '1',
    });
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
