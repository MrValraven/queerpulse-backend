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

/** The reported message's body as it stood when the report was filed. */
export interface MessageSnapshotEvidence {
  type: 'message-snapshot';
  messageId: string;
  body: string;
  senderId: string;
  createdAt: string;
  editedAt: string | null;
  deletedAtTimeOfReport: boolean;
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

export type ReportEvidenceEntry =
  | UrlEvidence
  | ScreenshotEvidence
  | MessageSnapshotEvidence
  | HousingSnapshotEvidence
  | PhotoSnapshotEvidence;

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
