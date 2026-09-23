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
  /** A sticker from an admin-published pack. The client sends only a
   *  `stickerId`; the service resolves the row and bakes the attachment, so
   *  no client ever supplies a storage key for this kind. */
  Sticker = 'sticker',
}

/**
 * The kinds of system event a `system` message can carry. `member_added` /
 * `group_renamed` are seeded here for Phase 2 (add-member / rename), which
 * reuses the same rendering path this phase builds.
 *
 * PRD-355/DES-227 (messaging scan section 8, Groups) add seven more:
 *  - `member_promoted` (actor, target): "{actor} made {target} an admin".
 *  - `member_demoted` (actor, target): "{actor} removed {target} as admin".
 *  - `owner_changed` (actor = the previous owner, target = the new owner):
 *    "{target} is now the owner", fired on both an explicit transfer and an
 *    automatic succession (the owner left/was removed and someone inherited).
 *  - `group_photo_changed` (actor): the group avatar was replaced.
 *  - `group_description_changed` (actor): the group's about text changed.
 *  - `member_joined` (actor = the joiner; `value` is `'link'` or `'invite'`):
 *    "{actor} joined", a voluntary seat via `POST join/:token` or an accepted
 *    `group_invites` row, as opposed to `member_added` (someone else put them
 *    in).
 *  - `group_dissolved` (actor = the owner, or the last leaver when nobody
 *    remains to end it): "{actor} ended this group".
 *
 * Business mailboxes (Task 16) add one for direct threads:
 *  - `moved_to_business_mailbox` (actor = the listing owner whose personal
 *    thread moved; `value` is the listing identity id): "This conversation
 *    moved to the business mailbox", naming no actor since the migration
 *    itself made the move. Written only by
 *    `1821260000000-MigrateEnquiryThreadsToListingMailboxes.ts`.
 *
 * Every event whose text mentions the ACTOR or the TARGET needs a
 * viewer-is-that-person variant ("you" instead of a name), computed
 * server-side onto `MessageResponse.systemEvent.actorIsMe`/`targetIsMe`, see
 * `buildSystemEvent`.
 */
export type SystemEventType =
  | 'group_created'
  | 'member_added'
  | 'member_removed'
  | 'member_left'
  | 'group_renamed'
  | 'member_promoted'
  | 'member_demoted'
  | 'owner_changed'
  | 'group_photo_changed'
  | 'group_description_changed'
  | 'member_joined'
  | 'group_dissolved'
  | 'moved_to_business_mailbox';

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
  /** An optional WhatsApp-style caption typed alongside the attachment in the
   *  composer and sent as ONE message. Member-supplied DISPLAY text —
   *  sanitized (trimmed, control characters and markup stripped, length-
   *  bounded) at the write boundary before it is ever persisted, exactly like
   *  `DocumentAttachment.fileName` below (see
   *  `MessagingCoreService.sanitizeAttachmentCaption`). Absent, not null, when
   *  the member left no caption. */
  caption?: string;
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
 * `<prefix>/<uploaderId>/<uuid>.<ext>`, exactly like an image). PRD-369: the
 * streamed download does name the file after it, but only through
 * `storage/document-download-headers.ts`, which strips control and bidi
 * characters, quotes and path separators, forces the key's own extension and
 * RFC 5987-encodes it, so member text cannot inject a header or a path. It IS
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
  /** Mirrors `GifAttachment.caption` — an optional WhatsApp-style caption
   *  typed alongside the document in the composer, sent as ONE message.
   *  Member-supplied DISPLAY text, sanitized the same way `fileName` above is
   *  (see `MessagingCoreService.sanitizeAttachmentCaption`). Absent, not
   *  null, when the member left no caption. */
  caption?: string;
}

/**
 * A sticker attachment on a `kind:'sticker'` message.
 *
 * This is its own interface for one reason that matters at read time:
 * `provider` is the literal `'sticker'`, which is what `isStickerAttachment`
 * discriminates on. `GifAttachment.provider` is free-form, so reusing that
 * interface would make a structural test ambiguous.
 *
 * `label` is a distinct field because it serves a different role than the
 * existing optional `caption`: a caption RENDERS underneath the media, while
 * a sticker shows nothing beneath it. The label is alt text, the reply-quote
 * line, the forward preview and the starred snippet.
 *
 * Every field is BAKED at send time from the `stickers` row. Archiving the
 * pack afterwards therefore leaves history intact, and re-rendering a sticker
 * leaves already-sent messages showing the artwork that was actually sent.
 */
