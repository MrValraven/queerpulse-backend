import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { IntersectionType, PickType } from '@nestjs/mapped-types';
import { SendMessageDto } from '../../messaging/dto/send-message.dto';
import type { ChatWsErrorCode } from '../ws-error';

export class JoinPayload {
  @IsUUID('4')
  conversationId!: string;
}

/**
 * The ack `conversation:join` returns instead of throwing for either
 * EXPECTED refusal (ENG-207): a client that only read `{ joined }` and never
 * checked for a refusal left the open thread outside its room until the
 * socket happened to reconnect, receiving no `message:new`/`typing`/`read`/
 * `message:delivered` frame for it in the meantime. A malformed
 * `conversationId` is NOT one of the two cases here: the gateway's
 * `ValidationPipe` still throws before the handler runs, so that failure
 * stays a `BAD_REQUEST` exception frame with no ack at all.
 */
export type ConversationJoinAck =
  | { ok: true; joined: string }
  | { ok: false; code: 'RATE_LIMITED' | 'FORBIDDEN' };

/**
 * `conversation:leave`'s payload (ENG-217): the socket half of a room
 * subscription a client picked up via `conversation:join`. Leaving a room
 * does no DB work, so its only possible refusal is the rate limit: there is
 * no participation check to fail, and the uuid validation on
 * `conversationId` already stops a client from leaving a room it never had a
 * legitimate reason to be in (`user:<id>`, a UUID-shaped string it cannot
 * forge to match another member's id).
 */
export class LeavePayload {
  @IsUUID('4')
  conversationId!: string;
}

export type ConversationLeaveAck =
  { ok: true; left: string } | { ok: false; code: 'RATE_LIMITED' };

/** `conversationId` is added on top of `SendMessageDto` below: HTTP carries
 *  it in the URL, never the body, so `SendMessageDto` has no field for it to
 *  be picked from at all. */
class ConversationIdField {
  @IsUUID('4')
  conversationId!: string;
}

/**
 * `message:send`'s payload.
 *
 * ENG-224/ENG-48: derives its fields from `SendMessageDto`, the identical
 * body `POST /conversations/:id/messages` validates, so they share one
 * definition instead of being hand-duplicated field by field. This class
 * used to declare its own `kind` with a shorter `@IsIn` list that fell out
 * of sync when `'document'` sends were added to the HTTP DTO, so a document
 * sent over the socket was rejected where HTTP accepted the identical body.
 * `PickType` inherits each field's actual validator decorators (bounds,
 * `@IsUUID`, the attachment's `@ValidateNested`/`@Type`, the body's
 * `@TrimMessageBody`) from the one place that defines them, so the field SET
 * itself, and not only the pipe options, stays locked to that one source.
 *
 * Two `SendMessageDto` fields are deliberately excluded from the pick, a
 * conscious choice recorded here so it reads as intentional:
 * - `forwarded`: the WS path never forwards a message (`ChatGateway.
 *   handleSend` passes it through as `undefined` to `MessagingService.
 *   sendMessage`); picking it in would accept a field this transport
 *   silently ignores.
 * - `conversationId`: HTTP takes it from the URL; the body never carries it.
 *   Supplied here instead via `IntersectionType` with `ConversationIdField`
 *   above.
 *
 * `stickerId` rides the same pick list as `kind`/`attachment` so a sticker
 * sent over the socket validates identically to one sent over HTTP.
 *
 * `asIdentityId` (Task 13) rides the same pick list so the socket send path
 * can express identity exactly like HTTP: left absent, the send resolves
 * server-side to the caller's own profile identity; present, it is carried
 * through to `MessagingService.sendMessage` unchanged and passes through the
 * identical `MessagingCoreService.assertMaySendAs` guard the HTTP path
 * already runs, so no new authorization code is needed for this transport.
 */
export class SendMessagePayload extends IntersectionType(
  ConversationIdField,
  PickType(SendMessageDto, [
    'body',
    'replyToId',
    'clientMessageId',
    'kind',
    'attachment',
    'stickerId',
    'asIdentityId',
  ] as const),
) {}

export class TypingPayload {
  @IsUUID('4')
  conversationId!: string;

  @IsBoolean()
  isTyping!: boolean;
}

export class ReadPayload {
  @IsUUID('4')
  conversationId!: string;

  /** The newest message this client has actually rendered. The server reads
   *  that row's own `created_at` and stamps the watermark there, so a message
   *  that arrived between the last fetch and this frame is not silently marked
   *  read. Omitted, the watermark stays `now()` (the original behaviour). */
  @IsOptional()
  @IsUUID('4')
  upToMessageId?: string;
}

export class DeliveredPayload {
  @IsUUID('4')
  conversationId!: string;
}

/**
 * `session:reauth`'s payload (ENG-219): presented while the socket is still
 * open so `ChatGateway.handleReauth` can reschedule the same connection's
 * expiry timer instead of the client dropping and reconnecting at every
 * access-token rotation. Carries exactly ONE of two mutually usable proofs:
 *
 * - `token`: a freshly-minted access token. `@IsString`/`@IsNotEmpty` only:
 *   this is deliberately NOT `@IsJWT()`, which validates SHAPE (three
 *   dot-separated base64url segments) but nothing about signature or
 *   claims. Shape validation would only let a malformed token fail one step
 *   earlier for no real benefit: `ChatGateway.handleReauth` verifies it with
 *   the exact same `JwtService.verifyAsync` call the handshake uses, which
 *   already rejects a malformed token (and every other invalid one) by
 *   construction. `@MaxLength` bounds the payload size a hostile client
 *   could throw at the verifier before that check even runs; 4096 is
 *   generous headroom over this app's actual HS256 access tokens (a few
 *   hundred characters) without being tight enough to reject a legitimate
 *   one. Usable by a non-browser client that holds its own access token
 *   outside an `httpOnly` cookie; the browser SPA never sends this field.
 * - `ticket`: a single-use ticket minted by `POST /auth/socket-ticket`
 *   (`SocketTicketService.mint`) over an authenticated HTTP call. This is
 *   what the browser SPA actually sends, since `access_token` is `httpOnly`
 *   (`auth-cookies.ts`) and never reaches JavaScript to be put in this frame
 *   directly. `@MaxLength(128)` is generous headroom over the actual minted
 *   shape (an `st_` prefix plus 64 hex characters, around 67 chars total).
 *
 * Neither field is `@IsNotEmpty`-required at the class level (both are
 * `@IsOptional`), since exactly one is expected and both together would be
 * redundant. A payload carrying neither is a client bug
 * `ChatGateway.handleReauth` refuses as `BAD_REQUEST` without dropping the
 * socket, distinct from every other refusal here, which DOES drop it, since
 * those represent a rejected credential rather than a malformed request.
 */
export class ReauthPayload {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  ticket?: string;
}

/**
 * `session:reauth`'s ack. `ok: true` carries the new `exp` (whether it came
 * from a verified `token` or a redeemed `ticket`) so the caller can
 * reschedule its own next proactive reauth off the value the SERVER just
 * granted, rather than trusting whatever it locally believed the old
 * credential's `exp` to be. `ok: false` carries whichever
 * {@link ChatWsErrorCode} the rejection matched: `RATE_LIMITED` and
 * `BAD_REQUEST` (a payload carrying neither `token` nor `ticket`) refuse
 * without dropping the socket; every other code here is followed by the
 * gateway's existing drop, so the caller should treat any other refusal as
 * "this socket is already gone".
 */
export type ReauthAck =
  { ok: true; exp: number } | { ok: false; code: ChatWsErrorCode };
