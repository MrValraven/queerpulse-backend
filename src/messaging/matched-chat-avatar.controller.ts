import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Res,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { isAllowedExternalImage } from '../common/validators/is-image-reference.decorator';
import { contentTypeForStorageKey } from '../storage/served-object';
import { StorageService } from '../storage/storage.service';
import { MatchedChatMemberKeyPipe } from './matched-chat-member-key.pipe';
import { MatchedChatMembersService } from './matched-chat-members.service';
import { MATCHED_CHAT_AVATAR_ROUTE } from './matched-member-key';

/** The most bytes the route relays for one avatar, the avatar upload cap. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** How long a provider avatar fetch may take before the route gives up. */
const PROVIDER_FETCH_TIMEOUT_MS = 5_000;

/** The image types a provider avatar may be relayed as. */
const RELAYABLE_AVATAR_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** One viewer may reuse the bytes briefly; the URL changes with the photo. */
const AVATAR_CACHE_CONTROL = 'private, max-age=300';

/**
 * PRD-423 (opaque member keys): the avatar of a matched Go together chat's
 * member, addressed by conversation and per-chat member key
 * (`matchedChatAvatarUrl`). A storage key names the uploader's user id and a
 * provider URL identifies the account behind it, so the chat hands out
 * this address alone and the route streams the bytes itself: no redirect,
 * so no `Location` header ever carries either value. Seat-checked
 * through `MatchedChatMembersService.resolveAvatar`; every refusal is the
 * same 404. `VERSION_NEUTRAL` because the address is minted server-side from
 * the API origin (`apiUrlFor`), as `GET /files/*` is.
 */
@ApiTags('Messaging')
@ApiCookieAuth()
@Controller({ path: MATCHED_CHAT_AVATAR_ROUTE, version: VERSION_NEUTRAL })
@UseGuards(ActiveMemberGuard)
export class MatchedChatAvatarController {
  private readonly logger = new Logger(MatchedChatAvatarController.name);

  constructor(
    private readonly matchedChatMembers: MatchedChatMembersService,
    private readonly storage: StorageService,
  ) {}

  @Get(':conversationId/:memberKey')
  @ApiOperation({
    summary: 'Stream a matched Go together chat member avatar by member key',
  })
  @ApiResponse({ status: 200, description: 'The avatar image bytes.' })
  @ApiUnauthorizedResponse({ description: 'No valid session.' })
  @ApiNotFoundResponse({
    description:
      'The caller holds no seat in a matched chat, or the member or their visible photo is missing.',
  })
  async avatar(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('memberKey', MatchedChatMemberKeyPipe) memberKey: string,
    @CurrentUser() user: CurrentUserData,
    @Res() response: Response,
  ): Promise<void> {
    const source = await this.matchedChatMembers.resolveAvatar(
      conversationId,
      user.userId,
      memberKey,
    );
    const { body, contentType } =
      'storageKey' in source
        ? await this.openStoredAvatar(source.storageKey)
        : await this.openProviderAvatar(source.externalUrl);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', AVATAR_CACHE_CONTROL);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.status(200);
    try {
      await pipeline(body, byteCap(MAX_AVATAR_BYTES), response);
    } catch (error) {
      const isClientAbort =
        (error as { code?: unknown } | null)?.code ===
        'ERR_STREAM_PREMATURE_CLOSE';
      if (!isClientAbort) {
        this.logger.warn(`Matched chat avatar stream failed: ${String(error)}`);
      }
    }
  }

  /** A stored avatar, refused when its bytes do not match its type. */
  private async openStoredAvatar(
    storageKey: string,
  ): Promise<{ body: Readable; contentType: string }> {
    const contentType = contentTypeForStorageKey(storageKey);
    if (!contentType?.startsWith('image/')) {
      throw new NotFoundException();
    }
    if (
      (await this.storage.validateImageMagicBytes(storageKey)) === 'mismatch'
    ) {
      throw new NotFoundException();
    }
    try {
      return {
        body: await this.storage.openObjectStream(storageKey),
        contentType,
      };
    } catch {
      throw new NotFoundException();
    }
  }

  /**
   * A provider avatar (an https URL from sign-in), fetched on the member's
   * behalf and relayed only as an image of a known type. The stored URL is
   * re-checked against the image host allow-list every write path applies
   * (`isAllowedExternalImage`, https only), and a redirect is refused, so the
   * relay can only ever reach a host we already serve images from.
   */
  private async openProviderAvatar(
    externalUrl: string,
  ): Promise<{ body: Readable; contentType: string }> {
    if (!isAllowedExternalImage(externalUrl)) {
      throw new NotFoundException();
    }
    let providerResponse: globalThis.Response;
    try {
      providerResponse = await fetch(externalUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new NotFoundException();
    }
    const contentType = (providerResponse.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const declaredLength = Number(
      providerResponse.headers.get('content-length') ?? '0',
    );
    if (
      !providerResponse.ok ||
      !providerResponse.body ||
      !RELAYABLE_AVATAR_TYPES.has(contentType) ||
      declaredLength > MAX_AVATAR_BYTES
    ) {
      throw new NotFoundException();
    }
    return {
      body: Readable.from(webStreamChunks(providerResponse.body)),
      contentType,
    };
  }
}

/**
 * The chunks of a fetch body, read with its own reader so the relay needs
 * no cast between the DOM and Node web-stream types. A relay that stops
 * early (a client abort, the byte cap) cancels the provider stream.
 */
async function* webStreamChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let isDone = false;
  try {
    while (!isDone) {
      const { done, value } = await reader.read();
      isDone = done;
      if (value) yield value;
    }
  } finally {
    if (!isDone) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Fails the stream once more than `maxBytes` have passed, so a provider
 *  that lies about its length cannot make the route relay without bound. */
function byteCap(maxBytes: number): Transform {
  let relayedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      relayedBytes += chunk.length;
      if (relayedBytes > maxBytes) {
        callback(new Error('Avatar exceeds the relay cap'));
        return;
      }
      callback(null, chunk);
    },
  });
}