export interface StickerAttachment {
  /** The sticker PNG's storage key, resolved through `toImageUrl` at read
   *  time exactly like an uploaded image's. */
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  provider: 'sticker';
  stickerId: string;
  label: string;
}

/**
 * Discriminates a sticker from the other two shapes the `attachment` jsonb
 * column can hold. Checked BEFORE `isDocumentAttachment` everywhere the
 * column is narrowed: a sticker has no `fileName`, so the order is not
 * strictly required today, but making the most specific test first keeps a
 * later shape from silently falling into the document branch.
 *
 * Requires BOTH `provider === 'sticker'` AND a `stickerId` field. `provider`
 * alone is client-forgeable: `SendMessageDto`'s `GifAttachmentDto.provider`
 * is a free-form `@IsString() @MaxLength(32)`, so an ordinary gif, image, or
 * document send could claim `provider: 'sticker'` on an ordinary photo.
 * `stickerId` is never accepted from a client for those three kinds (only a
 * `kind:'sticker'` send's separate top-level `stickerId` field is, and that
 * path never lets a client supply its own `attachment` at all, see
 * `MessagingCoreService.postMessage`'s sticker branch). It is set only when
 * this service itself bakes a `StickerAttachment` from a resolved `Sticker`
 * row. Requiring it here closes the forgery, so a photo forged with
 * `provider: 'sticker'` still reads as a photo everywhere (`buildReplyTo`,
 * moderation evidence, exports) with its real fields intact.
 */
export function isStickerAttachment(
  attachment: GifAttachment | DocumentAttachment | StickerAttachment,
): attachment is StickerAttachment {
  return (
    'provider' in attachment &&
    attachment.provider === 'sticker' &&
    'stickerId' in attachment
  );
}

/**
 * Discriminates the two upload shapes the `attachment` jsonb column can hold,
 * purely structurally (there is no stored `type` tag): a `DocumentAttachment`
 * is the only one of the three that carries `fileName`. Used wherever a
 * stored attachment must be handled differently per shape (`resolveAttachment`,
 * `MessagingCoreService.postMessage`'s write-path validation) instead of
 * trusting the message's `kind` alone, since `kind` and `attachment` are two
 * separate columns a caller could in principle mismatch. A caller narrowing a
 * three-member union checks `isStickerAttachment` first, per that function's
 * own doc.
 */
