/**
 * The `reports.evidence` jsonb array, given names.
 *
 * The column is typed `unknown[]` on the entity and every writer so far pushed
 * an object literal into it inline. Three shapes now live in there and one of
 * them is read back by a route that has to authorize against it, so the shapes
 * are declared here once rather than being re-derived by each reader.
 *
 * Two families:
 *
 *  - CLIENT evidence (`url`, `screenshot`) is whatever the reporter attached.
 *    Stored verbatim and trusted for nothing.
 *  - SERVER SNAPSHOTS (`message-snapshot`, `housing-snapshot`,
 *    `photo-snapshot`) are captured by `ReportsService.buildEvidence` at filing
 *    time from the row itself. They exist because the reported thing can be
 *    edited or deleted between the report and the review, and a moderator
 *    reading the live row would then be judging something other than what was
 *    reported.
 *
 * Every entry carries its own `type` discriminant, and a reader that does not
 * recognise a `type` must treat the entry as opaque rather than dropping it.
 */

import type {
  DocumentAttachment,
  GifAttachment,
  StickerAttachment,
} from '../messaging/entities/message.entity';
import {
  messageAttachmentFacts,
  primaryMessageAttachmentStorageKey,
} from '../messaging/message-evidence-hold';

/** A link the reporter pasted into the report form. */
export interface UrlEvidence {
  type: 'url';
  value?: string;
  uploadId?: string;
}

/** An image the reporter uploaded through the report form. */
export interface ScreenshotEvidence {
  type: 'screenshot';
  value?: string;
  uploadId?: string;
}

export const MESSAGE_SNAPSHOT_TYPE = 'message-snapshot';

/**
 * PRD-361: the reported message's attachment, BY REFERENCE, as it stood when the
 * report was filed. Never a URL of any kind (a `/files/` URL refuses staff for a
 * tombstone, and a presigned one expires): the bytes are reached through
 * `GET /mod/report-message-attachment/:reportId`, which resolves the key from
 * the report itself. A deleted message's bytes are held for
 * `MESSAGE_DELETE_EVIDENCE_HOLD_DAYS`, and for as long as an open or escalated
 * report names the message, so this reference stays servable for the review.
 */
export interface MessageSnapshotAttachment {
  /** Bare platform key of an uploaded image or document; null for a GIF picked
   *  from the external provider. */
  storageKey: string | null;
  /** A document's original, member-supplied name; null for an image or GIF. */
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  provider: string | null;
  caption: string | null;
}

/** The reported message's body as it stood when the report was filed. */
export interface MessageSnapshotEvidence {
  type: typeof MESSAGE_SNAPSHOT_TYPE;
  messageId: string;
  body: string;
  /** Null once the author has erased their account. */
  senderId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAtTimeOfReport: boolean;
  // PRD-360 / PRD-361. Optional because snapshots filed before these fields
  // existed do not carry them, and readers must accept both.
  conversationId?: string;
  replyToId?: string | null;
  kind?: string;
  attachment?: MessageSnapshotAttachment | null;
  /** When this snapshot was taken, i.e. when the report was filed. */
  capturedAt?: string;
}

/**
 * The snapshot shape of a stored message attachment. `storageKey` is null for
 * a sticker (see `primaryMessageAttachmentStorageKey`'s own doc: its key is
 * never a `message-image`/`message-document` platform key, so there is
 * nothing here for the report evidence byte-serving route to point at); its
 * `label` still survives into the snapshot through `fileName`, via
 * `messageAttachmentFacts`.
 */
export function messageSnapshotAttachmentFrom(
  attachment: GifAttachment | DocumentAttachment | StickerAttachment | null,
): MessageSnapshotAttachment | null {
  if (!attachment) return null;
  const facts = messageAttachmentFacts(attachment);
  return {
    storageKey: primaryMessageAttachmentStorageKey(attachment),
    fileName: facts?.fileName ?? null,
    mimeType: facts?.mimeType ?? null,
    sizeBytes: facts?.sizeBytes ?? null,
    provider:
      typeof attachment.provider === 'string' ? attachment.provider : null,
    // `StickerAttachment` declares no `caption` field at all (a sticker send
    // carries only a `stickerId`). `GifAttachment`/`DocumentAttachment` both
    // declare it optional. The `in` check confirms the property's presence
    // before reading it, safely handling the three-shape union.
    caption:
      'caption' in attachment && typeof attachment.caption === 'string'
        ? attachment.caption
        : null,
  };
}

