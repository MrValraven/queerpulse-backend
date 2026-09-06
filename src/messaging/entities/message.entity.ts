import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A `user` message is an ordinary member-authored bubble; a `system` message is
 * a centred pill the timeline renders itself ("You created the group", "Cy
 * left") — its meaning lives in `systemEvent`, not free text. Defaults to `user`
 * so every pre-group message is unchanged.
 */
export enum MessageKind {
  User = 'user',
  System = 'system',
  Gif = 'gif',
  /** A member-uploaded image attachment (MSG-8), presigned through
   *  `POST /uploads/presign` (`kind: 'message-image'`) the same way every
   *  other image upload in the app is — never a bespoke messaging-only path. */
  Image = 'image',
  /** A member-uploaded document attachment (PRD-226): a PDF, a spreadsheet, or
   *  plain text — never a video/audio/voice format, which is out of scope.
   *  Presigned through the same `POST /uploads/presign` (`kind:
   *  'message-document'`), mirroring how `Image` reuses the app's ordinary
   *  upload path rather than inventing a messaging-only one. */
  Document = 'document',
}

/** The kinds of system event a `system` message can carry. `member_added` /
 *  `group_renamed` are seeded here for Phase 2 (add-member / rename), which
 *  reuses the same rendering path this phase builds. */
export type SystemEventType =
  | 'group_created'
  | 'member_added'
  | 'member_removed'
  | 'member_left'
  | 'group_renamed';

/**
 * Structured payload of a `system` message. Actor/target are user ids; the DTO
 * layer resolves them to display names at read time (never stored denormalised,
 * so a later rename is reflected). `value` carries a scalar the event needs
 * (e.g. the new title for `group_renamed`).
 */
export interface SystemEvent {
  type: SystemEventType;
  actorId: string;
  targetId?: string;
  value?: string;
}

/**
 * A media attachment on a `kind:'gif'` OR `kind:'image'` message. `url` is the
 * full asset rendered in the bubble; `previewUrl` is a lightweight thumbnail
 * (for an uploaded image, the same value as `url` — no separate thumbnail is
 * generated). Intrinsic `width`/`height` are set as <img> attrs client-side so
 * the bubble reserves space (no layout shift). NULL for every message without
 * an attachment.
 *
 * `url`/`previewUrl` hold two different KINDS of value depending on `provider`:
 * a `kind:'gif'` message's is an absolute `https://` URL from the GIF provider
 * (passed through `toImageUrl` unchanged); a `kind:'image'` message's is a
 * private storage KEY minted by `POST /uploads/presign` (`message-image`),
 * resolved through `toImageUrl` → `GET /files/<key>` at every read path —
 * mirrors how every other image field in this app stores a key, never a URL.
 * Named `GifAttachment` for history (it predates image uploads); not renamed
 * to avoid a wider, purely-cosmetic diff across the DTO/response layers.
 */
export interface GifAttachment {
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  /** Which service the media came from (e.g. "klipy" for a picked GIF,
   *  "upload" for a member-uploaded image). Free-form so swapping the GIF
   *  provider — or adding another attachment source later — never requires a
   *  schema/type change. */
  provider: string;
}

/**
 * A document attachment on a `kind:'document'` message (PRD-226: a lease PDF,
 * a flyer, a spreadsheet, plain text). This is exactly the "adding another
 * attachment source later" case `GifAttachment`'s own doc comment anticipated
 * — it shares the SAME `attachment` jsonb column, no migration needed — but it
 * is its own interface rather than a widened `GifAttachment` because a
 * document carries no pixel dimensions to reserve a box for; `fileName`/
 * `byteSize`/`contentType` are what the bubble states instead (name, format,
 * size — the house requirement for a document bubble).
 *
 * `fileName` is the ORIGINAL, member-supplied file name — DISPLAY ONLY. It is
 * never used to derive the storage key (that's a server-minted
 * `<prefix>/<uploaderId>/<uuid>.<ext>`, exactly like an image) and never baked
 * into a served `Content-Disposition` header (see `served-object.ts`'s
 * `inlineContentDispositionForStorageKey` doc) — so it can carry arbitrary
 * member text without becoming a header- or path-injection vector. It IS
 * still sanitized before persisting (see
 * `MessagingCoreService`'s `sanitizeDisplayFileName`) purely to keep a
 * pathological value (embedded newlines, control characters, absurd length)
 * out of the bubble's rendered text.
 *
 * `url` is always a private `message-document` storage key, resolved through
 * `toImageUrl` -> `GET /files/<key>` at read time exactly like an uploaded
 * image's `url` (see `resolveAttachment`) — the `toImageUrl` naming predates
 * documents and stays unrenamed for the same reason `GifAttachment` did.
 */
export interface DocumentAttachment {
  url: string;
  fileName: string;
  byteSize: number;
  contentType: string;
  /** Mirrors `GifAttachment.provider` — always `"upload"` today, kept
   *  free-form for the same forward-compatibility reason. */
  provider: string;
}

/**
 * Discriminates the two shapes the `attachment` jsonb column can hold, purely
 * structurally (there is no stored `type` tag): a `DocumentAttachment` is the
 * only one of the two that carries `fileName`. Used wherever a stored
 * attachment must be handled differently per shape (`resolveAttachment`,
 * `MessagingCoreService.postMessage`'s write-path validation) instead of
 * trusting the message's `kind` alone, since `kind` and `attachment` are two
 * separate columns a caller could in principle mismatch.
 */
export function isDocumentAttachment(
  attachment: GifAttachment | DocumentAttachment,
): attachment is DocumentAttachment {
  return 'fileName' in attachment;
}

/**
 * The loosely-typed WIRE shape of an attachment on a `POST .../messages` send
 * (`MessagingCoreService.postMessage`'s `attachment` parameter), before it has
 * been validated against the specific fields the sender's `kind` requires and
 * narrowed to a strict `GifAttachment`/`DocumentAttachment` to persist. Every
 * field beyond `url`/`provider` is optional here because ONE DTO class
 * (`send-message.dto.ts`'s `GifAttachmentDto`) carries the union of every
 * attachment kind's fields — see that class's own doc for why it isn't three
 * separate DTOs. `postMessage` is what turns this into an honest,
 * fully-populated `GifAttachment` or `DocumentAttachment` before it ever
 * reaches `messages.create(...)`.
 */
export interface AttachmentInput {
  url: string;
  provider: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  fileName?: string;
  byteSize?: number;
  contentType?: string;
}

@Entity('messages')
// Composite (conversation_id, created_at DESC) — backs the newest-N-per-
// conversation reads (`lastMessagesByConversation`'s DISTINCT ON, and the
// keyset-paginated thread history) without falling back to the single-column
// `IDX_messages_conversation_id` index + an in-memory sort. Mirrors
// `1782692700000-AddPerformanceIndexes.ts`'s
// `IDX_messages_conversation_id_created_at`; TypeORM can't express the
// `DESC` direction on `createdAt` alone here (column order matches, direction
// is a migration-only detail), so this decorator exists purely to keep
// `migration:generate` from proposing a `DROP INDEX` for it.
@Index('IDX_messages_conversation_id_created_at', [
  'conversationId',
  'createdAt',
])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_messages_conversation_id')
  @Column({ type: 'uuid' })
  conversationId!: string;

  @Index('IDX_messages_sender_id')
  @Column({ type: 'uuid' })
  senderId!: string;

  @Column({ type: 'text' })
  body!: string;

  /**
   * `user` (an ordinary bubble) or `system` (a rendered event pill). Defaults to
   * `user`, so every message written before group chat is a normal bubble.
   */
  @Column({
    type: 'enum',
    enum: MessageKind,
    enumName: 'messages_kind_enum',
    default: MessageKind.User,
  })
  kind!: MessageKind;

  /**
   * Structured event for a `system` message (else NULL). The client renders this
   * as a centred pill; `body` is kept as a plain-text fallback (used by push /
   * notification listeners that don't understand the event).
   */
  @Column({ type: 'jsonb', nullable: true })
  systemEvent!: SystemEvent | null;

  /**
   * The media attachment for a `kind:'gif'`, `kind:'image'`, or
   * `kind:'document'` message (else NULL). `body` still carries a
   * "GIF"/"Photo"/"Document" text fallback for push/notification/last-message
   * previews. `DocumentAttachment` is exactly the "another attachment source"
   * this column's original `GifAttachment` doc comment predicted — no
   * migration was needed to add it, only a widened TypeScript union.
   */
  @Column({ type: 'jsonb', nullable: true })
  attachment!: GifAttachment | DocumentAttachment | null;

  @Index('IDX_messages_reply_to_id')
  @Column({ type: 'uuid', nullable: true })
  replyToId!: string | null;

  /**
   * Client-generated idempotency key (`crypto.randomUUID()` on the sender). A
   * partial unique index on `(conversation_id, client_message_id)` makes the
   * dual HTTP + WS write paths and any offline-outbox retry insert at most one
   * row. Null for server-originated messages (message requests, enquiries) and
   * legacy rows created before this column existed.
   */
  // Partial UNIQUE(conversation_id, client_message_id) WHERE client_message_id
  // IS NOT NULL — see `1785000700000-AddMessageClientId.ts`. Mirrored here
  // (rather than left implicit) so `migration:generate` doesn't propose
  // dropping it; NULL client ids (legacy rows, server-originated messages)
  // are exempt from the uniqueness constraint by the `where` predicate.
  @Index(
    'UQ_messages_conversation_client_id',
    ['conversationId', 'clientMessageId'],
    {
      unique: true,
      where: '"client_message_id" IS NOT NULL',
    },
  )
  @Column({ type: 'uuid', nullable: true })
  clientMessageId!: string | null;

  /**
   * True when this message was created by FORWARDING another message's content
   * into this conversation. A forward goes through the ordinary idempotent send
   * path and lands as a normal message; this flag only lets the recipient's
   * bubble render a subtle "Forwarded" label. Reactions/receipts are never
   * copied — only the body.
   */
  @Column({ type: 'boolean', default: false })
  forwarded!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;
}