export function isDocumentAttachment(
  attachment: GifAttachment | DocumentAttachment | StickerAttachment,
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
  /** The optional caption typed alongside the attachment, present for
   *  `kind:'gif'`, `kind:'image'`, or `kind:'document'`. Unvalidated wire
   *  input — `postMessage` sanitizes it (see
   *  `MessagingCoreService.sanitizeAttachmentCaption`) before it is ever
   *  persisted, mirroring how `fileName` is handled. */
  caption?: string;
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
// Partial `(erased_sender_ref, conversation_id) WHERE erased_sender_ref IS NOT
// NULL` from `KeepCounterpartMessagesOnSenderErasure1820530000000`: backs the
// daily held-message release sweep (ENG-243) and indexes nothing on an ordinary
// row. Mirrored so `migration:generate` does not propose dropping it.
@Index(
  'IDX_messages_erased_sender_ref',
  ['erasedSenderRef', 'conversationId'],
  {
    where: '"erased_sender_ref" IS NOT NULL',
  },
)
// `(sender_id, id)` from `KeepCounterpartMessagesOnSenderErasure1820530000000`:
// backs the account erasure's keyset tombstone loop, which pages one sender's
// messages ordered by id. `IDX_messages_sender_id` alone answers the equality
// but not the ordering, so each page sorted the sender's whole history.
// Mirrored so `migration:generate` does not propose dropping it.
@Index('IDX_messages_sender_id_id', ['senderId', 'id'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_messages_conversation_id')
  @Column({ type: 'uuid' })
  conversationId!: string;

  /**
   * The author, or NULL once they have erased their account (ENG-243). The FK
   * is `ON DELETE SET NULL` as of
   * `KeepCounterpartMessagesOnSenderErasure1820530000000`, so the row survives
   * in every counterpart's thread: as a readable, sender-anonymised line while
   * an open report is tied to it, otherwise as an ordinary tombstone. Every
   * reader maps NULL to a "Former member" author (`senderAuthorSummary`).
   */
  @Index('IDX_messages_sender_id')
  @Column({ type: 'uuid', nullable: true })
  senderId!: string | null;

  /**
   * Who this message was sent AS. `senderId` above keeps recording the human
   * who typed it in every case, which is what lets a report resolve to a
   * person and lets attribution be a display decision. Null only where
   * `senderId` is null, which is an erased sender, or for a genuinely
   * personal message that was never sent as any business identity.
   *
   * Fix round 2 (Task 11): NOT a foreign key. A listing, persona or company
   * can be deleted long after it stopped answering messages, and its
   * `identities` row cascades away with it (see `IdentityMailboxSyncService`'s
   * own doc for the full cascade chain). This column deliberately survives
   * that deletion, still naming the identity this message was sent as even
   * once nothing in `identities` answers to that id, the same reasoning
   * `erasedSenderRef` below already uses for a `users` row that is gone: a
   * foreign key here would let the database null this column back out on
   * deletion, which is exactly the leak that let a stranger's whole message
   * history re-attribute itself to the staff member who happened to type it,
   * personal handle included. `toMessageResponses` renders a neutral
   * former-business placeholder whenever this id is present but no longer
   * resolves, mirroring `senderAuthorSummary`'s own former-member
   * placeholder for an erased `senderId` above. A genuinely null value here
   * (with a non-null `senderId`) still means "personal message", read
   * through the ordinary profile-author path.
   */
  @Index('IDX_messages_sender_identity_id')
  @Column({ type: 'uuid', nullable: true })
  senderIdentityId!: string | null;

  /**
   * The erased author's former user id, kept ONLY while the message is held
   * because an open or escalated report is tied to its conversation (ENG-243).
   * Not a foreign key: the `users` row it names is gone. Written by
   * `AccountDeletionProcessorService` inside the erasure transaction and
   * cleared by `ErasedSenderMessageReleaseService` once no tied report remains,
   * at which point the row is tombstoned. Never sent to a client.
   */
  // Indexed by the class-level partial `IDX_messages_erased_sender_ref`.
  @Column({ type: 'uuid', nullable: true })
  erasedSenderRef!: string | null;

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
   * The media attachment for a `kind:'gif'`, `kind:'image'`, `kind:'document'`,
   * or `kind:'sticker'` message (else NULL). `body` still carries a
   * "GIF"/"Photo"/"Document"/"Sticker" text fallback for push/notification/
   * last-message previews. `DocumentAttachment` and `StickerAttachment` are
   * exactly the "another attachment source" this column's original
   * `GifAttachment` doc comment predicted. No migration was needed to add
   * either, only a widened TypeScript union.
   */
  @Column({ type: 'jsonb', nullable: true })
  attachment!: GifAttachment | DocumentAttachment | StickerAttachment | null;

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

  /**
   * PRD-361: when this tombstone's evidence hold ends. Set on "delete for
   * everyone" (author or staff) to `now + MESSAGE_DELETE_EVIDENCE_HOLD_DAYS`,
   * while `body` and `attachment` stay server-side so the recipient can still
   * report it and a moderator can still see it. The hourly
   * `MessageEvidenceHoldSweepService` purges the bytes, blanks the body and
   * NULLs this once it has passed and no open or escalated report names the
   * message. Account erasure stamps `now()` to hand an erased member's
   * messages straight to that sweep. NULL means no hold. Never served to a
   * member: every member read path blanks a tombstone's body and attachment.
   * Partial index `IDX_messages_attachment_purge_after` (see
   * `1820510000000-AddMessageAttachmentPurgeAfter.ts`) is mirrored here so
   * `migration:generate` does not propose dropping it.
   */
  @Index('IDX_messages_attachment_purge_after', {
    where: '"attachment_purge_after" IS NOT NULL',
  })
  @Column({ type: 'timestamptz', nullable: true })
  attachmentPurgeAfter!: Date | null;
}