/**
 * The `message-snapshot` entry out of a report's raw `evidence`, or null.
 * Validates the one field every caller keys on (`messageId`) rather than
 * casting, for the same reason `photoSnapshotFrom` does.
 */
export function messageSnapshotFrom(
  evidence: unknown[] | null | undefined,
): MessageSnapshotEvidence | null {
  if (!evidence) return null;
  for (const entry of evidence) {
    if (!isRecord(entry)) continue;
    if (entry.type !== MESSAGE_SNAPSHOT_TYPE) continue;
    if (typeof entry.messageId !== 'string' || !entry.messageId) continue;
    return entry as unknown as MessageSnapshotEvidence;
  }
  return null;
}

/** The reported home's key fields as they stood when the report was filed. */
export interface HousingSnapshotEvidence {
  type: 'housing-snapshot';
  ref: string;
  slug: string;
  title: string;
  blurb: string | null;
  rentEuros: number | null;
  city: string | null;
  area: string | null;
  listerId: string | null;
  listedAt: string;
  snapshotAt: string;
}

export const PHOTO_SNAPSHOT_TYPE = 'photo-snapshot';

/**
 * ONE gathering photo, as it stood when the report was filed.
 *
 * ## Why this entry exists at all
 *
 * An `event_photo` report is the one subject whose entire content is an image.
 * The drawer's resolver names the gathering, the caption and the uploader, and
 * `ModReportDetail.thread` is empty for every subject, so without this a
 * moderator asked "is this photo outing someone" inside a one-hour SLA is
 * reading prose about a picture they cannot see.
 *
 * ## By reference, deliberately: no second copy of the photograph is kept
 *
 * `storageKey` points at the ONE stored object the album itself renders. The
 * platform does NOT copy those bytes anywhere durable when a report is filed,
 * and that is a decision rather than an omission. Written down so it can be
 * argued with:
 *
 *  - `EventPhotosService.remove` deletes the stored object as well as the row,
 *    so a report's evidence really can outlive the image. A durable copy would
 *    close that window.
 *  - It would close it by keeping a photograph of an identifiable person at a
 *    queer event AFTER it was taken down, in a second location, indefinitely.
 *    The person most likely to be in that photograph is the reporter, and the
 *    outcome they filed the report to get is the image gone. A retained
 *    moderation copy hands them the opposite of what they asked for, and it
 *    would sit outside every erasure path that knows about `event_photos`
 *    (`ContentOwnerErasureService`, `AccountDeletionProcessorService`, the
 *    `ON DELETE SET NULL` uploader FK), so an Art. 17 request would silently
 *    miss it.
 *  - What actually bounds the window is the SLA, not a copy. `outing` and
 *    `doxxing` are the whole Emergency band and they are answered in an hour.
 *
 * So this entry is authoritative about the FACTS of the photo (which one, in
 * which gathering, uploaded by whom, captioned what, when) and by-reference
 * about its pixels. A moderator who opens a report after the image is gone gets
 * an honest "no longer available" plus every one of those facts, and the
 * disappearance is itself a fact about the case: an uploader deleting a
 * photograph minutes after it was reported is not the same as nothing having
 * happened, and the report stays fully actionable either way.
 *
 * If this call is overruled, the durable copy belongs behind its own storage
 * prefix, its own `/files` refusal, a retention window that expires it when the
 * report closes, and a hook in both erasure services. Half of that is worse
 * than none of it.
 *
 * ## Reachability
 *
 * The entry itself leaves the server only on `GET /mod/reports/:id`, which is
 * `@Roles(Moderator, Admin)` — the same gate `message-snapshot` and
 * `housing-snapshot` already sit behind. The BYTES are reached through
 * `GET /mod/report-photo-evidence/:reportId`
 * (`ReportPhotoEvidenceController`), which is staff-gated and resolves the key
 * from this entry rather than accepting one from the caller. Nobody's view of
 * this photograph widens: `GET /files/gathering-photos/...` still serves the
 * uploader alone.
 */
export interface PhotoSnapshotEvidence {
  type: typeof PHOTO_SNAPSHOT_TYPE;
  /** The `event_photos` row id — the report's own `subjectId`. */
  photoId: string;
  /** The gathering the photo was posted to. A photo in a trans support group's
   *  album is not the same report as the same photo in a street party's. */
  eventId: string;
  /** The stored object. Never a `/files/<key>` URL: that route refuses staff
   *  for this kind, so spelling it here would promise a link that 404s. */
  storageKey: string;
  /** The uploader's words, which travel with the image and can be the whole
   *  complaint on their own (a caption can out somebody a photo does not). */
  caption: string | null;
  /** Null once the uploader has erased their account (`ON DELETE SET NULL`). */
  uploaderId: string | null;
  uploadedAt: string;
  snapshotAt: string;
}

/**
 * PRD-356: a reported GROUP conversation's key facts as they stood when the
 * report was filed. Captured because a group's title, description and roster
 * can all change (or the group can dissolve) between the filing and the
 * review, and a moderator reading the live conversation would then be judging
 * something other than what was actually reported.
 *
 * Discriminated on `kind` rather than `type` (every other entry above uses
 * `type`) because this snapshot is about a `conversations.kind = 'group'`
 * row, and naming its own discriminant `kind` keeps that fact visible at the
 * call site instead of colliding in spirit with the column it is a snapshot
 * of. A reader iterating this union checks `'kind' in entry` before
 * `'type' in entry`, the same way `photoSnapshotFrom` below checks `type`.
 */
export interface GroupSnapshotEvidence {
  kind: 'group';
  title: string | null;
  /** PRD-358's `conversations.description` column. Null for a group that has
   *  never set one. */
  description: string | null;
  /** The current owner, or null for a group whose owner has left with nobody
   *  promoted in their place. */
  ownerId: string | null;
  /** Every ACTIVE (not-left) participant, counted in full even when
   *  {@link memberIds} below is truncated. */
  memberCount: number;
  /** Active participant ids, capped at 256 (mirrors the `MAX_GROUP_MEMBERS`
   *  cap in `messaging.constants.ts`) so a very large roster can never make
   *  one evidence row unbounded. */
  memberIds: string[];
  capturedAt: string;
}

/**
 * A reported business-mailbox identity (`ReportSubjectType.Identity`) as it
 * stood when its customer filed the report, captured for the reason the group
 * snapshot above is: the business can rename itself, change its staff or be
 * deleted between the filing and the review.
 *
 * Discriminated on `kind`, like `GroupSnapshotEvidence`.
 *
 * `staffUserIds` is moderator evidence only (spec 9: the moderator view shows
 * the identity and the humans behind it whatever either attribution switch
 * says). The reporter never reads it back: `toReportDTO`, the only shape
 * `POST /reports` and `GET /reports/mine` return, carries no evidence at all.
 */
export interface MailboxIdentitySnapshotEvidence {
  kind: 'mailbox_identity';
  identityId: string;
  identityKind: 'listing' | 'subprofile' | 'company';
  /** The listing, subprofile or company id the identity belongs to. */
  ownerEntityId: string;
  /** The business's own display name; null when it could not be described. */
  displayName: string | null;
  /** The reporter's direct thread with the identity. */
  conversationId: string;
  /** Everyone staffing the mailbox, owner first, capped like
   *  `GroupSnapshotEvidence.memberIds`. */
  staffUserIds: string[];
  capturedAt: string;
}

export type ReportEvidenceEntry =
  | UrlEvidence
  | ScreenshotEvidence
  | MessageSnapshotEvidence
  | HousingSnapshotEvidence
  | PhotoSnapshotEvidence
  | GroupSnapshotEvidence
  | MailboxIdentitySnapshotEvidence;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The `photo-snapshot` entry out of a report's raw `evidence`, or null.
 *
 * The column is `jsonb` written by earlier deploys, so nothing guarantees its
 * shape: this validates the two fields a caller acts on (`storageKey` and
 * `photoId`) rather than casting. A row from before this entry existed, a row
 * for another subject type, and a malformed row all answer null, and the caller
 * turns that into the same "no image" outcome.
 */
export function photoSnapshotFrom(
  evidence: unknown[] | null | undefined,
): PhotoSnapshotEvidence | null {
  if (!evidence) return null;
  for (const entry of evidence) {
    if (!isRecord(entry)) continue;
    if (entry.type !== PHOTO_SNAPSHOT_TYPE) continue;
    if (typeof entry.storageKey !== 'string' || !entry.storageKey) continue;
    if (typeof entry.photoId !== 'string' || !entry.photoId) continue;
    return entry as unknown as PhotoSnapshotEvidence;
  }
  return null;
}
